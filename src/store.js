import fs from "node:fs";
import path from "node:path";
import { FileSchedulerLock } from "./lock.js";

const LOCK_WAIT_MS = 5_000;

export class JsonTaskStore {
	constructor(file) {
		this.file = file;
		this.#lock = new FileSchedulerLock(`${file}.lock`);
		this.#tail = Promise.resolve();
	}

	#lock;
	#tail;

	list() {
		return this.#enqueue(() => this.#read());
	}

	get(taskId) {
		return this.#enqueue(() => this.#read().find((task) => task.id === taskId));
	}

	create(task) {
		return this.#enqueue(() => {
			const tasks = this.#read();
			tasks.push(task);
			this.#write(tasks);
			return task;
		});
	}

	update(taskId, task) {
		return this.#enqueue(() => {
			const tasks = this.#read();
			const index = tasks.findIndex((item) => item.id === taskId);
			if (index < 0) return undefined;
			tasks[index] = task;
			this.#write(tasks);
			return task;
		});
	}

	delete(taskId) {
		return this.#enqueue(() => {
			const tasks = this.#read();
			const next = tasks.filter((task) => task.id !== taskId);
			if (next.length === tasks.length) return false;
			this.#write(next);
			return true;
		});
	}

	// Chain mutations so two creates in this process cannot read the same snapshot.
	// The file lock covers the same critical section across processes.
	#enqueue(work) {
		const run = this.#tail.then(() => this.#withLock(work), () => this.#withLock(work));
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#withLock(work) {
		const pause = new Int32Array(new SharedArrayBuffer(4));
		const deadline = Date.now() + LOCK_WAIT_MS;
		while (!this.#lock.acquire()) {
			if (Date.now() >= deadline) throw new Error("Timed out locking the task file.");
			Atomics.wait(pause, 0, 0, 5);
		}
		try {
			return work();
		} finally {
			this.#lock.release();
		}
	}

	#read() {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
			return Array.isArray(parsed) ? parsed : [];
		} catch (error) {
			if (error?.code === "ENOENT") return [];
			throw error;
		}
	}

	#write(tasks) {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(tasks, null, 2)}\n`);
		fs.renameSync(tmp, this.file);
	}
}
