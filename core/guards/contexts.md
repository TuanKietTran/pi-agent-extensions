# Guard contexts

Numeric limits and model-window arithmetic per guard. Read through `guardSettings()` in `core/md.ts` when pi loads the extension; changes need a pi restart.

- `context-guard`: `result_share` of the active model's context window one tool result may use; `chars_per_token` converts it to bytes; `min_bytes` floors it, `max_bytes` is pi's own ceiling (only ever tightened); `max_lines` caps lines; `head_share` of the budget keeps the head, the rest keeps the tail.
- `answer-floor`: `floor_tokens` minimum `max_tokens` restored on a request; `safety_tokens` mirrors pi's hardcoded CONTEXT_SAFETY_TOKENS; `max_auto_continues` bounds consecutive resumes.
- `context-optimize`: summary output bounds, pi's provider safety reserve, chars-per-token estimate for the prompt, and fixed request overhead.

```json
{
  "context-guard": { "result_share": 0.06, "chars_per_token": 4, "min_bytes": 4000, "max_bytes": 50000, "max_lines": 400, "head_share": 0.4 },
  "answer-floor": { "floor_tokens": 2048, "safety_tokens": 4096, "max_auto_continues": 3 },
  "context-optimize": { "max_summary_tokens": 8192, "min_summary_tokens": 1024, "provider_safety_tokens": 4096, "chars_per_token": 3, "request_overhead_tokens": 512 }
}
```
