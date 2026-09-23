import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SWIFT_SOURCE = join(ROOT, "native", "macos-controller.swift");
const CHROME_SCRIPT = join(ROOT, "native", "chrome-control.js");
const BROWSER_APP = detectBrowserApp();
const MOVE_DURATION = positiveInt(process.env.PI_MAC_BROWSER_MOVE_MS, 260);
const ACTION_DELAY = positiveInt(process.env.PI_MAC_BROWSER_ACTION_DELAY_MS, 250);
const TRAIL_LIMIT = positiveInt(process.env.PI_MAC_BROWSER_TRAIL_LENGTH, 24);
const SHOW_STATUS = process.env.PI_MAC_BROWSER_SHOW_STATUS === "1";
// Pi downscales images wider/taller than 2000px, which would silently skew coordinates.
const MAX_IMAGE_EDGE = Math.min(2000, positiveInt(process.env.PI_MAC_BROWSER_MAX_IMAGE_EDGE, 1920));
const NATIVE_TIMEOUT = 30_000;
const RETRYABLE_BROWSER_ACTIONS = new Set(["status", "list-tabs", "select-tab"]);

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

export default function macosBrowserControl(pi: ExtensionAPI) {
  let helperPromise: Promise<string> | undefined;
  let trail: Point[] = [];
  let view: View | undefined;
  let operationQueue: Promise<void> = Promise.resolve();

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function helper(): Promise<string> {
    if (platform() !== "darwin") throw new Error("mac_browser tools currently support macOS only");
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
    return JSON.parse(await runNative(["status", BROWSER_APP], signal)) as NativeStatus;
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
      if (!status.browserWindow || !status.browserWindowId) throw new Error(`No ${BROWSER_APP} window found; call mac_browser_observe again`);
      return viewFor(status.browserWindow, status.browserWindowId);
    }
    if (current.windowId !== undefined) {
      if (status.browserWindowId !== current.windowId || !status.browserWindow) {
        throw new Error("The observed browser window changed; call mac_browser_observe again");
      }
      const resized = Math.abs(status.browserWindow.width - current.frame.width) > 1 || Math.abs(status.browserWindow.height - current.frame.height) > 1;
      if (resized) throw new Error("The browser window was resized since the last observation; call mac_browser_observe again");
      // Preserve screenshot-relative coordinates if the window moved or changed displays.
      return { ...current, frame: status.browserWindow };
    }
    if (!status.displays.some((display) => sameRect(display, current.frame))) {
      throw new Error("Display layout changed since the last observation; call mac_browser_observe again");
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
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      if (!["mac_browser_observe", "mac_browser_act"].includes(entry.message.toolName)) continue;
      const saved = entry.message.details as ToolState | undefined;
      if (Array.isArray(saved?.trail)) trail = saved.trail.filter(isPoint).slice(-TRAIL_LIMIT).map(roundPoint);
      if (isView(saved?.view)) view = saved.view;
    }
  }

  function updateStatus(ctx: ExtensionContext, point?: Point): void {
    // Stay visually unobtrusive by default. Opt in only for debugging.
    if (!SHOW_STATUS || !ctx.hasUI) return;
    const suffix = point ? ` ${Math.round(point.x)},${Math.round(point.y)}` : "";
    ctx.ui.setStatus("mac-browser", ctx.ui.theme.fg("accent", `🖱 mac browser${suffix}`));
  }

  pi.registerTool({
    name: "mac_browser_observe",
    label: "Observe Mac Browser",
    description:
      "Capture the browser window directly without focusing it, even when covered, minimized, on another display, or on another Space. " +
      "Pixel coordinates in this screenshot are the coordinates mac_browser_act expects. Requires Screen Recording permission.",
    promptSnippet: "See the native macOS browser and tracked mouse position",
    promptGuidelines: [
      "Use mac_browser_observe before mac_browser_act when a click target or current browser state is uncertain.",
      "After mac_browser_act changes the UI, use mac_browser_observe again before another uncertain coordinate action.",
    ],
    parameters: Type.Object({
      delay_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "Delay before capture; defaults to 250ms" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return serial(async () => {
        throwIfAborted(signal);
        onUpdate?.({ content: [{ type: "text", text: "Capturing the macOS browser…" }], details: {} });
        const browserInfo = await browser("status", [], signal).catch((error) => `browser_status_error=${errorMessage(error)}`);
        await sleep(params.delay_ms ?? ACTION_DELAY, signal);
        const status = await nativeStatus(signal);
        if (!status.screenRecording) {
          throw new Error("Screen Recording permission is required. Run /mac-browser permissions, then enable your terminal or Pi in System Settings > Privacy & Security > Screen Recording.");
        }
        if (!status.browserWindow || !status.browserWindowId) {
          throw new Error(`${BROWSER_APP} has no capturable window. Open a browser window and try again.`);
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
          if (capture.code !== 0 || !existsSync(raw)) throw new Error(capture.stderr.trim() || "macOS screen capture failed");
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
          ].filter(Boolean).join("\n");
          return {
            content: [
              { type: "text" as const, text },
              { type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" },
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
    name: "mac_browser_act",
    label: "Act on Mac Browser",
    description:
      "Send mouse and keyboard events to the browser with native Quartz events. Actions: move, click, double_click, right_click, drag, scroll, type, key, wait, reset_trail. " +
      "Coordinates are pixels in the latest mac_browser_observe screenshot. Input is delivered directly to the browser process in the background: this tool cannot activate the browser, use system-wide input, move the user's physical pointer, or interrupt the user's work. Requires Accessibility permission.",
    promptSnippet: "Click/type into the background browser without touching the user's focus or pointer",
    promptGuidelines: [
      "Use mac_browser_act only after mac_browser_observe provides a fresh view when coordinate targets are uncertain.",
      "This tool is background-only. Never activate or focus the browser; use mac_browser_tabs with a search URL when Chromium rejects background typing.",
      "Before mac_browser_act submits credentials, purchases, messages, publications, deletions, or other consequential changes, obtain explicit user confirmation.",
    ],
    parameters: Type.Object({
      action: StringEnum(["move", "click", "double_click", "right_click", "drag", "scroll", "type", "key", "wait", "reset_trail"] as const),
      x: Type.Optional(Type.Number({ description: "Screenshot x pixel (also the scroll position)" })),
      y: Type.Optional(Type.Number({ description: "Screenshot y pixel (also the scroll position)" })),
      target_x: Type.Optional(Type.Number({ description: "Drag destination screenshot x pixel" })),
      target_y: Type.Optional(Type.Number({ description: "Drag destination screenshot y pixel" })),
      delta_x: Type.Optional(Type.Number({ description: "Horizontal scroll amount in pixels" })),
      delta_y: Type.Optional(Type.Number({ description: "Vertical scroll amount in pixels; positive scrolls up" })),
      text: Type.Optional(Type.String({ description: "Literal text for the type action; newlines press Enter" })),
      key: Type.Optional(Type.String({ description: "Key name, e.g. enter, tab, escape, left, backspace, f5, a, or 1" })),
      modifiers: Type.Optional(Type.Array(StringEnum(["command", "shift", "option", "control"] as const), { description: "Modifiers for key" })),
      duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "Smooth move/drag duration" })),
      interval_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000, description: "Delay between typed characters" })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000, description: "Wait action duration" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return serial(async () => {
        throwIfAborted(signal);
        const duration = params.duration_ms ?? MOVE_DURATION;
        let summary = `Completed ${params.action}`;
        let status = await nativeStatus(signal);
        const sendsInput = params.action !== "wait" && params.action !== "reset_trail";
        if (sendsInput && !status.accessibility) {
          throw new Error("Accessibility permission is required. Run /mac-browser permissions, then enable your terminal or Pi in System Settings > Privacy & Security > Accessibility.");
        }
        // Hard safety boundary: input can only be posted directly to the browser PID. There is no
        // model-accessible path to activation, the shared HID tap, or the user's keyboard/pointer.
        if (sendsInput && !status.browserPid) {
          throw new Error(`${BROWSER_APP} is not running; open a browser window and try again.`);
        }
        const pid = sendsInput ? status.browserPid ?? undefined : undefined;
        const send = (args: string[], timeout?: number) => {
          if (pid === undefined) throw new Error("Background browser PID is unavailable");
          return runNative([...args, "--pid", `${pid}`], signal, timeout);
        };
        const current = sendsInput ? actionView(status) : view;
        try {
          switch (params.action) {
          case "move": {
            const point = screenPoint(current!, params.x, params.y, "move");
            await send(["move", `${point.x}`, `${point.y}`, `${duration}`], duration + NATIVE_TIMEOUT);
            track(point);
            break;
          }
          case "click":
          case "double_click":
          case "right_click": {
            const point = screenPoint(current!, params.x, params.y, params.action);
            const button = params.action === "right_click" ? "right" : "left";
            const count = params.action === "double_click" ? "2" : "1";
            await send(["click", `${point.x}`, `${point.y}`, button, count, `${duration}`], duration + NATIVE_TIMEOUT);
            track(point);
            break;
          }
          case "drag": {
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
          case "scroll": {
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
          case "type": {
            if (params.text === undefined) throw new Error("type requires text");
            const interval = params.interval_ms ?? 12;
            await send(["type", params.text, `${interval}`], params.text.length * (interval + 10) + NATIVE_TIMEOUT);
            summary += ` (${params.text.length} characters)`;
            break;
          }
          case "key":
            if (!params.key) throw new Error("key requires key");
            await send(["key", params.key, (params.modifiers ?? []).join(",")]);
            break;
          case "wait":
            await sleep(params.wait_ms ?? 1_000, signal);
            break;
          case "reset_trail":
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
          `input_mode=${sendsInput ? "background_pid" : "none"}`,
          `virtual_cursor=${pointer ? describeCursor(reported, pointer) : "unset"}`,
          `physical_cursor_ignored=true`,
          `frontmost_app=${status.frontmostApp}`,
          `browser_activation_possible=false`,
          `trail_points=${trail.length}`,
        ].join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { trail: [...trail], view, status, action: params.action },
        };
      });
    },
  });

  pi.registerTool({
    name: "mac_browser_tabs",
    label: "Mac Browser Tabs",
    description: `Control ${BROWSER_APP} tabs through native macOS Automation. Actions: status, open, new_tab, list_tabs, select_tab, close_tab. open/new_tab wait up to 10s for the page to load.`,
    promptSnippet: "Open URLs and list/select/close native Chrome-compatible tabs",
    parameters: Type.Object({
      action: StringEnum(["status", "open", "new_tab", "list_tabs", "select_tab", "close_tab"] as const),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL or about:blank for open/new_tab" })),
      window_index: Type.Optional(Type.Integer({ minimum: 1, description: "1-based browser window index" })),
      tab_index: Type.Optional(Type.Integer({ minimum: 1, description: "1-based tab index" })),
    }),
    async execute(_id, params, signal) {
      return serial(async () => {
        let output: string;
        if (params.action === "open" || params.action === "new_tab") {
          const url = validatedUrl(params.url);
          output = await browser(params.action === "new_tab" ? "new-tab" : "open", [url], signal);
        } else if (params.action === "select_tab" || params.action === "close_tab") {
          if (!params.window_index || !params.tab_index) throw new Error(`${params.action} requires window_index and tab_index`);
          output = await browser(params.action === "select_tab" ? "select-tab" : "close-tab", [`${params.window_index}`, `${params.tab_index}`], signal);
        } else {
          output = await browser(params.action === "list_tabs" ? "list-tabs" : "status", [], signal);
        }
        return { content: [{ type: "text" as const, text: truncate(output, 32 * 1024) }], details: { browser: BROWSER_APP, action: params.action } };
      });
    },
  });

  pi.registerCommand("mac-browser", {
    description: "Show status, request permissions, reset mouse trail, or open URL",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();
        if (input === "permissions") {
          const result = JSON.parse(await runNative(["request-permissions"]));
          ctx.ui.notify(`Accessibility: ${result.accessibility}; Screen Recording: ${result.screenRecording}. Restart Pi after granting access.`, "info");
        } else if (input === "reset") {
          trail = [];
          ctx.ui.notify("macOS browser mouse trail reset", "info");
        } else if (input.startsWith("open ")) {
          const url = validatedUrl(input.slice(5).trim());
          ctx.ui.notify(await browser("open", [url]), "info");
        } else {
          const status = await nativeStatus();
          const browserInfo = await browser("status").catch((error) => errorMessage(error));
          updateStatus(ctx, status.cursor);
          ctx.ui.notify(`Accessibility: ${status.accessibility}; Screen Recording: ${status.screenRecording}; Cursor: ${Math.round(status.cursor.x)},${Math.round(status.cursor.y)}\n${browserInfo}`, "info");
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx);
    if (platform() === "darwin") {
      updateStatus(ctx, trail.at(-1));
      // Compile the helper in the background so the first tool call does not wait on swiftc.
      helper().catch(() => undefined);
    } else ctx.ui.notify("macOS browser control loaded, but this backend currently requires macOS", "warning");
  });

  pi.on("session_tree", async (_event, ctx) => restoreState(ctx));
  pi.on("session_shutdown", async (_event, ctx) => ctx.ui.setStatus("mac-browser", undefined));
}

function viewFor(frame: Rect, windowId?: number): View {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(frame.width, frame.height));
  return { frame, width: Math.max(1, Math.round(frame.width * scale)), height: Math.max(1, Math.round(frame.height * scale)), ...(windowId === undefined ? {} : { windowId }) };
}

function screenPoint(view: View, x: number | undefined, y: number | undefined, label: string): Point {
  const point = requiredPoint(x, y, label);
  if (point.x < 0 || point.y < 0 || point.x > view.width || point.y > view.height) {
    throw new Error(`${label} (${point.x},${point.y}) is outside the ${view.width}x${view.height} screenshot`);
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
  if (!contains(view.frame, cursor)) return "outside screenshot";
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
  if (x === undefined || y === undefined) throw new Error(`${label} requires x and y`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label} coordinates must be finite`);
  return { x, y };
}

function validatedUrl(value: string | undefined): string {
  if (!value) throw new Error("This action requires url");
  if (value === "about:blank") return value;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Only http://, https://, and about:blank URLs are allowed");
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
  return data.length <= maxBytes ? text : data.subarray(0, maxBytes).toString("utf8") + "\n[Output truncated at 32KB]";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
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
