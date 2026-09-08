# touchbar-usage

Claude Code + Codex rate-limit windows on the MacBook Pro Touch Bar.

```
CC 5h 74% wk 6% ⟳29m  ·  CX mo 0% ⟳30d
```

- `CC` = Claude Code, `CX` = Codex.
- Window labels are derived from the API's own window length, not hardcoded.
  A Codex free plan reports one 30-day window (`mo`); paid plans report `5h`
  and `wk`. Labelling a monthly figure "5h" would be a wrong number, so the
  label follows the data.
- Credits (`$2.10`) appear **only** when the account actually has extra usage
  enabled — otherwise a permanent `$0.00` eats scarce strip width.
- The `⟳` figure is the soonest upcoming window reset.
- A trailing `!` means the data is older than 15 minutes (usually a sleep).

## Layout

| Path | Role |
|---|---|
| `index.ts` | pi extension — polls every 60s, `/touchbar-usage` command |
| `src/usage.mjs` | standalone core — fetch, parse, publish. No deps, no pi imports |
| `bin/pi-usagebar` | Touch Bar host entrypoint, prints one line |
| `host/main.swift` | native Control Strip app — no BTT/MTMR needed |
| `host/build.sh` | builds `~/Applications/UsageBar.app` (CLT only, no Xcode) |

Both the extension and the Touch Bar host call the same core, and the host
never talks to pi — so **the strip keeps updating with pi closed.**

## Endpoints

| Service | Endpoint | Auth |
|---|---|---|
| Claude | `GET api.anthropic.com/api/oauth/usage` | keychain `Claude Code-credentials` → `claudeAiOauth.accessToken`, plus `anthropic-beta: oauth-2025-04-20` |
| Codex | `GET chatgpt.com/backend-api/wham/usage` | `~/.codex/auth.json` → `tokens.access_token` + `chatgpt-account-id` |

Note the Codex path is `/wham/usage`. `/backend-api/codex/usage` also exists
but serves an HTML holding page, which is why the core treats a JSON parse
failure as `shape` rather than as bad data.

Both are unofficial and have changed shape before, so each side keeps a
hardcoded primary path plus a fallback (Claude's flat `limits[]` array) and
degrades to `!shape` instead of crashing or silently showing a wrong number.

## Install

```sh
chmod +x ~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar
~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar   # should print a line
```

Enable the extension in pi, then `/touchbar-usage status`.

### UsageBar.app (native, recommended)

MTMR is Intel-only and needs Rosetta; BetterTouchTool is paid. Both are shells
around two private `DFRFoundation` calls, so `host/` makes those calls directly
— arm64 native, ~200 lines, no dependencies.

```sh
host/build.sh                                    # -> ~/Applications/UsageBar.app
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.handlerone.usagebar.plist
```

`LSUIElement`, so there is no Dock tile and no menu bar item — the Touch Bar is
the whole UI. The host automatically presents left-aligned quota progress charts
in the app-controls area, leaving the right Control Strip available. This replaces
the foreground app's Touch Bar controls while presented. No tap or expanded view
is needed. Each window shows its label, usage percentage, and a progress track;
orange `!` marks cached/unavailable data, and red marks usage at 90% or higher.
These are current quota gauges, not historical trend charts. Refresh is every
60 seconds and on wake. Charts re-present after application and Space switches.
The Control Strip's Usage button can restore them manually. Presentation uses
private macOS APIs.

```sh
launchctl kickstart -k gui/$(id -u)/dev.handlerone.usagebar   # restart after a rebuild
launchctl bootout gui/$(id -u)/dev.handlerone.usagebar        # stop + disable
cat /tmp/usagebar.err.log                                     # only written on failure
```

If the strip stays empty: System Settings → Keyboard → Touch Bar shows must be
**App Controls with Control Strip** (or Control Strip), not "F1, F2…". The app
terminates immediately and logs `addSystemTrayItem: unavailable` if a future
macOS drops the private selector.

### BetterTouchTool

Touch Bar → `+` → **Shell Script / Task Widget**

- Script path: `~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar`
- Launch path `/bin/sh`, parameters `-c`
- Run every `60` seconds
- Uncheck "run script in background" so stdout becomes the button title

### MTMR

`~/Library/Application Support/MTMR/items.json`:

```json
{
  "type": "shellScriptTitledButton",
  "source": { "filePath": "~/.pi/agent/extensions/touchbar-usage/bin/pi-usagebar" },
  "refreshInterval": 60,
  "align": "left"
}
```

## Concurrency

Every pi session polls, but only one process per minute does network work:

- 60s freshness floor, checked against the published file's `updatedAt`
- atomic `mkdir` lease so exactly one process fetches
- lease reclaimed on TTL **or** dead-PID (`kill(pid, 0)`), so a tmux pane
  killed mid-fetch does not wedge the others for 90 seconds
- `rename()` publish, so the Touch Bar host never reads a torn file
- `os.homedir()` / `dscl` everywhere — `$HOME` is unreliable under a tmux
  server that outlived its shell, and absent under launchd

## Troubleshooting

```sh
bin/pi-usagebar --json     # full published state
bin/pi-usagebar --force    # bypass the 60s floor
```

Error suffixes: `!auth` (token expired — run the CLI once to refresh),
`!shape` (endpoint changed), `!offline`, `!429`, `!timeout`.
A bare `—` means no credentials found for that side.

`PI_USAGEBAR_NODE` overrides node resolution if the candidate list misses yours.

`PI_USAGEBAR_TRACE=<file>` appends one line per outbound HTTP request. This is
how the singleton property is verified rather than assumed — run N pollers,
then count the lines:

```sh
PI_USAGEBAR_TRACE=/tmp/t.log
for i in $(seq 1 12); do node src/usage.mjs --force & done; wait
wc -l /tmp/t.log   # 2, not 24
```
