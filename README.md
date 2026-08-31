# pi-agent-extensions

Global extensions for the [pi coding agent](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`), consumed as a git submodule at
`~/.pi/agent/extensions/`, which is where pi auto-discovers `*.ts` and
`*/index.ts`.

Not to be confused with `D:\projects\pi`, a separate CLI with its own unrelated
extension system in `exts/`.

## Extensions

| Extension | What it does |
|---|---|
| `context-guard.ts` | Caps a single tool result to a share of the *active* model's context window and elides the middle, keeping head and tail. Points the model at pi's complete saved output instead of the truncated copy. |
| `answer-floor.ts` | Stops pi's own reply budget from silently collapsing to a handful of tokens, and raises a visible error on any `length` stop. |
| `thinking-control.ts` | Adds the `/think` slash command pi lacks, and makes "off" actually reach the chat template instead of leaving thinking on at max effort. |
| `claude-dispatch/` | Routes a pi session to the `claude-cli` provider. Disable per-run with `--no-claude-dispatch`. |

The three single-file extensions exist because of one shared root cause: pi's
context accounting assumes a large hosted model, and every default it picks is
wrong in a way that fails *silently* against a local llama.cpp server.

### The arithmetic they defend

pi sizes every request in `ai/src/api/simple-options.ts`:

```js
CONTEXT_SAFETY_TOKENS = 4096, MIN_MAX_TOKENS = 1
available  = model.contextWindow - estimateContextTokens(context) - 4096
max_tokens = min(model.maxTokens, max(1, available))
```

Two constants do the damage. The 4096-token safety margin is deducted from the
*answer*, so on a small window it eats the reply rather than the prompt. And the
floor is **1**, not `MIN_ANSWER_TOKENS` (1024), so when the budget collapses pi
does not error — it asks for whatever is left and returns a sentence that stops
mid-word.

Observed, in session `01a0559f` on an 8192-token window:

```
8192 (window) − 4024 (context) − 4096 (safety) = 72 → max_tokens: 72
"stopReason": "length", "output": 72
```

The reply ended at "I'm going to create a".

### The rule that keeps it from happening

```
compaction.reserveTokens  ≥  4096 + model.maxTokens
```

Compaction triggers at `contextWindow − reserveTokens`, so the reserve has to
cover the hidden safety margin *plus* a full reply. Anything less and compaction
fires only after the budget has already collapsed. `answer-floor.ts` is the
backstop for when that rule drifts — a new model, a hand-edited setting.

## Layout

Each extension is either a single `.ts` file or a directory with `index.ts`.
pi loads them from trusted locations only:

| Path | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | global |
| `~/.pi/agent/extensions/*/index.ts` | global |
| `.pi/extensions/*.ts` | project-local, after the project is trusted |

## Working on these

Extensions in auto-discovered locations hot-reload with `/reload` inside pi. Use
`pi -e ./path.ts` only for one-off tests — it bypasses discovery and cannot be
reloaded.

Types come from the `@earendil-works/pi-coding-agent` package that ships inside
the pi install; there is no build step and no `node_modules` here. pi transpiles
the TypeScript itself.

## Not collected here

`D:\projects\pwb\pi\pwb-tools.ts` is a pi extension too, but it is owned by the
pwb project, loaded by absolute path from `settings.json`, and versioned with the
tool it bridges. It stays where it is.
