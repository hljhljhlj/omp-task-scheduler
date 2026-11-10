import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FileSchedulerLock } from "./lock.js";
import { TaskScheduler } from "./scheduler.js";
import { JsonTaskStore } from "./store.js";

function dataDir() {
	return process.env.OMP_SCHEDULER_DIR || path.join(os.homedir(), ".omp", "scheduler");
}

function sessionFile(sessionId, suffix) {
	const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
	return path.join(dataDir(), `${suffix}-${key}`);
}

function summarize(task) {
	const summary = {
		id: task.id,
		name: task.name ?? "",
		schedule: task.schedule,
		type: task.type,
		enabled: task.enabled,
		nextRunAt: task.nextRunAt ?? null,
		lastRunAt: task.lastRunAt ?? null,
		lastStatus: task.lastStatus ?? null,
		runCount: task.runCount ?? 0,
	};
	if (task.enabled && !task.nextRunAt) {
		summary.warning = "No upcoming run found within one year; check the cron expression.";
	}
	return summary;
}

export default function taskSchedulerExtension(pi) {
	let scheduler = null;
	let starting = Promise.resolve();

	const requireScheduler = () => {
		if (!scheduler) throw new Error("Scheduler is not active in this session.");
		return scheduler;
	};

	let lastUiState;

	const refreshStatus = async (ctx) => {
		if (!scheduler) return;
		const state = !scheduler.isActive() ? "standby" : scheduler.lastError ? "error" : "active";
		if (state !== lastUiState) {
			if (state === "standby") {
				ctx?.ui?.notify?.("任务调度待命：另一个进程持有本会话的调度锁，15 秒内自动重试", "warning");
			} else if (state === "error") {
				ctx?.ui?.notify?.(`任务调度出错：${scheduler.lastError}`, "error");
			}
			lastUiState = state;
		}
		if (state === "standby") {
			ctx?.ui?.setStatus?.("scheduler", "scheduler: standby");
			return;
		}
		if (state === "error") {
			ctx?.ui?.setStatus?.("scheduler", "scheduler: error");
			return;
		}
		const tasks = await scheduler.list();
		const enabled = tasks.filter((task) => task.enabled).length;
		ctx?.ui?.setStatus?.("scheduler", `scheduler: ${enabled}`);
	};

	const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value });

	pi.registerTool({
		name: "scheduler_create",
		label: "Schedule task",
		description: "Create a scheduled prompt in this conversation only. schedule accepts 30s, 10m, 6h, 1d, +5m, an ISO timestamp, or a 5-field cron expression.",
		parameters: pi.zod.object({
			prompt: pi.zod.string(),
			schedule: pi.zod.string(),
			name: pi.zod.string().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await requireScheduler().create(params);
			await refreshStatus(ctx);
			return text(summarize(task));
		},
	});

	pi.registerTool({
		name: "scheduler_list",
		label: "List scheduled tasks",
		description: "List scheduled prompts that belong to this conversation.",
		parameters: pi.zod.object({}),
		async execute() {
			const tasks = await requireScheduler().list();
			return text({ tasks: tasks.map(summarize), total: tasks.length });
		},
	});

	pi.registerTool({
		name: "scheduler_get",
		label: "Get scheduled task",
		description: "Read one scheduled task from this conversation, including its prompt.",
		parameters: pi.zod.object({ taskId: pi.zod.string() }),
		async execute(_toolCallId, params) {
			const task = await requireScheduler().get(params.taskId);
			if (!task) return text({ error: "Task not found in this conversation." });
			return text(task);
		},
	});

	pi.registerTool({
		name: "scheduler_update",
		label: "Update scheduled task",
		description: "Change the prompt, schedule, name, or enabled flag of a task in this conversation. Re-enabling a one-shot requires a schedule that is still in the future.",
		parameters: pi.zod.object({
			taskId: pi.zod.string(),
			prompt: pi.zod.string().optional(),
			schedule: pi.zod.string().optional(),
			name: pi.zod.string().optional(),
			enabled: pi.zod.boolean().optional(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { taskId, ...patch } = params;
			const task = await requireScheduler().update(taskId, patch);
			await refreshStatus(ctx);
			if (!task) return text({ error: "Task not found in this conversation." });
			return text(summarize(task));
		},
	});

	pi.registerTool({
		name: "scheduler_delete",
		label: "Delete scheduled task",
		description: "Delete a scheduled task from this conversation.",
		parameters: pi.zod.object({ taskId: pi.zod.string() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const deleted = await requireScheduler().delete(params.taskId);
			await refreshStatus(ctx);
			return text({ taskId: params.taskId, deleted });
		},
	});

	pi.registerTool({
		name: "scheduler_run_now",
		label: "Run scheduled task",
		description: "Deliver one scheduled prompt from this conversation immediately.",
		parameters: pi.zod.object({ taskId: pi.zod.string() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let task;
			try {
				task = await requireScheduler().runNow(params.taskId);
			} catch (error) {
				await refreshStatus(ctx);
				return text({ error: error instanceof Error ? error.message : String(error) });
			}
			await refreshStatus(ctx);
			if (!task) return text({ error: "Task not found in this conversation." });
			return text(summarize(task));
		},
	});

	const bind = async (ctx, { notify = false } = {}) => {
		if (ctx.agent?.kind && ctx.agent.kind !== "main") return;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (!sessionId) {
			if (notify) ctx.ui?.notify?.("任务调度未启动：这个会话没有 session id", "error");
			return;
		}
		if (scheduler?.sessionId === sessionId && scheduler.isStarted()) return;
		if (scheduler) await scheduler.stop();
		const next = new TaskScheduler({
			store: new JsonTaskStore(`${sessionFile(sessionId, "tasks")}.json`),
			lock: new FileSchedulerLock(sessionFile(sessionId, "scheduler.lock")),
			sessionId,
			onActivity: () => {
				void refreshStatus(ctx).catch(() => {});
			},
			runner: async (task) => {
				if (ctx.sessionManager.getSessionId() !== task.sessionId) {
					throw new Error("Scheduled task belongs to a different session.");
				}
				pi.sendMessage(task.prompt, { deliverAs: "nextTurn", triggerTurn: true });
			},
		});
		scheduler = next;
		lastUiState = undefined;
		await next.start();
		await refreshStatus(ctx);
	};

	const enqueueBind = (ctx, options) => {
		starting = starting.then(() => bind(ctx, options), () => bind(ctx, options));
		return starting;
	};

	pi.on("session_start", (_event, ctx) => enqueueBind(ctx, { notify: true }));
	pi.on("session_switch", (_event, ctx) => enqueueBind(ctx));
	pi.on("session_branch", (_event, ctx) => enqueueBind(ctx));
	pi.on("session_fork", (_event, ctx) => enqueueBind(ctx));
	pi.on("session_shutdown", () => {
		starting = starting.then(() => scheduler?.stop(), () => scheduler?.stop());
		return starting;
	});

	pi.registerCommand("scheduler-list", {
		description: "List scheduled tasks for this conversation",
		handler: async (_args, ctx) => {
			const tasks = await requireScheduler().list();
			const lines = tasks.map((task) => `${task.enabled ? "on " : "off"} ${task.id} ${task.schedule} ${task.name ?? ""}`.trim());
			ctx.ui.notify(lines.join("\n") || "这个对话没有定时任务", "info");
		},
	});

	pi.registerCommand("scheduler-run-now", {
		description: "Run a scheduled task now. Usage: /scheduler-run-now <taskId>",
		handler: async (args, ctx) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("用法：/scheduler-run-now <taskId>", "error");
				return;
			}
			try {
				const task = await requireScheduler().runNow(taskId);
				ctx.ui.notify(task ? `已投递 ${task.id}` : "这个对话里没有这个任务", task ? "info" : "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
