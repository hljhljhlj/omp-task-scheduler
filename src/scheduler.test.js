import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSchedulerLock } from "./lock.js";
import { computeNextRunAt, resolveSchedule } from "./schedule.js";
import { TaskScheduler } from "./scheduler.js";
import { JsonTaskStore } from "./store.js";

test("parses interval, once, and cron", () => {
	assert.equal(resolveSchedule("6h").intervalSeconds, 21600);
	const once = resolveSchedule("+5m", new Date("2026-11-09T00:00:00Z"));
	assert.equal(once.type, "once");
	assert.equal(once.schedule, "2026-11-09T00:05:00.000Z");
	assert.equal(resolveSchedule("0 9 * * 1").type, "cron");
	assert.throws(() => resolveSchedule("nope"));
	assert.throws(() => resolveSchedule("1s"), /at least 30s/);
	assert.throws(() => resolveSchedule("2020-01-01T00:00:00Z"), /in the past/);
});

test("cron next run skips the current minute", () => {
	const now = new Date(2026, 10, 9, 4, 15, 20); // local time, cron evaluates in local time
	const next = computeNextRunAt({ type: "cron", schedule: "15 4 * * *", enabled: true }, now);
	assert.equal(next, new Date(2026, 10, 10, 4, 15, 0).toISOString());
});

test("tasks stay inside the session that created them", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
	const store = new JsonTaskStore(path.join(dir, "tasks.json"));
	const lock = new FileSchedulerLock(path.join(dir, "lock"));
	const delivered = [];
	let clock = new Date("2026-11-09T00:00:00Z");
	const scheduler = new TaskScheduler({
		store,
		lock,
		sessionId: "session-A",
		now: () => clock,
		runner: async (task) => {
			if (task.sessionId !== "session-A") throw new Error("wrong session");
			delivered.push(task.prompt);
		},
	});
	await scheduler.start();
	const task = await scheduler.create({ name: "patrol", prompt: "check sources", schedule: "1m" });
	assert.equal(task.sessionId, "session-A");
	assert.equal(task.nextRunAt, "2026-11-09T00:01:00.000Z");
	await scheduler.stop();

	const other = new TaskScheduler({
		store,
		lock,
		sessionId: "session-B",
		now: () => clock,
		runner: async () => delivered.push("leaked"),
	});
	await other.start();
	assert.deepEqual(await other.list(), []);
	assert.equal(await other.get(task.id), undefined);
	assert.equal(await other.delete(task.id), false);
	await other.stop();
	assert.equal(delivered.length, 0);
	assert.equal((await store.list()).length, 1);
});

test("a due interval fires once and schedules the following run", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
	const store = new JsonTaskStore(path.join(dir, "tasks.json"));
	const lock = new FileSchedulerLock(path.join(dir, "lock"));
	let clock = new Date("2026-11-09T00:00:00.000Z");
	const delivered = [];
	const scheduler = new TaskScheduler({
		store,
		lock,
		sessionId: "session-A",
		now: () => clock,
		runner: async (task) => delivered.push(task.prompt),
	});
	await scheduler.start();
	const created = await scheduler.create({ prompt: "ping", schedule: "30s" });
	clock = new Date(created.nextRunAt);
	await scheduler.runNow(created.id);
	const after = await scheduler.get(created.id);
	assert.deepEqual(delivered, ["ping"]);
	assert.equal(after.runCount, 1);
	assert.equal(after.nextRunAt, "2026-11-09T00:01:00.000Z");
	await scheduler.stop();
	assert.equal(lock.isAcquired(), false);
});

test("missed runs are skipped and the next future time is armed", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
	const store = new JsonTaskStore(path.join(dir, "tasks.json"));
	const lock = new FileSchedulerLock(path.join(dir, "lock"));
	let clock = new Date("2026-11-09T00:00:00.000Z");
	const delivered = [];
	const first = new TaskScheduler({
		store,
		lock,
		sessionId: "session-A",
		now: () => clock,
		runner: async (task) => delivered.push(task.prompt),
	});
	await first.start();
	const created = await first.create({ prompt: "ping", schedule: "1m" });
	await first.stop();

	clock = new Date("2026-11-09T05:00:00.000Z"); // several runs missed during downtime
	const second = new TaskScheduler({
		store,
		lock,
		sessionId: "session-A",
		now: () => clock,
		runner: async (task) => delivered.push(task.prompt),
	});
	await second.start();
	const after = await second.get(created.id);
	assert.equal(after.nextRunAt, "2026-11-09T05:01:00.000Z");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(delivered.length, 0); // nothing replayed from the gap
	await second.stop();
});

test("a once task missed while offline is disabled, not left silently enabled", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
	const store = new JsonTaskStore(path.join(dir, "tasks.json"));
	const lock = new FileSchedulerLock(path.join(dir, "lock"));
	let clock = new Date("2026-11-09T00:00:00.000Z");
	const delivered = [];
	const first = new TaskScheduler({
		store,
		lock,
		sessionId: "session-A",
		now: () => clock,
		runner: async (task) => delivered.push(task.prompt),
	});
	await first.start();
	const created = await first.create({ prompt: "once-ping", schedule: "+10m" });
	await first.stop();

	clock = new Date(new Date(created.nextRunAt).getTime() + 60_000);
	const second = new TaskScheduler({
		store,
		lock,
		sessionId: "session-A",
		now: () => clock,
		runner: async (task) => delivered.push(task.prompt),
	});
	await second.start();
	await new Promise((resolve) => setTimeout(resolve, 50));
	const task = await second.get(created.id);
	assert.equal(task.enabled, false);
	assert.equal(task.lastStatus, "missed");
	assert.equal(delivered.length, 0);
	await second.stop();
});
