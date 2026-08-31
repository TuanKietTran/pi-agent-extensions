# claude-dispatch

A [pi](https://github.com/earendil-works/pi) extension that hooks **every** pi
session to Claude, and turns any session into a control plane for the others.

Two halves:

**Routing** — every pi session is switched onto a bundled `claude-cli` provider
at startup, so `pi "…"` runs on Claude in every project without a `--provider`
flag. Auth comes from whatever the local `claude` binary is already logged in
as; there is no API key to configure.

**Control plane** — every session registers itself in a file-backed registry
under `~/.pi/agent/dispatch/`. Any session can list its peers, queue prompts
into them, follow their activity live, or abort them — and can hand a
self-contained task to a fresh headless Claude Code run.

## Install

Already installed if this directory lives at
`~/.pi/agent/extensions/claude-dispatch/`. pi auto-discovers it for every
project. Requires the `claude` CLI on `PATH` (override with `CLAUDE_BIN`).

Verify with:

```sh
pi --list-models claude     # should list the claude-cli models
```

## Commands

```
/dispatch list                      live pi sessions (• marks this one)
/dispatch send <session> <prompt>   queue a prompt into another session
/dispatch broadcast <prompt>        queue a prompt into every other session
/dispatch attach [session]          follow a session's activity live
/dispatch detach                    stop following
/dispatch tail <session> [n]        recent activity of a session
/dispatch stop <session>            abort a session's current run
/dispatch claude <prompt>           one-shot headless Claude run here
/dispatch on | off | status         routing for this session
/dispatch default on | off          routing for all new sessions
/dispatch default model <id>        which Claude model to route to
/dispatch default fallback <p>/<m>  model to restore when routing is off
/dispatch default tool any|anthropic  which models may call the dispatch tool
```

`<session>` is any unique prefix of a session id, or a substring of a session
name or directory.

## Flags

```
--no-claude-dispatch      do not route this session
--dispatch-model <id>     route this session to a specific Claude model
```

## Tools for the model

Whatever model a session is on can drive its peers. How the tools get to it
depends on how the session is running:

**Routed to `claude-cli`** — pi hosts a small MCP server on loopback and points
the `claude` subprocess at it, so Claude calls the dispatch tools natively:

```
mcp__pi-dispatch__dispatch_list        live pi sessions, with full ids
mcp__pi-dispatch__dispatch_send        queue a prompt into one of them
mcp__pi-dispatch__dispatch_broadcast   queue a prompt into all of them
mcp__pi-dispatch__dispatch_tail        read a session's recent activity
```

The server binds `127.0.0.1` on an ephemeral port, requires a per-session
bearer token, and dies with the session.

**On any other provider** — codex, llama-swap, a native Anthropic provider —
pi's own `dispatch` tool applies, with the same actions plus `claude` (delegate
a subtask to a headless Claude Code run). Dispatching is a local, same-user
operation, so nothing here is Claude-specific; a session on gpt-5.6-sol can
orchestrate its peers exactly as Claude does.

To restrict it to Anthropic models anyway:

```
/dispatch default tool anthropic     # only Anthropic models may call it
/dispatch default tool any           # the default
```

`/dispatch` **commands** work everywhere regardless of that setting, because
you drive those, not the model.

## Two things worth knowing

**1. A Claude-routed session cannot call pi's own tools.**

The `claude-cli` provider wraps `claude -p` as a text-producing model. Claude
Code runs its *own* tools inside that subprocess and the provider renders them
as `▶ Bash: …` lines, so pi's agent loop never receives a tool call back. Every
pi tool is invisible to a routed session, this extension's included — which is
why the dispatch tools are handed to the subprocess over MCP instead of being
registered with pi.

**2. Routing rewrites pi's persisted default model.**

`pi.setModel()` writes its choice through to `~/.pi/agent/settings.json`, so
once a session has been routed, pi's own `defaultProvider`/`defaultModel` say
`claude-cli`. That is consistent with what the extension is for, but it means
pi forgets what you were on before.

The extension records your real model in `~/.pi/agent/dispatch/config.json` as
`fallbackProvider`/`fallbackModel` the first time it sees it, and restores from
there whenever routing is turned off (`--no-claude-dispatch`, `/dispatch off`,
`/dispatch default off`). Set it explicitly with:

```
/dispatch default fallback openai-codex/gpt-5.6-sol
```

To fully back out: `/dispatch default off`, then delete this directory.

## How the control plane works

```
~/.pi/agent/dispatch/
  config.json              routing settings + fallback model
  peers/<session>.json     one file per live session, heartbeat every 10s
  inbox/<session>.jsonl    prompts and aborts queued for that session
  outbox/<session>.jsonl   that session's activity tail, for attach/tail
```

Files rather than sockets: pi sessions are killed, closed, and abandoned all
the time, and a dead peer must not leave a listening port behind. A stale peer
file names a pid that no longer exists, so whoever reads the registry reaps it.

Peer files are written via temp-file + rename so a reader never sees a
half-written record. Inboxes are append-only and consumed by byte offset, so a
reader can never truncate away a message a writer is appending. Delivery is
polled (`fs.watchFile`, 400 ms) rather than event-based, which behaves
identically on Windows and survives the file being replaced.

A dispatched prompt arrives in the target session as a normal user message,
prefixed with `[dispatch from <id> · <cwd>]`, steering the run if the target is
idle and queued as a follow-up if it is mid-stream.

## Files

| File | Role |
|---|---|
| `index.ts` | routing, lifecycle, `/dispatch` command, `dispatch` tool |
| `registry.ts` | cross-process peer registry, inbox/outbox IPC |
| `provider.ts` | the `claude-cli` provider |
| `claude.ts` | spawning `claude` and parsing its stream-json |
| `mcp.ts` | the in-process MCP server the subprocess calls back into |
| `dispatch.ts` | one-shot headless Claude runs |

Prompts are written to the subprocess's stdin, not passed as an argument: a
routed session replays its whole conversation into every turn, and a Windows
command line caps out at 32 KB, past which the spawn fails outright. Only
bounded things (flags, the system prompt, the MCP config *path*) go in argv.

`provider.ts` is derived from `pi-extension-claude-cli` and bundled so this
extension stands alone. If you also have that extension installed both register
the same provider name with equivalent models; the last one loaded wins.
