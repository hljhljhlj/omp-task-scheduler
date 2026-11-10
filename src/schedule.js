const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };
export const MIN_INTERVAL_SECONDS = 30;

export function resolveSchedule(schedule, now = new Date()) {
	const raw = String(schedule ?? "").trim();
	const interval = raw.match(/^(\d+)(s|m|h|d)$/);
	if (interval) {
		const seconds = Number(interval[1]) * UNIT_SECONDS[interval[2]];
		if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid interval: ${raw}`);
		if (seconds < MIN_INTERVAL_SECONDS) {
			throw new Error(`Interval must be at least ${MIN_INTERVAL_SECONDS}s: ${raw}`);
		}
		return { type: "interval", schedule: raw, intervalSeconds: seconds };
	}
	const relative = raw.match(/^\+(\d+)(s|m|h|d)$/);
	if (relative) {
		const seconds = Number(relative[1]) * UNIT_SECONDS[relative[2]];
		if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid interval: ${raw}`);
		const at = new Date(now.getTime() + seconds * 1000);
		if (Number.isNaN(at.getTime())) throw new Error(`Invalid interval: ${raw}`);
		return { type: "once", schedule: at.toISOString(), intervalSeconds: 0 };
	}
	if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
		const at = new Date(raw);
		if (Number.isNaN(at.getTime())) throw new Error(`Invalid timestamp: ${raw}`);
		if (at.getTime() <= now.getTime()) throw new Error(`Timestamp is in the past: ${raw}`);
		return { type: "once", schedule: at.toISOString(), intervalSeconds: 0 };
	}
	const fields = raw.split(/\s+/);
	if (fields.length === 6) {
		throw new Error(`Six-field cron is not supported (no seconds field): ${raw}`);
	}
	if (fields.length === 5) {
		parseCron(raw);
		return { type: "cron", schedule: raw, intervalSeconds: 60 };
	}
	throw new Error(`Unrecognized schedule "${raw}". Use 30s, 10m, 6h, 1d, +5m, an ISO timestamp, or a 5-field cron.`);
}

export function computeNextRunAt(task, now = new Date()) {
	if (!task.enabled) return undefined;
	if (task.type === "once") {
		const at = new Date(task.schedule);
		if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return undefined;
		return at.toISOString();
	}
	if (task.type === "interval") {
		const step = task.intervalSeconds * 1000;
		let next = task.lastRunAt ? new Date(task.lastRunAt).getTime() + step : now.getTime() + step;
		while (next <= now.getTime()) next += step;
		return new Date(next).toISOString();
	}
	if (task.type === "cron") return nextCron(task.schedule, now)?.toISOString();
	return undefined;
}

function parseCron(expression) {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`Cron needs 5 fields: ${expression}`);
	const ranges = [
		[0, 59],
		[0, 23],
		[1, 31],
		[1, 12],
		[0, 6],
	];
	return fields.map((field, index) => parseField(field, ranges[index][0], ranges[index][1]));
}

function parseField(field, min, max) {
	const allowed = new Set();
	for (const part of field.split(",")) {
		const [range, stepRaw] = part.split("/");
		const step = stepRaw === undefined ? 1 : Number(stepRaw);
		if (!Number.isInteger(step) || step <= 0) throw new Error(`Bad cron step: ${field}`);
		let start = min;
		let end = max;
		if (range !== "*") {
			const bounds = range.split("-");
			if (bounds.length === 1) {
				start = Number(bounds[0]);
				end = stepRaw === undefined ? start : max;
			} else if (bounds.length === 2) {
				start = Number(bounds[0]);
				end = Number(bounds[1]);
			} else {
				throw new Error(`Bad cron field: ${field}`);
			}
		}
		if (![start, end].every((value) => Number.isInteger(value) && value >= min && value <= max) || start > end) {
			throw new Error(`Cron field out of range: ${field}`);
		}
		for (let value = start; value <= end; value += step) allowed.add(value);
	}
	return allowed;
}

function nextCron(expression, now) {
	const fields = parseCron(expression);
	const cursor = new Date(now.getTime());
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	const limit = cursor.getTime() + 366 * 24 * 3600 * 1000;
	while (cursor.getTime() <= limit) {
		const month = cursor.getMonth() + 1;
		const dow = cursor.getDay();
		const domRestricted = expression.trim().split(/\s+/)[2] !== "*";
		const dowRestricted = expression.trim().split(/\s+/)[4] !== "*";
		const domMatch = fields[2].has(cursor.getDate());
		const dowMatch = fields[4].has(dow);
		const dayOk = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
		if (fields[1].has(cursor.getHours()) && fields[3].has(month) && dayOk && fields[0].has(cursor.getMinutes())) {
			return cursor;
		}
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	return undefined;
}
