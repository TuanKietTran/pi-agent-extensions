# Pi macOS Browser Control

A Pi extension for controlling a Chrome-compatible browser on macOS with native Quartz mouse/keyboard events. It captures the browser window's backing surface directly and overlays a red trail plus crosshair for the tracked virtual mouse.

This is the native companion to DOM/CDP-oriented browser tools: it can operate browser chrome, permission dialogs, canvas apps, and other pixel-only UI that a page-level automation API cannot reach.

## Features

- Background input by default: events are posted straight into the browser process, so your frontmost app, physical pointer, and keyboard are never taken over
- Native mouse move, background click, foreground `focus_click`, double-click, right-click, drag, and pixel scrolling
- Native Unicode typing and keyboard shortcuts
- Focus-free direct-window screenshots, including covered, minimized, other-display, and other-Space windows
- Persistent, branch-aware mouse trail overlaid on observations
- Open/list/select/close tabs through macOS Automation
- Accessibility and Screen Recording permission checks
- Serialized operations so parallel tool calls cannot interleave input
- Swift helper compiled locally and cached under `~/Library/Caches/pi-macos-browser-control`

## Tools

- `mac_browser_observe` — capture the browser window without activating it and mark the current mouse/trail
- `mac_browser_act` — move, click, force focus with `focus_click`, drag, scroll, type, press a key, wait, or reset the trail; all actions are background-only except explicit `focus_click`
- `mac_browser_surface` — turn native surface input on/off, toggle it, or inspect its state
- `mac_browser_tabs` — status, open, create, list, select, or close browser tabs
- `/mac-browser` — status command
- `/mac-browser surface on|off|toggle|status` — control the same persisted surface-input state
- `/mac-browser permissions` — trigger macOS permission prompts
- `/mac-browser reset` — clear the tracked mouse trail
- `/mac-browser open https://example.com` — open a URL manually

Typical loop:

1. Call `mac_browser_observe`.
2. Choose browser-window coordinates from the image.
3. Call `mac_browser_act`.
4. Observe again after the UI changes.

## Install

```bash
cd /Users/handlerone/Downloads/pi-macos-browser-control
npm install
npm run check
npm run check:native
pi -e /Users/handlerone/Downloads/pi-macos-browser-control
```

Persistent installation:

```bash
pi install /Users/handlerone/Downloads/pi-macos-browser-control
```

Then run:

```text
/mac-browser permissions
```

Enable the terminal application that launches Pi (or Pi itself, depending on how it runs) in:

- **System Settings → Privacy & Security → Accessibility**
- **System Settings → Privacy & Security → Screen Recording**
- **System Settings → Privacy & Security → Automation** when Chrome control prompts

Restart Pi after granting permissions.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PI_MAC_BROWSER_APP` | auto-detected | Chrome-compatible app name (Chrome, Brave, Edge, then Chromium) |
| `PI_MAC_BROWSER_MOVE_MS` | `260` | Default smooth pointer movement duration |
| `PI_MAC_BROWSER_ACTION_DELAY_MS` | `250` | Settle delay after actions and before default captures |
| `PI_MAC_BROWSER_TRAIL_LENGTH` | `24` | Maximum tracked virtual-pointer positions |
| `PI_MAC_BROWSER_SHOW_STATUS` | unset | Set to `1` to show Pi's mac-browser status decoration; hidden by default |
| `PI_MAC_BROWSER_MAX_IMAGE_EDGE` | `1920` | Longest screenshot edge in pixels (capped at 2000, Pi's resize limit) |

Example:

```bash
PI_MAC_BROWSER_APP="Brave Browser" pi -e /Users/handlerone/Downloads/pi-macos-browser-control
```

## Coordinate model

Coordinates are **pixels in the latest `mac_browser_observe` browser-window screenshot**, with `(0, 0)` at its top-left. The extension maps them back to global macOS points itself, so Retina scaling, Pi image handling, moved windows, and non-primary displays do not skew clicks. If the observed window is replaced or resized, act refuses to run until you observe again.

Observation uses `screencapture -l <window-id>` against the browser's backing surface. It does not activate Brave/Chrome and excludes other apps, the desktop, Dock, and window shadows. This works while the browser is covered, minimized, on another display, or on another macOS Space.

The trail tracks automation endpoints, not every physical sample. Smooth moves and drags are executed with intermediate native events, while the screenshot overlay connects recorded action endpoints.

## Safety

This extension drives a browser running under your user account and can operate authenticated pages.

Surface input is on by default and can be changed by either `mac_browser_surface` or `/mac-browser surface on|off|toggle|status`; both use the same session-persisted state. When enabled, `mac_browser_act` runs in **background mode**: each synthetic event is delivered with `CGEvent.postToPid` to the browser process instead of the shared HID tap. Nothing is routed through the system event stream, so the automation cannot land in Pi, your editor, or whatever else you are typing into, and your physical cursor never moves. The browser is not activated, not unminimized, and not brought forward, so automation cannot interrupt you. Because the pointer is virtual, the reported `cursor` and the trail overlay track the synthetic position, not your real mouse.

Foreground input is limited to the explicit `focus_click` action. It activates the browser and performs one system-wide HID click to establish real Chromium element focus, moving the physical pointer and interrupting the frontmost app. Every other mouse/keyboard action still requires a target browser PID, preventing accidental fallback to the shared HID stream.

Chromium may ignore background keyboard input and some clicks when it is not the active application. Native menus, OS-level dialogs, and key-window-only controls are therefore unsupported by design. For searches and navigation, use `mac_browser_tabs` with a complete URL instead of focusing an address/search field. The extension will not work around a rejected background action by activating the browser.

Observe before coordinate actions, and explicitly confirm purchases, credential submission, publishing, messages, deletion, or other consequential actions. URLs are restricted to HTTP(S) and `about:blank`.

The referenced Claude Chrome-control listing was used as product inspiration. This implementation is independent and uses Pi's extension API plus native macOS frameworks.
