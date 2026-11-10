import { randomUUID } from "node:crypto";
import { computeNextRunAt, resolveSchedule } from "./schedule.js";

const HISTORY_LIMIT = 20;
const POLL_MS = 15_000;
// setTimeout delays above 2^31-1 ms are clamped to 1 ms by Node and Bun.
const MAX_TIMER_MS = 2_000_000_000;

const defaultTimers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle),
	setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
	clearInterval: (handle) => globalThis.clearInterval(handle),
};

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

export class TaskScheduler {
	constructor({ store, lock, runner, sessionId, now = () => new Date(), pollMs = POLL_MS, timers = defaultTimers, onActivity }) {
		this.store = store;
		this.lock = lock;
		this.runner = runner;
		this.sessionId = sessionId;
		this.now = now;
		this.pollMs = pollMs;
		this.timersApi = timers;
		this.onActivity = onActivity;
		this.timers = new Map();
		this.running = new Set();
		this.active = false;
		this.stopped = false;
		this.needsCatchUp = false;
		this.generation = 0;
		this.poll = null;
		this.lastError = undefined;
	}

	isActive() {
		return this.active;
	}

	isStarted() {
		return this.poll !== null;
	}

	async list() {
		return (await this.store.list()).filter((task) => task.sessionId === this.sessionId);
	}

	async get(taskId) {
		const task = await this.store.get(taskId);
		if (!task || task.sessionId !== this.sessionId) return undefined;
		return task;
	}

	async create({ name, prompt, schedule, enabled = true }) {
		const resolved = resolveSchedule(schedule, this.now());
		const stamp = this.now().toISOString();
		const task = {
			id: randomUUID(),
			sessionId: this.sessionId,
			name: name?.trim() || undefined,
			prompt: String(prompt),
			enabled: Boolean(enabled),
			...resolved,
			createdAt: stamp,
			updatedAt: stamp,
			runCount: 0,
			runHistory: [],
		};
		task.nextRunAt = computeNextRunAt(task, this.now());
		await this.store.create(task);
		this.#arm(task);
		return task;
	}

	async update(taskId, patch) {
		const current = await this.get(taskId);
		if (!current) return undefined;
		const next = { ...current, updatedAt: this.now().toISOString() };
		if (patch.name !== undefined) next.name = patch.name?.trim() || undefined;
		if (patch.prompt !== undefined) next.prompt = String(patch.prompt);
		if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
		if (patch.schedule !== undefined) Object.assign(next, resolveSchedule(patch.schedule, this.now()));
		if (next.enabled && next.type === "once" && !futureOnce(next, this.now())) {
			throw new Error("Cannot enable a one-shot whose time has passed; set a future schedule.");
		}
		next.nextRunAt = computeNextRunAt(next, this.now());
		await this.store.update(taskId, next);
		this.#arm(next);
		return next;
	}

	async delete(taskId) {
		const current = await this.get(taskId);
		if (!current) return false;
		this.#clear(taskId);
		return this.store.delete(taskId);
	}

	async runNow(taskId) {
		const task = await this.get(taskId);
		if (!task) return undefined;
		await this.#execute(task, true);
		return this.get(taskId);
	}

	async start() {
		if (this.poll) return;
		this.stopped = false;
		this.poll = this.timersApi.setInterval(() => {
			void this.#tick().catch((error) => {
				this.lastError = errorText(error);
			});
		}, this.pollMs);
		this.poll?.unref?.();
		await this.#tick();
	}

	async stop() {
		this.stopped = true;
		this.generation += 1;
		this.active = false;
		if (this.poll) this.timersApi.clearInterval(this.poll);
		this.poll = null;
		for (const taskId of [...this.timers.keys()]) this.#clear(taskId);
		this.lock.release();
	}

	async #tick() {
		if (this.stopped) return;
		const generation = this.generation;
		try {
			if (this.active && this.lock.owns && !this.lock.owns()) {
				this.lock.abandon?.();
				this.active = false;
			}
			if (!this.active) {
				if (!this.lock.acquire()) return;
				if (this.stopped || this.generation !== generation) {
					this.lock.release();
					return;
				}
				this.active = true;
				this.needsCatchUp = true;
			}
			await this.#resync();
		} catch (error) {
			this.lastError = errorText(error);
		} finally {
			if (!this.stopped) this.#emit();
		}
	}

	async #resync() {
		if (!this.active) return;
		const generation = this.generation;
		let tasks;
		try {
			tasks = await this.list();
		} catch (error) {
			this.lastError = errorText(error);
			return;
		}
		if (!this.active || this.generation !== generation) return;
		if (this.needsCatchUp) {
			for (const task of tasks) {
				if (!this.active || this.generation !== generation) return;
				await this.#catchUp(task);
			}
			if (!this.active || this.generation !== generation) return;
			this.needsCatchUp = false;
		}
		const live = new Set(tasks.map((task) => task.id));
		for (const taskId of this.timers.keys()) {
			if (!live.has(taskId)) this.#clear(taskId);
		}
		for (const task of tasks) this.#arm(task);
		this.lastError = undefined;
	}

	// Runs only after this process becomes the lock holder. A due slot from
	// while we were off is skipped; a slot that comes due while we are active
	// is delivered by #arm instead.
	async #catchUp(task) {
		if (!task.enabled) return;
		const due = task.nextRunAt ? new Date(task.nextRunAt).getTime() : Number.NaN;
		const past = !Number.isFinite(due) || due <= this.now().getTime();
		if (!past) return;
		if (task.type !== "once" && !task.nextRunAt) return;
		task.updatedAt = this.now().toISOString();
		const next = computeNextRunAt(task, this.now());
		if (next === undefined && task.type === "once") {
			task.enabled = false;
			task.nextRunAt = undefined;
			if (!task.lastStatus) {
				task.lastStatus = "missed";
				task.lastError = "missed while the scheduler was off";
			}
			await this.store.update(task.id, task);
			return;
		}
		if (next === undefined) return;
		task.nextRunAt = next;
		await this.store.update(task.id, task);
	}

	#arm(task) {
		if (!this.active || task.sessionId !== this.sessionId) return;
		if (!task.enabled || !task.nextRunAt) {
			this.#clear(task.id);
			return;
		}
		const dueAt = new Date(task.nextRunAt).getTime();
		const delay = dueAt - this.now().getTime();
		if (!Number.isFinite(delay)) {
			this.#clear(task.id);
			return;
		}
		if (delay <= 0) {
			// Clearing a pending timer here used to drop the run. Deliver it.
			this.#clear(task.id);
			void this.#execute(task, false).catch((error) => {
				this.lastError = errorText(error);
			});
			return;
		}
		const capped = delay > MAX_TIMER_MS;
		const existing = this.timers.get(task.id);
		if (existing && existing.dueAt === dueAt && existing.capped === capped) return;
		this.#clear(task.id);
		const handle = this.timersApi.setTimeout(() => {
			void this.#onTimer(task.id, dueAt).catch((error) => {
				this.lastError = errorText(error);
			});
		}, capped ? MAX_TIMER_MS : delay);
		handle?.unref?.();
		this.timers.set(task.id, { handle, dueAt, capped });
	}

	async #onTimer(taskId, dueAt) {
		const existing = this.timers.get(taskId);
		if (!existing || existing.dueAt !== dueAt) return;
		this.timers.delete(taskId);
		if (!this.active) return;
		const generation = this.generation;
		const task = await this.get(taskId);
		if (!this.active || this.generation !== generation || !task?.enabled || !task.nextRunAt) return;
		const remaining = new Date(task.nextRunAt).getTime() - this.now().getTime();
		if (new Date(task.nextRunAt).getTime() !== dueAt || remaining > 0) {
			this.#arm(task);
			return;
		}
		await this.#execute(task, false);
	}

	#clear(taskId) {
		const entry = this.timers.get(taskId);
		if (entry) this.timersApi.clearTimeout(entry.handle);
		this.timers.delete(taskId);
	}

	async #execute(task, manual) {
		if (!task?.id || this.running.has(task.id)) return;
		this.running.add(task.id);
		const generation = this.generation;
		try {
			const fresh = await this.get(task.id);
			if (generation !== this.generation) return;
			if (!fresh || fresh.sessionId !== this.sessionId) return;
			if (!manual && this.lock.owns && !this.lock.owns()) {
				this.lock.abandon?.();
				this.active = false;
				return;
			}
			if (!manual && (!fresh.enabled || !this.active)) return;
			const started = this.now().toISOString();
			try {
				await this.runner(fresh);
			} catch (error) {
				if (generation !== this.generation) return;
				await this.#finish(fresh.id, "error", started, errorText(error), generation);
				return;
			}
			await this.#finish(fresh.id, "success", started, undefined, generation);
		} finally {
			this.running.delete(task.id);
		}
	}

	async #finish(taskId, status, started, error, generation) {
		const task = await this.get(taskId);
		if (!task) return;
		task.lastRunAt = started;
		task.lastStatus = status;
		task.lastError = error;
		task.runCount = (task.runCount ?? 0) + (status === "success" ? 1 : 0);
		task.updatedAt = this.now().toISOString();
		task.runHistory = [...(task.runHistory ?? []), { status, at: started, error }].slice(-HISTORY_LIMIT);
		if (task.type === "once" && (status === "success" || status === "error")) task.enabled = false;
		task.nextRunAt = computeNextRunAt(task, this.now());
		await this.store.update(taskId, task);
		if (this.active && this.generation === generation) this.#arm(task);
	}

	#emit() {
		try {
			this.onActivity?.();
		} catch {
			// Status updates are best-effort.
		}
	}
}

function futureOnce(task, now) {
	const at = new Date(task.schedule).getTime();
	return Number.isFinite(at) && at > now.getTime();
}
