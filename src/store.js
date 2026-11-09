import fs from "node:fs";
import path from "node:path";

export class JsonTaskStore {
	constructor(file) {
		this.file = file;
	}

	async list() {
		return this.#read();
	}

	async get(taskId) {
		return (await this.#read()).find((task) => task.id === taskId);
	}

	async create(task) {
		const tasks = await this.#read();
		tasks.push(task);
		await this.#write(tasks);
		return task;
	}

	async update(taskId, task) {
		const tasks = await this.#read();
		const index = tasks.findIndex((item) => item.id === taskId);
		if (index < 0) return undefined;
		tasks[index] = task;
		await this.#write(tasks);
		return task;
	}

	async delete(taskId) {
		const tasks = await this.#read();
		const next = tasks.filter((task) => task.id !== taskId);
		if (next.length === tasks.length) return false;
		await this.#write(next);
		return true;
	}

	async #read() {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
			return Array.isArray(parsed) ? parsed : [];
		} catch (error) {
			if (error?.code === "ENOENT") return [];
			throw error;
		}
	}

	async #write(tasks) {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(tasks, null, 2)}\n`);
		fs.renameSync(tmp, this.file);
	}
}
