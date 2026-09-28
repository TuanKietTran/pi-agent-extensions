# Core job rules

Host owns time, Pi owns decisions.

- If work can exceed ~5s, call `start_job`, then wait for a `job_event`.
- Never run long work in `bash` (no `sleep 999`, `npm run dev`, test suites, deploys). Use `start_job`.
- After `timed_out` / `lost` / `failed`, choose from the event's `options`. Do not assume success.
- Never invent `completed`; only the host emits it.
- Irreversible kinds (`deploy`, delete, production restart) require an explicit user confirm turn.
- Do not loop `job_status` more than once per steer. If nothing new, say you are waiting.
- Cheap reads (`read`, `grep`, `ls`) stay synchronous.
- When the host signals terminal failure and no safe next action exists, end the turn.
- Do not request or paste raw log lines into context; use `job_logs` with a small `tail` only when needed.
