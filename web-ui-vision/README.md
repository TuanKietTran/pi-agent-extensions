# Pi Web UI Vision

A Pi extension that lets the agent **see and interact with a live browser UI**. It returns screenshots as native image tool results and exposes compact, reusable element references for reliable interaction.

## Tools

- `web_ui_pages` — list, select, create, and close tabs
- `web_ui_open` — navigate the active tab
- `web_ui_observe` — capture a screenshot and visible interactive-element map
- `web_ui_act` — click, drag, type, fill, press, hover, select, check, scroll, or wait
- `/web-ui` — show connection status; `/web-ui open <url>` navigates manually

A normal agent loop is:

1. `web_ui_observe`
2. choose a target from the screenshot or an element ref such as `e12`
3. `web_ui_act`
4. observe again after the UI changes

For drag interactions, identify the source by `ref`, selector, role/name, or `x`/`y`. Set the destination with either absolute `target_x`/`target_y` coordinates or relative `delta_x`/`delta_y` distances. For example:

```json
{
  "action": "drag",
  "role": "separator",
  "name": "Resize editor and preview",
  "delta_x": 100,
  "delta_y": 0
}
```

For a click expected to download a file, set `expect_download` to `true`. The action waits for the browser download event and returns each artifact's suggested filename, source URL, temporary local path when available, and failure message when applicable:

```json
{
  "action": "click",
  "text": "PNG",
  "expect_download": true,
  "timeout_ms": 15000
}
```

## Install

```bash
cd /Users/handlerone/Downloads/pi-web-ui-vision
npm install
pi -e /Users/handlerone/Downloads/pi-web-ui-vision
```

For persistent installation:

```bash
pi install /Users/handlerone/Downloads/pi-web-ui-vision
```

By default, the extension launches an installed Chrome, Chromium, Edge, or Brave browser headlessly in a fresh profile, without a visible window or user-profile tabs. It does not download a browser.

## Browser isolation

The extension always launches its own headless Chromium process and never connects to an existing browser through CDP. This keeps automation tabs and virtual input separate from the user's browser, keyboard focus, and pointer.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PI_WEB_UI_URL` | `about:blank` | Initial URL when a page is first created |
| `PI_WEB_UI_EXECUTABLE_PATH` | auto-detected | Browser executable used when not connecting over CDP |
| `PI_WEB_UI_TIMEOUT_MS` | `15000` | Playwright action/navigation timeout |
| `PI_WEB_UI_MAX_ELEMENTS` | `200` | Maximum visible interactive elements per observation |

Example for a local client UI:

```bash
PI_WEB_UI_URL=http://127.0.0.1:7000 \
  pi -e /Users/handlerone/Downloads/pi-web-ui-vision
```

## Safety

The extension runs with the user's permissions but uses a separate, headless browser profile. Review consequential actions such as purchases, publishing, deletion, and credential submission.
