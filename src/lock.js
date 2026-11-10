import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The claim directory already contains this instance's token, and rename is the
// only step that publishes it. A stale entry is moved aside only when its
// content is still the dead one we observed; a live token is moved back.
export class FileSchedulerLock {
	constructor(file) {
		this.path = file;
		this.token = `${process.pid}:${processStartTime(process.pid) ?? 0}:${randomUUID()}`;
		this.acquired = false;
	}

	acquire() {
		if (this.acquired && this.owns()) return true;
		this.acquired = false;
		let staging;
		try {
			fs.mkdirSync(path.dirname(this.path), { recursive: true });
			for (let attempt = 0; attempt < 16; attempt++) {
				if (!staging) staging = this.#stage();
				const result = this.#claim(staging);
				if (result === "acquired") {
					this.acquired = true;
					staging = undefined;
					return true;
				}
				if (result === "restage") staging = undefined;
				if (result === "busy" || result === "error") return false;
			}
			if (this.#readContent() === this.token) {
				this.acquired = true;
				staging = undefined;
				return true;
			}
			return false;
		} catch {
			return false;
		} finally {
			if (staging) fs.rmSync(staging, { recursive: true, force: true });
		}
	}

	release() {
		if (!this.acquired) return;
		try {
			if (this.#readContent() === this.token) fs.rmSync(this.path, { recursive: true, force: true });
		} catch {
			// Already gone.
		}
		this.acquired = false;
	}

	abandon() {
		this.acquired = false;
	}

	owns() {
		return this.acquired && this.#readContent() === this.token;
	}

	isAcquired() {
		return this.acquired;
	}

	holderPid() {
		return pidOf(this.#readContent());
	}

	#stage() {
		const staging = `${this.path}.claim-${process.pid}-${randomUUID()}`;
		fs.mkdirSync(staging);
		fs.writeFileSync(path.join(staging, "pid"), `${this.token}\n`, { flag: "wx" });
		return staging;
	}

	#claim(staging) {
		try {
			fs.renameSync(staging, this.path);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(error?.code)) return "error";
			const content = this.#readContent();
			if (content === this.token) return "acquired";
			if (content === undefined) return "retry";
			if (alive(content)) return "busy";
			this.#displace(content);
			return "retry";
		}
		return this.#readContent() === this.token ? "acquired" : "restage";
	}

	// Move the lock aside. Delete it only when the moved content is still the
	// dead snapshot we decided to replace. A live token is renamed back.
	#displace(expected) {
		const grave = `${this.path}.stale-${process.pid}-${randomUUID()}`;
		try {
			fs.renameSync(this.path, grave);
		} catch {
			return;
		}
		const content = readContentAt(grave);
		if (content === expected && !alive(content)) {
			fs.rmSync(grave, { recursive: true, force: true });
			return;
		}
		if (alive(content)) {
			try {
				fs.renameSync(grave, this.path);
			} catch {
				// The path was claimed while the live token sat in the grave.
			}
			return;
		}
		fs.rmSync(grave, { recursive: true, force: true });
	}

	#readContent() {
		return readContentAt(this.path);
	}
}

function readContentAt(target) {
	try {
		const stat = fs.lstatSync(target);
		if (stat.isSymbolicLink()) return undefined;
		const file = stat.isDirectory() ? path.join(target, "pid") : target;
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		return undefined;
	}
}

function pidOf(content) {
	if (!content) return undefined;
	const pid = Number(String(content).split(":")[0]);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function startOf(content) {
	const parts = String(content ?? "").split(":");
	if (parts.length < 3) return undefined;
	const start = Number(parts[1]);
	return Number.isInteger(start) && start >= 0 ? start : undefined;
}

// A live pid alone is not proof that the lock holder is still the same process:
// after a reboot the pid can be recycled by an unrelated program. Tokens written
// by this version carry the holder's start time and are only treated as live
// when both match. Tokens from older versions carry no start time and fall back
// to the pid check.
function alive(content) {
	const pid = pidOf(content);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		if (error?.code !== "EPERM") return false;
	}
	const recorded = startOf(content);
	if (recorded === undefined) return true;
	const current = processStartTime(pid);
	return current === undefined || current === recorded;
}

function processStartTime(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const fields = stat.slice(close + 2).trim().split(/\s+/);
		const start = Number(fields[19]);
		return Number.isInteger(start) && start > 0 ? start : undefined;
	} catch {
		return undefined;
	}
}
