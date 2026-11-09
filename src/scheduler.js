import { randomUUID } from "node:crypto";
import { computeNextRunAt, resolveSchedule } from "./schedule.js";

const HISTORY_LIMIT = 20;
const POLL_MS = 15_000;

export class TaskScheduler {
	constructor({ store, lock, runner, sessionId, now = () => new Date() }) {
		this.store = store;
		this.lock = lock;
		this.runner = runner;
		this.sessionId = sessionId;
		this.now = now;
		this.timers = new Map();
		this.running = new Set();
		this.active = false;
		this.poll = null;
	}

	isActive() {
		return this.active;
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
		if (this.active) return;
		if (!this.lock.acquire()) return;
		this.active = true;
		await this.#resync();
		this.poll = setInterval(() => {
			void this.#resync();
		}, POLL_MS);
		this.poll.unref?.();
	}

	async stop() {
		this.active = false;
		if (this.poll) clearInterval(this.poll);
		this.poll = null;
		for (const taskId of this.timers.keys()) this.#clear(taskId);
		this.lock.release();
	}

	async #resync() {
		if (!this.active) return;
		const tasks = await this.list();
		const live = new Set(tasks.map((task) => task.id));
		for (const taskId of this.timers.keys()) {
			if (!live.has(taskId)) this.#clear(taskId);
		}
		for (const task of tasks) {
			await this.#catchUp(task);
			this.#arm(task);
		}
	}

	async #catchUp(task) {
		if (!task.enabled || !task.nextRunAt) return;
		if (new Date(task.nextRunAt).getTime() > this.now().getTime()) return;
		task.nextRunAt = computeNextRunAt(task, this.now());
		task.updatedAt = this.now().toISOString();
		await this.store.update(task.id, task);
	}

	#arm(task) {
		if (!this.active || task.sessionId !== this.sessionId) return;
		this.#clear(task.id);
		if (!task.enabled || !task.nextRunAt) return;
		const delay = new Date(task.nextRunAt).getTime() - this.now().getTime();
		if (!Number.isFinite(delay) || delay < 0) return;
		const timer = setTimeout(() => {
			void this.#execute(task, false);
		}, delay);
		timer.unref?.();
		this.timers.set(task.id, timer);
	}

	#clear(taskId) {
		const timer = this.timers.get(taskId);
		if (timer) clearTimeout(timer);
		this.timers.delete(taskId);
	}

	async #execute(task, manual) {
		if (this.running.has(task.id)) return;
		const fresh = await this.get(task.id);
		if (!fresh || (!manual && !fresh.enabled)) return;
		if (fresh.sessionId !== this.sessionId) throw new Error("Scheduled task belongs to a different session.");
		this.running.add(fresh.id);
		const started = this.now().toISOString();
		try {
			await this.runner(fresh);
			await this.#finish(fresh.id, "success", started);
		} catch (error) {
			await this.#finish(fresh.id, "error", started, error instanceof Error ? error.message : String(error));
		} finally {
			this.running.delete(fresh.id);
		}
	}

	async #finish(taskId, status, started, error) {
		const task = await this.get(taskId);
		if (!task) return;
		task.lastRunAt = started;
		task.lastStatus = status;
		task.lastError = error;
		task.runCount = (task.runCount ?? 0) + (status === "success" ? 1 : 0);
		task.updatedAt = this.now().toISOString();
		task.runHistory = [...(task.runHistory ?? []), { status, at: started, error }].slice(-HISTORY_LIMIT);
		if (task.type === "once" && status === "success") task.enabled = false;
		task.nextRunAt = computeNextRunAt(task, this.now());
		await this.store.update(taskId, task);
		this.#arm(task);
	}
}
