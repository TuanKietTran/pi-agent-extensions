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
| `touchbar-usage/` | Git submodule: Claude Code and Codex quota polling with persistent left-side progress charts on the macOS Touch Bar. See its README for native host setup. |
| `claude-cli/` | Git submodule: wraps the authenticated Claude CLI as a Pi provider while delegating tool calls and execution to Pi. Supports text and image input. |
| `odysseus-bridge/` | Git submodule: exposes the live Pi harness and all authenticated Pi models through an OpenAI-compatible endpoint for Odysseus and other chat clients. |
| `context-guard.ts` | Caps a single tool result to a share of the *active* model's context window and elides the middle, keeping head and tail. Points the model at pi's complete saved output instead of the truncated copy. |
| `answer-floor.ts` | Stops pi's own reply budget from silently collapsing to a handful of tokens. When a reply is cut off anyway, compacts if the budget was short and resumes it — no `/compact` by hand. |
| `thinking-control.ts` | Adds the `/think` slash command pi lacks, and makes "off" actually reach the chat template instead of leaving thinking on at max effort. |
| `claude-dispatch/` | Retained for a future merge, but disabled in the aggregate package. Use the standalone `claude-cli` provider directly. |
| `remote-control.ts` | Shares the active pi session through a token-protected mobile web UI and optional Cloudflare Quick Tunnel. Start with `/remote-control start`; stop with `/remote-control stop`. |

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

## Remote control

Run `/remote-control start` to create a temporary HTTPS pairing link through
`cloudflared`, or `/remote-control local` for a loopback-only link. The built-in browser UI can view the conversation, stream replies, send or
steer prompts, and abort the current operation. On page reload it restores the
authenticated session from its secure cookie, renders an immediate `/api/state`
snapshot, and then attaches `/api/events` SSE for live updates.

The same server exposes an OpenAI-compatible facade for a richer existing UI:

```text
Base URL: https://<tunnel-host>/v1
API key:  <the token after # in the pairing URL>
Model:    pi-session
```

It implements `GET /v1/models` and streaming or non-streaming
`POST /v1/chat/completions`. Streaming uses standard OpenAI SSE chunks, disables
proxy buffering, and sends heartbeat comments during long tool calls. The
facade deliberately forwards only the latest
user message because pi remains the canonical owner of conversation history,
tools, and execution state. It works with Open WebUI and clients that permit a
custom OpenAI endpoint, including Conduit on iOS and Android. Official ChatGPT
and Claude mobile apps do not permit arbitrary compatible endpoints.

The URL fragment contains a bearer-strength pairing secret. Anyone with the
complete link can control pi and all tools available to the session, so keep it
private and run `/remote-control stop` when finished.

### Conduit mobile setup

1. Install [Conduit](https://github.com/cogwheel0/conduit).
2. Choose **Direct connection** and **OpenAI-compatible**.
3. Enter the base URL, API key, and `pi-session` model shown by pi.
4. Start a chat. Pi's active local session remains authoritative even though
   Conduit also keeps a device-local transcript.

Open WebUI can use the same values as an OpenAI-compatible connection.

## Installation

Install the aggregate package once instead of installing `claude-cli` or the
other component repositories separately:

```sh
pi install git:github.com/TuanKietTran/pi-agent-extensions
```

The package manifest loads the extensions in this repository and its
submodules. Initialize submodules after a manual clone:

```sh
git submodule update --init --recursive
```

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
