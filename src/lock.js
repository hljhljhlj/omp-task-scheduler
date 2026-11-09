import fs from "node:fs";
import path from "node:path";

export class FileSchedulerLock {
	constructor(file) {
		this.path = file;
		this.acquired = false;
	}

	acquire() {
		try {
			fs.mkdirSync(path.dirname(this.path), { recursive: true });
			fs.writeFileSync(this.path, String(process.pid), { flag: "wx" });
			this.acquired = true;
			return true;
		} catch (error) {
			if (error?.code !== "EEXIST") return false;
			try {
				const holder = Number(fs.readFileSync(this.path, "utf8").trim());
				if (!alive(holder)) {
					fs.rmSync(this.path, { force: true });
					fs.writeFileSync(this.path, String(process.pid), { flag: "wx" });
					this.acquired = true;
					return true;
				}
			} catch {
				return false;
			}
			return false;
		}
	}

	release() {
		if (!this.acquired) return;
		try {
			if (Number(fs.readFileSync(this.path, "utf8").trim()) === process.pid) fs.rmSync(this.path, { force: true });
		} catch {
			// Lock already gone.
		}
		this.acquired = false;
	}

	isAcquired() {
		return this.acquired;
	}

	holderPid() {
		try {
			return Number(fs.readFileSync(this.path, "utf8").trim());
		} catch {
			return undefined;
		}
	}
}

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
