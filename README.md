# omp-task-scheduler

Session-scoped scheduled prompts for omp. A task runs only in the conversation that created it — other conversations cannot see it, list it, or fire it. When a task is due, its prompt is delivered into that conversation as the next turn, as if you had typed it yourself.

## Features

- **Session-scoped** — tasks live with the conversation that created them; no cross-talk between sessions
- **Four schedule forms** — interval, relative one-shot, absolute one-shot, and five-field cron
- **Six tools + two slash commands** — full create / read / update / delete / run-now lifecycle
- **Zero dependencies** — plain Node.js built-ins, atomic JSON writes, single-process file lock
- **Missed runs are not replayed** — after downtime the next future slot is armed instead

## Requirements

- omp with extension/plugin support (`pi.registerTool`, `pi.on`, `pi.registerCommand`)
- Node.js 18+

## Install

Install straight from this repository:

```bash
omp plugin install https://github.com/hljhljhlj/omp-task-scheduler
```

Or clone and link it (better if you want to hack on it):

```bash
git clone https://github.com/hljhljhlj/omp-task-scheduler.git
omp plugin link --scope user ./omp-task-scheduler
```

`--scope user` loads the plugin in all projects; `--scope project` loads it only in the project you run the command from. Then restart the conversation. Verify with `omp plugin list`.

No `npm install` needed — the plugin has no dependencies.

Uninstall:

```bash
omp plugin uninstall omp-task-scheduler
```

## Quick start

Just ask in any conversation:

> 每 30 分钟检查一次构建状态，有问题就汇报

The assistant calls `scheduler_create` with your prompt and schedule, and from then on the prompt arrives in that conversation on schedule. Use `/scheduler-list` to see what is armed, `/scheduler-run-now <taskId>` to fire one immediately.

## Schedules

| Form | Examples | Meaning |
| --- | --- | --- |
| Interval | `30s`, `10m`, `6h`, `1d` | Repeats forever every N seconds/minutes/hours/days |
| Relative one-shot | `+5m`, `+2h` | Fires once, N after creation |
| Absolute one-shot | `2026-11-10T09:00:00` | Fires once at that timestamp (local time; append `Z` for UTC) |
| Cron | `15 4 * * 1` | Five-field cron: minute hour day-of-month month day-of-week, **local time** |

Cron fields support `*`, lists (`1,15`), ranges (`0-30`), and steps (`*/10`). When both day-of-month and day-of-week are restricted, either match fires (standard cron behavior). `nextRunAt` is always computed strictly after the current minute, so a task never fires twice for one slot.

## Tools

| Tool | Parameters | Description |
| --- | --- | --- |
| `scheduler_create` | `prompt`, `schedule`, `name?` | Create a task in this conversation |
| `scheduler_list` | — | List this conversation's tasks with next/last run and status |
| `scheduler_get` | `taskId` | Read one task, including its full prompt |
| `scheduler_update` | `taskId`, `prompt?`, `schedule?`, `name?`, `enabled?` | Patch a task |
| `scheduler_delete` | `taskId` | Delete a task |
| `scheduler_run_now` | `taskId` | Deliver one run immediately |

Slash commands: `/scheduler-list`, `/scheduler-run-now <taskId>`.

Task summaries expose `id`, `name`, `schedule`, `type`, `enabled`, `nextRunAt`, `lastRunAt`, `lastStatus`, `runCount`. Each task also keeps its last 20 runs (`runHistory`) with status, time, and error.

## Behavior notes

- **Delivery** — a due task delivers its prompt as the next turn of the owning conversation (`sendMessage` with `triggerTurn`), so the assistant acts on it like user input.
- **Isolation** — `list`, `get`, `update`, `delete`, and firing all filter by session id; a task from another conversation is invisible.
- **Single active scheduler** — one process per session holds `scheduler.lock-<session-hash>`; any other process shows `scheduler: standby` in the status line instead of running timers.
- **Downtime** — if omp is closed when a task comes due, nothing is replayed. On restart, interval and cron tasks arm their next future slot; a one-shot whose time already passed is not fired.
- **One-shots** — disable themselves after a successful run.
- **Resolution** — timers are armed per task; the store is re-checked every 15 s so edits from the same session's other windows converge.

## Data location

Per-session files under `~/.omp/scheduler/`:

- `tasks-<session-hash>.json` — that session's tasks
- `scheduler.lock-<session-hash>` — the live-process lock

`<session-hash>` is the first 24 hex chars of the session id's SHA-256, so files from different conversations never collide. Deleting a conversation makes its task file inert; remove the file to reclaim the space.

## Development

```bash
npm test
```

Runs the `node:test` suite in `src/` (schedule parsing, session isolation, firing, catch-up after downtime).

## License

[Apache-2.0](LICENSE)
