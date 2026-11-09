# omp-task-scheduler

Session-scoped scheduled prompts for omp. A task runs only in the conversation that created it. Other conversations do not see it and cannot fire it.

Schedules:

- interval: `30s`, `10m`, `6h`, `1d`
- once: `+5m` or an ISO timestamp
- cron: five fields, `15 4 * * *`

Missed runs are not replayed after downtime. The next future time is armed instead.

Tasks are stored under `~/.omp/scheduler/tasks-<session-hash>.json`. One live process per session holds `scheduler.lock-<session-hash>`.

Tools: `scheduler_create`, `scheduler_list`, `scheduler_get`, `scheduler_update`, `scheduler_delete`, `scheduler_run_now`.

Commands: `/scheduler-list`, `/scheduler-run-now <taskId>`.

Load it with `omp plugin link --scope project /home/helijun/Project/omp-task-scheduler`, then restart the conversation.
