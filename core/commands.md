# Core commands and job kinds

## Tools

1. `start_job(kind, spec)` → `{ job_id, state, sla_s, heartbeat_s, cancelable, reversible }`
2. `job_status(job_id)` → snapshot (rare; host steers first)
3. `cancel_job(job_id)` → ack
4. `job_logs(job_id, tail)` → last N lines, bounded

## Slash commands

- `/jobs` — list jobs and states

## Job kinds

Parsed by the extension. `class`: idempotent | reversible | compensable | irreversible.
`sla_s`: hard timeout. `heartbeat_s`: 0 disables lost-detection by silence.

```json
{
  "shell":  { "sla_s": 60,  "heartbeat_s": 0,  "class": "idempotent",   "cancelable": true },
  "test":   { "sla_s": 120, "heartbeat_s": 0,  "class": "idempotent",   "cancelable": true },
  "watch":  { "sla_s": 3600, "heartbeat_s": 10, "class": "idempotent",  "cancelable": true },
  "deploy": { "sla_s": 180, "heartbeat_s": 0,  "class": "irreversible", "cancelable": true }
}
```

## Event options by state

```json
{
  "timed_out": ["cancel", "keep_waiting", "rollback", "inspect_logs"],
  "lost":      ["cancel", "inspect_logs", "restart"],
  "failed":    ["inspect_logs", "restart"],
  "completed": [],
  "cancelled": [],
  "progress":  [],
  "queued":    [],
  "running":   []
}
```
