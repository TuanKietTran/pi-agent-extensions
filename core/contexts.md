# Core context

Pi's loop stays turn-based. Streaming is the control plane. Host owns time, Pi owns decisions.

Pi thinks only on: user text, completed cheap tools, and injected `job_event` steers.

## Event contract

States: `queued | running | progress | completed | failed | timed_out | lost | cancelled`

Steer payload (one JSON block, same schema every time):

```json
{"type":"job_event","job_id":"deploy-42","state":"timed_out","step":"healthcheck","elapsed_s":45,"last_line":"Waiting for :8080","reversible":false,"cancelable":true,"options":["cancel","keep_waiting","rollback","inspect_logs"]}
```

- Steer on change, not on every log line.
- `progress` at most every N seconds or on milestone.
- Missing heartbeat → `lost`, not silence.
- SLA miss → `timed_out`. Host decides whether the process is killed.

## Operating modes

1. Interactive coding: host runs tests/builds as jobs; steer summaries into the session.
2. Attended automation: RPC client + human; human can steer or abort.
3. Unattended: host auto-cancels on `lost`; irreversible jobs disabled unless allowlisted.

## Not to do

- Poll `job_status` every turn
- Wrap long processes in built-in `bash`
- Inject every log line into context
- Run a second agent loop inside a tool
