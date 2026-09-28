# Core contexts

Model-facing context and numeric limits. Limits are read through `limits()` in `core/md.ts` when pi loads the extension; changes need a pi restart. `job-context` is read through `prompt()` and appended to the system prompt on every run.

## Limits

- `context-guard`: `result_share` of the active model's context window one tool result may use; `chars_per_token` converts it to bytes; `min_bytes` floors it, `max_bytes` is pi's own ceiling (only ever tightened); `max_lines` caps lines; `head_share` of the budget keeps the head, the rest keeps the tail.
- `answer-floor`: `floor_tokens` minimum `max_tokens` restored on a request; `safety_tokens` mirrors pi's hardcoded CONTEXT_SAFETY_TOKENS; `max_auto_continues` bounds consecutive resumes.
- `context-optimize`: summary output bounds, pi's provider safety reserve, chars-per-token estimate for the prompt, and fixed request overhead.
- `todo`: `max_visible_todos` rows shown in the right panel; `max_auto_continuations` bounds consecutive auto-feed continuations per run.

```json
{
  "context-guard": { "result_share": 0.06, "chars_per_token": 4, "min_bytes": 4000, "max_bytes": 50000, "max_lines": 400, "head_share": 0.4 },
  "answer-floor": { "floor_tokens": 2048, "safety_tokens": 4096, "max_auto_continues": 3 },
  "context-optimize": { "max_summary_tokens": 8192, "min_summary_tokens": 1024, "provider_safety_tokens": 4096, "chars_per_token": 3, "request_overhead_tokens": 512 },
  "todo": { "max_visible_todos": 14, "max_auto_continuations": 20 }
}
```

## job-context

Appended to the system prompt on every run (job supervisor).

```text
# Core context

Pi's loop stays turn-based. Streaming is the control plane. Host owns time, Pi owns decisions.

Pi thinks only on: user text, completed cheap tools, and injected `job_event` steers.

## Event contract

States: `queued | running | progress | completed | failed | timed_out | lost | cancelled`

Steer payload (one JSON block, same schema every time):

{"type":"job_event","job_id":"deploy-42","state":"timed_out","step":"healthcheck","elapsed_s":45,"last_line":"Waiting for :8080","reversible":false,"cancelable":true,"options":["cancel","keep_waiting","rollback","inspect_logs"]}

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
```
