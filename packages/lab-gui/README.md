# lab-gui

A local web GUI for [`agent-cli-lab`](../agent-cli-lab): the lab graph, live state, a peek at each lab's screen, and message / stop / attach controls. It is the browser counterpart of `agent-cli-lab console`.

```sh
node packages/lab-gui/server.mjs --open      # or: npm start --prefix packages/lab-gui
lab-gui --port 4400                          # after skills/lab-commander/install.sh (links bin/lab-gui)
```

Open `http://127.0.0.1:4317/` (default port; `--port 0` picks a free one). Needs Node 20 or newer and `agent-cli-lab` on `PATH` (override with `AGENT_CLI_LAB_BIN`). `AGENT_CLI_LAB_DIR` selects which labs it sees, exactly as for the CLI. There are no dependencies to install.

## What it shows

- **Graph**: lead to helpers, drawn left to right. Each role has its own shape and colour plus a letter badge, so it still reads without colour: builder (rounded rectangle, B), explorer (pill, E), advisor (cut-corner octagon, A), commander (hexagon), manager (square corners), worker (dashed). The three-role team from `lab-team` is Sonnet builds, Haiku explores, Opus reviews.
- **Live state** per lab: working, asking, stalled, gone (a lab that vanished stays on the board for a minute), with a pulse on working labs and flowing edges to working children.
- **Activity sparkline** per lab, from the growth of the lab's output.
- **Model** per lab and **tokens / cost** where the lab prints them: Pi's footer (`↑in ↓out R… W… $cost ctx%`) is read from the screen. Labs that show no such footer say "not reported".
- **Side panel** (bottom sheet on a phone): live screen, a message box (Enter sends, Shift+Enter adds a line), buttons for Enter and Esc, **Attach** (opens the lab in a terminal window) and **Stop…** (asks first).
- Dark and light themes (follows the system, `t` toggles), layout down to phone width (the graph becomes a list), keyboard use throughout (`?` lists the keys).

## Safety

This process can type into and stop real terminals, so:

- it binds `127.0.0.1` only, and refuses any request whose `Host` header is not loopback (DNS rebinding);
- every state-changing request needs a per-launch random token that only the served page knows, a JSON body, and a same-origin `Origin` when the browser sends one;
- stopping needs the lab's name as confirmation in the request, not only a click;
- lab names are validated and every CLI call is an argument array (no shell); only a short list of keys can be pressed;
- the page's content-security policy allows only its own files, with no inline script or style, and screen text is inserted as text, never as HTML;
- no external service is contacted and nothing is sent anywhere. The server only polls the CLI while a page is open (about every 1.5 s) and goes idle 20 s after the last viewer leaves.

## Layout

```
server.mjs        entry point: arguments, listen on 127.0.0.1, optional browser open
lib/cli.mjs       the agent-cli-lab wrapper (list / status / screen / send / key / stop / foreground)
lib/monitor.mjs   builds the snapshot: graph, roles, state, models, activity, token and cost counters
lib/app.mjs       HTTP: static page, JSON API, server-sent events, request guards
public/           index.html, style.css, app.js (no build step)
test/             offline tests against a fake CLI; nothing here starts a lab
```

API (all JSON): `GET /api/labs`, `GET /api/stream` (server-sent events), `GET /api/labs/:name/screen?tail=N`, `POST /api/labs/:name/{send,key,stop,attach}`.

## Tests

```sh
npm test --prefix packages/lab-gui     # node --test, no network, no labs, no watch mode
```
