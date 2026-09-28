import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_EVENT } from "./pi-events.ts";

// --- Browser constants: local literals live together here. ---
const PARENT = "..";
const NATIVE_DIR = "native";
const SWIFT_FILE = "macos-controller.swift";
const CHROME_FILE = "chrome-control.js";
const TOOL_OBSERVE = "mac_browser_observe";
const TOOL_ACT = "mac_browser_act";
const TOOL_SURFACE = "mac_browser_surface";
const TOOL_TABS = "mac_browser_tabs";
const COMMAND_NAME = "mac-browser";
const STATUS_KEY = "mac-browser";
const SURFACE_STATE_KEY = "mac-browser-surface-state";
const ENTRY_CUSTOM = "custom";
const ENTRY_MESSAGE = "message";
const ROLE_TOOL_RESULT = "toolResult";
const TONE_ACCENT = "accent";
const PLATFORM_MACOS = "darwin";
const ACTION_STATUS = "status";
const ACTION_ON = "on";
const ACTION_OFF = "off";
const ACTION_TOGGLE = "toggle";
const ACTION_OPEN = "open";
const ACTION_NEW_TAB = "new_tab";
const ACTION_SELECT_TAB = "select_tab";
const ACTION_CLOSE_TAB = "close_tab";
const ACTION_LIST_TABS = "list_tabs";
const ACTION_MOVE = "move";
const ACTION_CLICK = "click";
const ACTION_FOCUS_CLICK = "focus_click";
const ACTION_DOUBLE_CLICK = "double_click";
const ACTION_RIGHT_CLICK = "right_click";
const ACTION_DRAG = "drag";
const ACTION_SCROLL = "scroll";
const ACTION_TYPE = "type";
const ACTION_KEY = "key";
const ACTION_WAIT = "wait";
const ACTION_RESET_TRAIL = "reset_trail";
const ACTIONS = [ACTION_MOVE, ACTION_CLICK, ACTION_FOCUS_CLICK, ACTION_DOUBLE_CLICK, ACTION_RIGHT_CLICK, ACTION_DRAG, ACTION_SCROLL, ACTION_TYPE, ACTION_KEY, ACTION_WAIT, ACTION_RESET_TRAIL] as const;
const SURFACE_ACTIONS = [ACTION_ON, ACTION_OFF, ACTION_TOGGLE, ACTION_STATUS] as const;
const TAB_ACTIONS = [ACTION_STATUS, ACTION_OPEN, ACTION_NEW_TAB, ACTION_LIST_TABS, ACTION_SELECT_TAB, ACTION_CLOSE_TAB] as const;
const NOTE_INFO = "info";
const NOTE_ERROR = "error";
const NOTE_WARNING = "warning";
const BLOCK_TEXT = "text";
const BLOCK_IMAGE = "image";
const MIME_IMAGE = "image/jpeg";
const ENCODING_BASE64 = "base64";
const NEWLINE = "\n";
const OBSERVE_LABEL = "Observe Mac Browser";
const OBSERVE_DESCRIPTION = "Capture the browser window directly without focusing it, even when covered, minimized, on another display, or on another Space. " +
  "Pixel coordinates in this screenshot are the coordinates mac_browser_act expects. Requires Screen Recording permission.";
const OBSERVE_SNIPPET = "See the native macOS browser and tracked mouse position";
const OBSERVE_GUIDELINES = [
  "Use mac_browser_observe before mac_browser_act when a click target or current browser state is uncertain.",
  "After mac_browser_act changes the UI, use mac_browser_observe again before another uncertain coordinate action.",
];
const ACT_LABEL = "Act on Mac Browser";
const ACT_DESCRIPTION = "Send mouse and keyboard events to the browser with native Quartz events. Actions: move, click, focus_click, double_click, right_click, drag, scroll, type, key, wait, reset_trail. " +
  "Coordinates are pixels in the latest mac_browser_observe screenshot. Most input is delivered directly to the browser process in the background. focus_click activates the browser and performs a foreground HID click to establish real Chromium mouse/keyboard focus; it moves the physical pointer and interrupts the user's current app. Requires Accessibility permission.";
const ACT_SNIPPET = "Click/type into the background browser without touching the user's focus or pointer";
const ACT_GUIDELINES = [
  "Use mac_browser_act only after mac_browser_observe provides a fresh view when coordinate targets are uncertain.",
  "Use focus_click only when Chromium rejects a background click or typing requires real element focus; it brings the browser forward and moves the physical pointer.",
  "Before mac_browser_act submits credentials, purchases, messages, publications, deletions, or other consequential changes, obtain explicit user confirmation.",
];
const SURFACE_LABEL = "Mac Browser Surface";
const SURFACE_DESCRIPTION = "Turn native browser-surface input on or off, toggle it, or inspect its current state. This controls mac_browser_act without disabling observation or tab tools.";
const SURFACE_SNIPPET = "Control whether native macOS browser surface input is enabled";
const TABS_LABEL = "Mac Browser Tabs";
const TABS_SNIPPET = "Open URLs and list/select/close native Chrome-compatible tabs";
const COMMAND_DESCRIPTION = "Show status; control surface input; request permissions; reset trail; or open URL";
const DESC_CAPTURE_DELAY = "Delay before capture; defaults to 250ms";
const DESC_X = "Screenshot x pixel (also the scroll position)";
const DESC_Y = "Screenshot y pixel (also the scroll position)";
const DESC_TARGET_X = "Drag destination screenshot x pixel";
const DESC_TARGET_Y = "Drag destination screenshot y pixel";
const DESC_DELTA_X = "Horizontal scroll amount in pixels";
const DESC_DELTA_Y = "Vertical scroll amount in pixels; positive scrolls up";
const DESC_TEXT = "Literal text for the type action; newlines press Enter";
const DESC_KEY = "Key name, e.g. enter, tab, escape, left, backspace, f5, a, or 1";
const DESC_MODIFIERS = "Modifiers for key";
const DESC_DURATION = "Smooth move/drag duration";
const DESC_INTERVAL = "Delay between typed characters";
const DESC_WAIT = "Wait action duration";
const DESC_URL = "HTTP(S) URL or about:blank for open/new_tab";
const DESC_WINDOW = "1-based browser window index";
const DESC_TAB = "1-based tab index";
const MODIFIERS = ["command", "shift", "option", "control"] as const;
const MESSAGE_DISABLED = "Native browser surface input is off. Use mac_browser_surface with action=on before interacting.";
const MESSAGE_ACCESSIBILITY = "Accessibility permission is required. Run /mac-browser permissions, then enable your terminal or Pi in System Settings > Privacy & Security > Accessibility.";
const MESSAGE_SCREEN_RECORDING = "Screen Recording permission is required. Run /mac-browser permissions, then enable your terminal or Pi in System Settings > Privacy & Security > Screen Recording.";
const MESSAGE_CAPTURE_FAILED = "macOS screen capture failed";
const MESSAGE_NO_PID = "Background browser PID is unavailable";
const MESSAGE_TYPE_REQUIRES_TEXT = "type requires text";
const MESSAGE_KEY_REQUIRES_KEY = "key requires key";
const MESSAGE_NO_URL = "This action requires url";
const MESSAGE_URL_PROTOCOL = "Only http://, https://, and about:blank URLs are allowed";
const MESSAGE_ABORTED = "Operation aborted";
const MESSAGE_NOT_MACOS = "macOS browser control loaded, but this backend currently requires macOS";
const MESSAGE_OUTSIDE = "outside screenshot";
const MESSAGE_TRUNCATED = "\n[Output truncated at 32KB]";
const URL_BLANK = "about:blank";
const URL_PROTOCOLS = ["http:", "https:"];
const ENCODING_UTF8 = "utf8";
const browserMode = (enabled: boolean) => enabled ? ACTION_ON : ACTION_OFF;
const MESSAGE_NOT_SUPPORTED = "mac_browser tools currently support macOS only";
const MESSAGE_WINDOW_CHANGED = "The observed browser window changed; call mac_browser_observe again";
const MESSAGE_WINDOW_RESIZED = "The browser window was resized since the last observation; call mac_browser_observe again";
const MESSAGE_DISPLAY_CHANGED = "Display layout changed since the last observation; call mac_browser_observe again";
const MESSAGE_CAPTURING = "Capturing the macOS browser…";
const MESSAGE_RESET = "macOS browser mouse trail reset";
const MESSAGE_COORDINATES = (label: string) => `${label} requires x and y`;
const MESSAGE_NONFINITE = (label: string) => `${label} coordinates must be finite`;
const MESSAGE_WINDOW_MISSING = (app: string) => `No ${app} window found; call mac_browser_observe again`;
const MESSAGE_NO_WINDOW = (app: string) => `${app} has no capturable window. Open a browser window and try again.`;
const MESSAGE_NOT_RUNNING = (app: string) => `${app} is not running; open a browser window and try again.`;
const MESSAGE_OUT_OF_BOUNDS = (label: string, point: Point, view: View) => `${label} (${point.x},${point.y}) is outside the ${view.width}x${view.height} screenshot`;
const MESSAGE_SURFACE = (enabled: boolean) => `browser_surface=${browserMode(enabled)}`;
const MESSAGE_SURFACE_STATUS = (enabled: boolean) => `Browser surface input: ${browserMode(enabled)}`;
const MESSAGE_PERMISSION_STATUS = (accessibility: boolean, screenRecording: boolean) =>
  `Accessibility: ${accessibility}; Screen Recording: ${screenRecording}. Restart Pi after granting access.`;
const MESSAGE_APP_STATUS = (enabled: boolean, status: NativeStatus, browserInfo: string) =>
  `Surface input: ${browserMode(enabled)}; Accessibility: ${status.accessibility}; Screen Recording: ${status.screenRecording}; Cursor: ${Math.round(status.cursor.x)},${Math.round(status.cursor.y)}\n${browserInfo}`;
const tabsDescription = (app: string) => `Control ${app} tabs through native macOS Automation. Actions: status, open, new_tab, list_tabs, select_tab, close_tab. open/new_tab wait up to 10s for the page to load.`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), PARENT);
const SWIFT_SOURCE = join(ROOT, NATIVE_DIR, SWIFT_FILE);
const CHROME_SCRIPT = join(ROOT, NATIVE_DIR, CHROME_FILE);
const BROWSER_APP = detectBrowserApp();
const MOVE_DURATION = positiveInt(process.env.PI_MAC_BROWSER_MOVE_MS, 260);
const ACTION_DELAY = positiveInt(process.env.PI_MAC_BROWSER_ACTION_DELAY_MS, 250);
const TRAIL_LIMIT = positiveInt(process.env.PI_MAC_BROWSER_TRAIL_LENGTH, 24);
const SHOW_STATUS = process.env.PI_MAC_BROWSER_SHOW_STATUS === "1";
// Pi downscales images wider/taller than 2000px, which would silently skew coordinates.
const MAX_IMAGE_EDGE = Math.min(2000, positiveInt(process.env.PI_MAC_BROWSER_MAX_IMAGE_EDGE, 1920));
const NATIVE_TIMEOUT = 30_000;
const RETRYABLE_BROWSER_ACTIONS = new Set([ACTION_STATUS, "list-tabs", "select-tab"]);

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };
// Maps screenshot pixels onto a global macOS window/display frame in points.
type View = { frame: Rect; width: number; height: number; windowId?: number };
type NativeStatus = {
  accessibility: boolean;
  screenRecording: boolean;
  cursor: Point;
  mainDisplay: Rect;
  displays: Rect[];
  targetDisplay: Rect;
  browserWindow: Rect | null;
  browserWindowId: number | null;
  browserPid: number | null;
  browserWindowOnScreen: boolean;
  browserWindowTitle: string;
  frontmostApp: string;
  frontmostBundleId: string;
};
type ToolState = { trail: Point[]; view?: View };
type SurfaceState = { enabled: boolean };

export default function macosBrowserControl(pi: ExtensionAPI) {
  let helperPromise: Promise<string> | undefined;
  let trail: Point[] = [];
  let view: View | undefined;
  let surfaceEnabled = true;
  let operationQueue: Promise<void> = Promise.resolve();

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function helper(): Promise<string> {
    if (platform() !== PLATFORM_MACOS) throw new Error(MESSAGE_NOT_SUPPORTED);
    if (!helperPromise) {
      helperPromise = (async () => {
        const source = await readFile(SWIFT_SOURCE);
        const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
        const cacheDir = join(homedir(), "Library", "Caches", "pi-macos-browser-control", digest);
        const binary = join(cacheDir, "macos-controller");
        await mkdir(cacheDir, { recursive: true });
        if (!existsSync(binary)) {
          const temp = `${binary}.${process.pid}-${Date.now()}.tmp`;
          const compile = await pi.exec("xcrun", ["swiftc", "-O", SWIFT_SOURCE, "-o", temp], { timeout: 300_000 });
          if (compile.code !== 0) {
            await rm(temp, { force: true });
            throw new Error(`Could not compile native macOS helper: ${compile.stderr.trim() || `swiftc exited ${compile.code}`}`);
          }
          // Atomic rename so concurrent Pi sessions never execute a half-written binary.
          await rename(temp, binary);
        }
        return binary;
      })().catch((error) => {
        helperPromise = undefined;
        throw error;
      });
    }
    return helperPromise;
  }

  async function runNative(args: string[], signal?: AbortSignal, timeout = NATIVE_TIMEOUT): Promise<string> {
    const binary = await helper();
    throwIfAborted(signal);
    const result = await pi.exec(binary, args, { signal, timeout });
    if (result.code !== 0) {
      throwIfAborted(signal);
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Native helper '${args[0]}' failed (exit ${result.code}, timeout ${timeout}ms)`);
    }
    return result.stdout.trim();
  }

  async function nativeStatus(signal?: AbortSignal): Promise<NativeStatus> {
    return JSON.parse(await runNative([ACTION_STATUS, BROWSER_APP], signal)) as NativeStatus;
  }

  async function browser(action: string, args: string[] = [], signal?: AbortSignal): Promise<string> {
    const attempts = RETRYABLE_BROWSER_ACTIONS.has(action) ? 2 : 1;
    for (let attempt = 1; ; attempt++) {
      const result = await pi.exec("osascript", ["-l", "JavaScript", CHROME_SCRIPT, BROWSER_APP, action, ...args], { signal, timeout: 30_000 });
      if (result.code === 0) return result.stdout.trim();
      throwIfAborted(signal);
      if (attempt >= attempts) {
        throw new Error(result.stderr.trim() || `Could not control ${BROWSER_APP}. Allow Automation access when macOS prompts.`);
      }
      await sleep(300, signal);
    }
  }

  function actionView(status: NativeStatus): View {
    const current = view;
    if (!current) {
      if (!status.browserWindow || !status.browserWindowId) throw new Error(MESSAGE_WINDOW_MISSING(BROWSER_APP));
      return viewFor(status.browserWindow, status.browserWindowId);
    }
    if (current.windowId !== undefined) {
      if (status.browserWindowId !== current.windowId || !status.browserWindow) {
        throw new Error(MESSAGE_WINDOW_CHANGED);
      }
      const resized = Math.abs(status.browserWindow.width - current.frame.width) > 1 || Math.abs(status.browserWindow.height - current.frame.height) > 1;
      if (resized) throw new Error(MESSAGE_WINDOW_RESIZED);
      // Preserve screenshot-relative coordinates if the window moved or changed displays.
      return { ...current, frame: status.browserWindow };
    }
    if (!status.displays.some((display) => sameRect(display, current.frame))) {
      throw new Error(MESSAGE_DISPLAY_CHANGED);
    }
    return current;
  }

  function track(point: Point): void {
    const previous = trail.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) trail.push(roundPoint(point));
    if (trail.length > TRAIL_LIMIT) trail = trail.slice(-TRAIL_LIMIT);
  }

  function restoreState(ctx: ExtensionContext): void {
    trail = [];
    view = undefined;
    surfaceEnabled = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === ENTRY_CUSTOM && entry.customType === SURFACE_STATE_KEY) {
        const saved = entry.data as SurfaceState | undefined;
        if (typeof saved?.enabled === "boolean") surfaceEnabled = saved.enabled;
        continue;
      }
      if (entry.type !== ENTRY_MESSAGE || entry.message.role !== ROLE_TOOL_RESULT) continue;
      if (![TOOL_OBSERVE, TOOL_ACT].includes(entry.message.toolName)) continue;
      const saved = entry.message.details as ToolState | undefined;
      if (Array.isArray(saved?.trail)) trail = saved.trail.filter(isPoint).slice(-TRAIL_LIMIT).map(roundPoint);
      if (isView(saved?.view)) view = saved.view;
    }
  }

  function setSurfaceEnabled(enabled: boolean, ctx: ExtensionContext): void {
    surfaceEnabled = enabled;
    pi.appendEntry(SURFACE_STATE_KEY, { enabled });
    updateStatus(ctx, trail.at(-1));
  }

  function updateStatus(ctx: ExtensionContext, point?: Point): void {
    // Stay visually unobtrusive by default. Opt in only for debugging.
    if (!SHOW_STATUS || !ctx.hasUI) return;
    const suffix = point ? ` ${Math.round(point.x)},${Math.round(point.y)}` : "";
    const mode = browserMode(surfaceEnabled);
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(TONE_ACCENT, `🖱 mac browser ${mode}${suffix}`));
  }

  pi.registerTool({
    name: TOOL_OBSERVE,
    label: OBSERVE_LABEL,
    description: OBSERVE_DESCRIPTION,
    promptSnippet: OBSERVE_SNIPPET,
    promptGuidelines: OBSERVE_GUIDELINES,
    parameters: Type.Object({
      delay_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: DESC_CAPTURE_DELAY })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return serial(async () => {
        throwIfAborted(signal);
        onUpdate?.({ content: [{ type: BLOCK_TEXT, text: MESSAGE_CAPTURING }], details: {} });
        const browserInfo = await browser(ACTION_STATUS, [], signal).catch((error) => `browser_status_error=${errorMessage(error)}`);
        await sleep(params.delay_ms ?? ACTION_DELAY, signal);
        const status = await nativeStatus(signal);
        if (!status.screenRecording) {
          throw new Error(MESSAGE_SCREEN_RECORDING);
        }
        if (!status.browserWindow || !status.browserWindowId) {
          throw new Error(MESSAGE_NO_WINDOW(BROWSER_APP));
        }
        const next = viewFor(status.browserWindow, status.browserWindowId);
        const { frame } = next;

        const directory = await mkdtemp(join(tmpdir(), "pi-mac-browser-"));
        const raw = join(directory, "screen.jpg");
        const annotated = join(directory, "screen-tracked.jpg");
        try {
          // -l captures the window's backing surface, not the composited display: no covering apps,
          // desktop, Dock, or focus transition appears in the image. -o removes the window shadow.
          const capture = await pi.exec("screencapture", ["-x", "-o", "-t", "jpg", "-l", `${status.browserWindowId}`, raw], { signal, timeout: 30_000 });
          if (capture.code !== 0 || !existsSync(raw)) throw new Error(capture.stderr.trim() || MESSAGE_CAPTURE_FAILED);
          const encodedTrail = trail.map((point) => `${point.x},${point.y}`).join(";");
          await runNative(["annotate", raw, annotated, encodedTrail, `${frame.x}`, `${frame.y}`, `${frame.width}`, `${frame.height}`, `${next.width}`, `${next.height}`], signal);
          const image = await readFile(annotated);
          view = next;
          const pointer = trail.at(-1);
          updateStatus(ctx, pointer);
          const text = [
            `browser=${BROWSER_APP}`,
            browserInfo,
            `frontmost_app=${status.frontmostApp} (${status.frontmostBundleId})`,
            `capture_mode=direct_window (focus unchanged)`,
            `screenshot=${next.width}x${next.height}px; pass these pixel coordinates directly to mac_browser_act`,
            `browser_window_id=${status.browserWindowId} frame=${frame.width}x${frame.height}pt origin=${frame.x},${frame.y} on_screen=${status.browserWindowOnScreen}`,
            `virtual_cursor=${pointer ? describeCursor(next, pointer) : "unset"}`,
            `physical_cursor_ignored=true`,
            `trail_points=${trail.length}`,
            `accessibility=${status.accessibility} screen_recording=${status.screenRecording}`,
          ].filter(Boolean).join(NEWLINE);
          return {
            content: [
              { type: BLOCK_TEXT, text },
              { type: BLOCK_IMAGE, data: image.toString(ENCODING_BASE64), mimeType: MIME_IMAGE },
            ],
            details: { trail: [...trail], view: next, status, browser: BROWSER_APP },
          };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    },
  });

  pi.registerTool({
    name: TOOL_ACT,
    label: ACT_LABEL,
    description: ACT_DESCRIPTION,
    promptSnippet: ACT_SNIPPET,
    promptGuidelines: ACT_GUIDELINES,
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      x: Type.Optional(Type.Number({ description: DESC_X })),
      y: Type.Optional(Type.Number({ description: DESC_Y })),
      target_x: Type.Optional(Type.Number({ description: DESC_TARGET_X })),
      target_y: Type.Optional(Type.Number({ description: DESC_TARGET_Y })),
      delta_x: Type.Optional(Type.Number({ description: DESC_DELTA_X })),
      delta_y: Type.Optional(Type.Number({ description: DESC_DELTA_Y })),
      text: Type.Optional(Type.String({ description: DESC_TEXT })),
      key: Type.Optional(Type.String({ description: DESC_KEY })),
      modifiers: Type.Optional(Type.Array(StringEnum(MODIFIERS), { description: DESC_MODIFIERS })),
      duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: DESC_DURATION })),
      interval_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000, description: DESC_INTERVAL })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000, description: DESC_WAIT })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return serial(async () => {
        throwIfAborted(signal);
        const duration = params.duration_ms ?? MOVE_DURATION;
        let summary = `Completed ${params.action}`;
        let status = await nativeStatus(signal);
        const sendsInput = params.action !== ACTION_WAIT && params.action !== ACTION_RESET_TRAIL;
        if (sendsInput && !surfaceEnabled) {
          throw new Error(MESSAGE_DISABLED);
        }
        if (sendsInput && !status.accessibility) {
          throw new Error(MESSAGE_ACCESSIBILITY);
        }
        // Hard safety boundary: input can only be posted directly to the browser PID. There is no
        // model-accessible path to activation, the shared HID tap, or the user's keyboard/pointer.
        if (sendsInput && !status.browserPid) {
          throw new Error(MESSAGE_NOT_RUNNING(BROWSER_APP));
        }
        const pid = sendsInput ? status.browserPid ?? undefined : undefined;
        const send = (args: string[], timeout?: number) => {
          if (pid === undefined) throw new Error(MESSAGE_NO_PID);
          return runNative([...args, "--pid", `${pid}`], signal, timeout);
        };
        const current = sendsInput ? actionView(status) : view;
        try {
          switch (params.action) {
          case ACTION_MOVE: {
            const point = screenPoint(current!, params.x, params.y, "move");
            await send(["move", `${point.x}`, `${point.y}`, `${duration}`], duration + NATIVE_TIMEOUT);
            track(point);
            break;
          }
          case ACTION_CLICK:
          case ACTION_FOCUS_CLICK:
          case ACTION_DOUBLE_CLICK:
          case ACTION_RIGHT_CLICK: {
            const point = screenPoint(current!, params.x, params.y, params.action);
            const button = params.action === ACTION_RIGHT_CLICK ? "right" : "left";
            const count = params.action === ACTION_DOUBLE_CLICK ? "2" : "1";
            if (params.action === ACTION_FOCUS_CLICK) {
              const activation = await browser("activate", [], signal);
              if (!activation.includes("activated=true")) throw new Error(`Could not focus ${BROWSER_APP}: ${activation}`);
              await sleep(150, signal);
              await runNative(["foreground-click", `${point.x}`, `${point.y}`, button, count, `${duration}`], signal, duration + NATIVE_TIMEOUT);
            } else {
              await send(["click", `${point.x}`, `${point.y}`, button, count, `${duration}`], duration + NATIVE_TIMEOUT);
            }
            track(point);
            break;
          }
          case ACTION_DRAG: {
            const start = screenPoint(current!, params.x, params.y, "drag start");
            const target = screenPoint(current!, params.target_x, params.target_y, "drag destination");
            try {
              await send(["drag", `${start.x}`, `${start.y}`, `${target.x}`, `${target.y}`, "left", `${duration}`], duration + NATIVE_TIMEOUT);
            } catch (error) {
              // An interrupted drag would otherwise leave the left button held down in the target.
              await runNative(["release", "left", "--pid", `${pid}`]).catch(() => undefined);
              throw error;
            }
            track(start); track(target);
            break;
          }
          case ACTION_SCROLL: {
            let at: Point | undefined;
            if (params.x !== undefined || params.y !== undefined) at = screenPoint(current!, params.x, params.y, "scroll");
            // Background scrolls must carry an explicit location: the helper is a fresh process with
            // no synthetic pointer yet, and the real cursor belongs to the user.
            else if (pid !== undefined && status.browserWindow) {
              const last = trail.at(-1);
              at = last && contains(status.browserWindow, last) ? last : center(status.browserWindow);
            }
            // Foreground scroll events go to whatever is under the pointer, so keep it over the browser.
            else if (status.browserWindow && !contains(status.browserWindow, status.cursor)) at = center(status.browserWindow);
            const args = ["scroll", `${params.delta_x ?? 0}`, `${params.delta_y ?? -600}`];
            if (at) args.push(`${at.x}`, `${at.y}`, `${Math.min(duration, 200)}`);
            await send(args);
            if (at) track(at);
            break;
          }
          case ACTION_TYPE: {
            if (params.text === undefined) throw new Error(MESSAGE_TYPE_REQUIRES_TEXT);
            const interval = params.interval_ms ?? 12;
            await send(["type", params.text, `${interval}`], params.text.length * (interval + 10) + NATIVE_TIMEOUT);
            summary += ` (${params.text.length} characters)`;
            break;
          }
          case ACTION_KEY:
            if (!params.key) throw new Error(MESSAGE_KEY_REQUIRES_KEY);
            await send(["key", params.key, (params.modifiers ?? []).join(",")]);
            break;
          case ACTION_WAIT:
            await sleep(params.wait_ms ?? 1_000, signal);
            break;
          case ACTION_RESET_TRAIL:
            trail = [];
            break;
          }
          if (sendsInput) await sleep(ACTION_DELAY, signal);
        } finally {
          // No focus or foreground state exists to restore: background PID delivery is mandatory.
        }
        status = await nativeStatus(signal);
        // Never read the user's physical cursor into automation state.
        const pointer = trail.at(-1);
        updateStatus(ctx, pointer);
        const reported = current ?? viewFor(status.targetDisplay);
        const text = [
          summary,
          `input_mode=${params.action === ACTION_FOCUS_CLICK ? "foreground_hid" : sendsInput ? "background_pid" : "none"}`,
          `virtual_cursor=${pointer ? describeCursor(reported, pointer) : "unset"}`,
          `physical_cursor_ignored=${params.action === ACTION_FOCUS_CLICK ? "false" : "true"}`,
          `frontmost_app=${status.frontmostApp}`,
          `browser_activation_possible=${params.action === ACTION_FOCUS_CLICK ? "true" : "false"}`,
          `trail_points=${trail.length}`,
        ].join(NEWLINE);
        return {
          content: [{ type: BLOCK_TEXT, text }],
          details: { trail: [...trail], view, status, action: params.action },
        };
      });
    },
  });

  pi.registerTool({
    name: TOOL_SURFACE,
    label: SURFACE_LABEL,
    description: SURFACE_DESCRIPTION,
    promptSnippet: SURFACE_SNIPPET,
    parameters: Type.Object({
      action: StringEnum(SURFACE_ACTIONS),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return serial(async () => {
        if (params.action === ACTION_ON) setSurfaceEnabled(true, ctx);
        else if (params.action === ACTION_OFF) setSurfaceEnabled(false, ctx);
        else if (params.action === ACTION_TOGGLE) setSurfaceEnabled(!surfaceEnabled, ctx);
        return {
          content: [{ type: BLOCK_TEXT, text: MESSAGE_SURFACE(surfaceEnabled) }],
          details: { enabled: surfaceEnabled, action: params.action },
        };
      });
    },
  });

  pi.registerTool({
    name: TOOL_TABS,
    label: TABS_LABEL,
    description: tabsDescription(BROWSER_APP),
    promptSnippet: TABS_SNIPPET,
    parameters: Type.Object({
      action: StringEnum(TAB_ACTIONS),
      url: Type.Optional(Type.String({ description: DESC_URL })),
      window_index: Type.Optional(Type.Integer({ minimum: 1, description: DESC_WINDOW })),
      tab_index: Type.Optional(Type.Integer({ minimum: 1, description: DESC_TAB })),
    }),
    async execute(_id, params, signal) {
      return serial(async () => {
        let output: string;
        if (params.action === ACTION_OPEN || params.action === ACTION_NEW_TAB) {
          const url = validatedUrl(params.url);
          output = await browser(params.action === ACTION_NEW_TAB ? "new-tab" : ACTION_OPEN, [url], signal);
        } else if (params.action === ACTION_SELECT_TAB || params.action === ACTION_CLOSE_TAB) {
          if (!params.window_index || !params.tab_index) throw new Error(`${params.action} requires window_index and tab_index`);
          output = await browser(params.action === ACTION_SELECT_TAB ? "select-tab" : "close-tab", [`${params.window_index}`, `${params.tab_index}`], signal);
        } else {
          output = await browser(params.action === ACTION_LIST_TABS ? "list-tabs" : ACTION_STATUS, [], signal);
        }
        return { content: [{ type: BLOCK_TEXT, text: truncate(output, 32 * 1024) }], details: { browser: BROWSER_APP, action: params.action } };
      });
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      try {
        const input = args.trim();
        const surfaceMatch = input.match(/^surface(?:\s+(on|off|toggle|status))?$/);
        if (surfaceMatch) {
          const action = surfaceMatch[1] ?? ACTION_STATUS;
          if (action === ACTION_ON) setSurfaceEnabled(true, ctx);
          else if (action === ACTION_OFF) setSurfaceEnabled(false, ctx);
          else if (action === ACTION_TOGGLE) setSurfaceEnabled(!surfaceEnabled, ctx);
          ctx.ui.notify(MESSAGE_SURFACE_STATUS(surfaceEnabled), NOTE_INFO);
        } else if (input === "permissions") {
          const result = JSON.parse(await runNative(["request-permissions"]));
          ctx.ui.notify(MESSAGE_PERMISSION_STATUS(result.accessibility, result.screenRecording), NOTE_INFO);
        } else if (input === "reset") {
          trail = [];
          ctx.ui.notify(MESSAGE_RESET, NOTE_INFO);
        } else if (input.startsWith("open ")) {
          const url = validatedUrl(input.slice(5).trim());
          ctx.ui.notify(await browser(ACTION_OPEN, [url]), NOTE_INFO);
        } else {
          const status = await nativeStatus();
          const browserInfo = await browser(ACTION_STATUS).catch((error) => errorMessage(error));
          updateStatus(ctx, status.cursor);
          ctx.ui.notify(MESSAGE_APP_STATUS(surfaceEnabled, status, browserInfo), NOTE_INFO);
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), NOTE_ERROR);
      }
    },
  });

  pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => {
    restoreState(ctx);
    if (platform() === PLATFORM_MACOS) {
      updateStatus(ctx, trail.at(-1));
      // Compile the helper in the background so the first tool call does not wait on swiftc.
      helper().catch(() => undefined);
    } else ctx.ui.notify(MESSAGE_NOT_MACOS, NOTE_WARNING);
  });

  pi.on(PI_EVENT.SESSION_TREE, async (_event, ctx) => restoreState(ctx));
  pi.on(PI_EVENT.SESSION_SHUTDOWN, async (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));
}

function viewFor(frame: Rect, windowId?: number): View {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(frame.width, frame.height));
  return { frame, width: Math.max(1, Math.round(frame.width * scale)), height: Math.max(1, Math.round(frame.height * scale)), ...(windowId === undefined ? {} : { windowId }) };
}

function screenPoint(view: View, x: number | undefined, y: number | undefined, label: string): Point {
  const point = requiredPoint(x, y, label);
  if (point.x < 0 || point.y < 0 || point.x > view.width || point.y > view.height) {
    throw new Error(MESSAGE_OUT_OF_BOUNDS(label, point, view));
  }
  return {
    x: view.frame.x + (point.x * view.frame.width) / view.width,
    y: view.frame.y + (point.y * view.frame.height) / view.height,
  };
}

function imagePoint(view: View, point: Point): Point {
  return {
    x: Math.round(((point.x - view.frame.x) * view.width) / view.frame.width),
    y: Math.round(((point.y - view.frame.y) * view.height) / view.frame.height),
  };
}

function imageRect(view: View, rect: Rect): Rect {
  const origin = imagePoint(view, rect);
  const end = imagePoint(view, { x: rect.x + rect.width, y: rect.y + rect.height });
  return { x: origin.x, y: origin.y, width: end.x - origin.x, height: end.y - origin.y };
}

function describeCursor(view: View, cursor: Point): string {
  if (!contains(view.frame, cursor)) return MESSAGE_OUTSIDE;
  const point = imagePoint(view, cursor);
  return `${point.x},${point.y}`;
}

function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

function requiredPoint(x: number | undefined, y: number | undefined, label: string): Point {
  if (x === undefined || y === undefined) throw new Error(MESSAGE_COORDINATES(label));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(MESSAGE_NONFINITE(label));
  return { x, y };
}

function validatedUrl(value: string | undefined): string {
  if (!value) throw new Error(MESSAGE_NO_URL);
  if (value === URL_BLANK) return value;
  const parsed = new URL(value);
  if (!URL_PROTOCOLS.includes(parsed.protocol)) throw new Error(MESSAGE_URL_PROTOCOL);
  return parsed.href;
}

function isPoint(value: unknown): value is Point {
  return Boolean(value && typeof value === "object" && Number.isFinite((value as Point).x) && Number.isFinite((value as Point).y));
}

function isView(value: unknown): value is View {
  if (!value || typeof value !== "object") return false;
  const candidate = value as View;
  return isPoint(candidate.frame) && candidate.frame.width > 0 && candidate.frame.height > 0 && candidate.width > 0 && candidate.height > 0 && (candidate.windowId === undefined || Number.isInteger(candidate.windowId));
}

function roundPoint(point: Point): Point {
  return { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
}

function detectBrowserApp(): string {
  const configured = process.env.PI_MAC_BROWSER_APP?.trim();
  if (configured) return configured;
  const candidates: Array<[string, string]> = [
    ["Google Chrome", "/Applications/Google Chrome.app"],
    ["Brave Browser", "/Applications/Brave Browser.app"],
    ["Microsoft Edge", "/Applications/Microsoft Edge.app"],
    ["Chromium", "/Applications/Chromium.app"],
  ];
  return candidates.find(([, appPath]) => existsSync(appPath))?.[0] ?? "Google Chrome";
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function truncate(text: string, maxBytes: number): string {
  const data = Buffer.from(text);
  return data.length <= maxBytes ? text : data.subarray(0, maxBytes).toString(ENCODING_UTF8) + MESSAGE_TRUNCATED;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(MESSAGE_ABORTED);
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error(MESSAGE_ABORTED));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolveSleep();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
