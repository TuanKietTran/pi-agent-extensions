import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { chromium, type Browser, type Download, type Locator, type Page } from "playwright-core";

const CDP_URL = process.env.PI_WEB_UI_CDP_URL?.trim();
const START_URL = process.env.PI_WEB_UI_URL?.trim() || "about:blank";
const HEADLESS = /^(1|true|yes)$/i.test(process.env.PI_WEB_UI_HEADLESS ?? "");
const ACTION_TIMEOUT = positiveInt(process.env.PI_WEB_UI_TIMEOUT_MS, 15_000);
const MAX_ELEMENTS = positiveInt(process.env.PI_WEB_UI_MAX_ELEMENTS, 200);
const MAX_SNAPSHOT_BYTES = 32 * 1024;

type DownloadArtifact = {
  suggestedFilename: string;
  url: string;
  path?: string;
  failure?: string;
};

type ElementSummary = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  value?: string;
  disabled: boolean;
  checked?: boolean;
  rect: { x: number; y: number; width: number; height: number };
};

export default function webUiVision(pi: ExtensionAPI) {
  let browser: Browser | undefined;
  let activePage: Page | undefined;
  let ownsBrowser = false;
  let nextPageId = 1;
  const pageIds = new WeakMap<Page, string>();

  function pageId(page: Page): string {
    let id = pageIds.get(page);
    if (!id) {
      id = `p${nextPageId++}`;
      pageIds.set(page, id);
    }
    return id;
  }

  function allPages(): Page[] {
    return browser?.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed()) ?? [];
  }

  async function ensureBrowser(): Promise<Browser> {
    if (browser?.isConnected()) return browser;

    if (CDP_URL) {
      browser = await chromium.connectOverCDP(CDP_URL, { timeout: ACTION_TIMEOUT });
      ownsBrowser = false;
    } else {
      const executablePath = findBrowserExecutable();
      if (!executablePath) {
        throw new Error(
          "No Chromium browser found. Set PI_WEB_UI_EXECUTABLE_PATH, or start Chrome with " +
          "--remote-debugging-port=9222 and set PI_WEB_UI_CDP_URL=http://127.0.0.1:9222.",
        );
      }
      browser = await chromium.launch({ executablePath, headless: HEADLESS });
      ownsBrowser = true;
    }

    browser.on("disconnected", () => {
      browser = undefined;
      activePage = undefined;
      ownsBrowser = false;
    });
    return browser;
  }

  async function getPage(): Promise<Page> {
    const connected = await ensureBrowser();
    if (activePage && !activePage.isClosed()) return activePage;

    const pages = allPages();
    activePage = pages.at(-1) ?? await connected.newPage();
    if (activePage.url() === "about:blank" && START_URL !== "about:blank") {
      await activePage.goto(START_URL, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT });
    }
    return activePage;
  }

  pi.registerTool({
    name: "web_ui_pages",
    label: "Web UI Pages",
    description: "List, select, create, or close browser tabs used by the web UI vision tools.",
    promptSnippet: "List and select browser tabs for web UI interaction",
    parameters: Type.Object({
      action: StringEnum(["list", "select", "new", "close"] as const),
      page_id: Type.Optional(Type.String({ description: "Page ID returned by this tool" })),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL for a new page" })),
    }),
    async execute(_id, params, signal) {
      throwIfAborted(signal);
      await ensureBrowser();

      if (params.action === "new") {
        // Chromium's default context cannot create a page. browser.newPage()
        // creates a fresh usable context for an extension-owned browser.
        if (ownsBrowser) {
          activePage = await browser!.newPage();
        } else {
          const context = activePage?.context() ?? browser!.contexts()[0] ?? await browser!.newContext();
          activePage = await context.newPage();
        }
        if (params.url) await navigate(activePage, params.url);
      } else if (params.action === "select") {
        const selected = allPages().find((page) => pageId(page) === params.page_id);
        if (!selected) throw new Error(`Unknown page_id: ${params.page_id ?? "(missing)"}`);
        activePage = selected;
        await selected.bringToFront();
      } else if (params.action === "close") {
        const selected = params.page_id
          ? allPages().find((page) => pageId(page) === params.page_id)
          : activePage;
        if (!selected) throw new Error(`Unknown page_id: ${params.page_id ?? "(no active page)"}`);
        await selected.close();
        if (selected === activePage) activePage = undefined;
      }

      const pages = allPages();
      if (!activePage && pages.length > 0) activePage = pages.at(-1);
      return textResult(formatPages(pages, activePage, pageId));
    },
  });

  pi.registerTool({
    name: "web_ui_open",
    label: "Open Web UI",
    description: "Open an HTTP(S) URL in the active browser tab and return its title and final URL.",
    promptSnippet: "Open a URL in the controlled web UI",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http:// or https:// URL, or about:blank" }),
    }),
    async execute(_id, params, signal) {
      throwIfAborted(signal);
      const page = await getPage();
      await navigate(page, params.url);
      return textResult(`Opened ${await page.title()}\n${page.url()}\npage_id=${pageId(page)}`);
    },
  });

  pi.registerTool({
    name: "web_ui_observe",
    label: "Observe Web UI",
    description:
      "Capture the active web UI as an image and return a compact list of visible interactive elements. " +
      "Element refs remain usable by web_ui_act until the page rerenders. Output is capped at 200 elements and 32KB.",
    promptSnippet: "Capture a browser screenshot and inspect visible interactive elements",
    promptGuidelines: [
      "Use web_ui_observe before web_ui_act when the current page state or target is uncertain.",
      "After a web_ui_act operation that changes the page, use web_ui_observe again before the next uncertain action.",
    ],
    parameters: Type.Object({
      full_page: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page; defaults to false" })),
      image_format: Type.Optional(StringEnum(["jpeg", "png"] as const)),
    }),
    async execute(_id, params, signal) {
      throwIfAborted(signal);
      const page = await getPage();
      await page.waitForTimeout(100);
      const elements = await annotateInteractiveElements(page, MAX_ELEMENTS);
      const format = params.image_format ?? "jpeg";
      const screenshot = await page.screenshot({
        type: format,
        fullPage: params.full_page ?? false,
        ...(format === "jpeg" ? { quality: 78 } : {}),
      });
      throwIfAborted(signal);

      const header = [
        `page_id=${pageId(page)}`,
        `title=${await page.title()}`,
        `url=${page.url()}`,
        `viewport=${await viewportText(page)}`,
        `interactive_elements=${elements.length}`,
        "",
      ].join("\n");
      const snapshot = truncateUtf8(header + elements.map(formatElement).join("\n"), MAX_SNAPSHOT_BYTES);
      return {
        content: [
          { type: "text" as const, text: snapshot },
          { type: "image" as const, data: screenshot.toString("base64"), mimeType: `image/${format}` },
        ],
        details: { pageId: pageId(page), url: page.url(), elementCount: elements.length },
      };
    },
  });

  pi.registerTool({
    name: "web_ui_act",
    label: "Act on Web UI",
    description:
      "Interact with the active web UI by element ref, Playwright selector, visible text, role/name, or viewport coordinates. " +
      "Supported actions: click, double_click, drag, fill, type, press, hover, select, check, uncheck, scroll, and wait. " +
      "Set expect_download for download-producing actions to return artifact metadata.",
    promptSnippet: "Click, drag, type, select, scroll, or press keys in the controlled web UI",
    parameters: Type.Object({
      action: StringEnum([
        "click", "double_click", "drag", "fill", "type", "press", "hover", "select", "check", "uncheck", "scroll", "wait",
      ] as const),
      ref: Type.Optional(Type.String({ description: "Element ref from web_ui_observe, such as e12" })),
      selector: Type.Optional(Type.String({ description: "Playwright/CSS selector" })),
      text: Type.Optional(Type.String({ description: "Exact visible text used to locate an element" })),
      role: Type.Optional(Type.String({ description: "ARIA role such as button, textbox, link, or checkbox" })),
      name: Type.Optional(Type.String({ description: "Accessible name used with role" })),
      x: Type.Optional(Type.Number({ description: "Viewport x coordinate for pointer actions or drag start" })),
      y: Type.Optional(Type.Number({ description: "Viewport y coordinate for pointer actions or drag start" })),
      target_x: Type.Optional(Type.Number({ description: "Absolute viewport x coordinate for the drag destination" })),
      target_y: Type.Optional(Type.Number({ description: "Absolute viewport y coordinate for the drag destination" })),
      value: Type.Optional(Type.String({ description: "Text to fill/type, option value to select, or key to press" })),
      delta_x: Type.Optional(Type.Number({ description: "Horizontal pixels for scroll, or horizontal drag distance" })),
      delta_y: Type.Optional(Type.Number({ description: "Vertical pixels for scroll, or vertical drag distance" })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Intermediate pointer moves during drag; defaults to 10" })),
      expect_download: Type.Optional(Type.Boolean({ description: "Wait for a download and include artifact metadata in the result" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Wait duration, action timeout, or expected-download timeout override" })),
    }),
    async execute(_id, params, signal) {
      throwIfAborted(signal);
      const page = await getPage();
      const timeout = positiveInt(params.timeout_ms, ACTION_TIMEOUT);
      requireCoordinatePair(params.x, params.y, "x and y");
      requireCoordinatePair(params.target_x, params.target_y, "target_x and target_y");
      const coordinateTarget = params.x !== undefined && params.y !== undefined;
      const locator = coordinateTarget ? undefined : resolveLocator(page, params);
      const capturedDownloads: Download[] = [];
      let resolveFirstDownload: ((download: Download) => void) | undefined;
      const firstDownload = new Promise<Download>((resolve) => { resolveFirstDownload = resolve; });
      const onDownload = (download: Download) => {
        capturedDownloads.push(download);
        resolveFirstDownload?.(download);
        resolveFirstDownload = undefined;
      };
      if (params.expect_download) page.on("download", onDownload);

      try {
        switch (params.action) {
          case "click":
            if (coordinateTarget) await page.mouse.click(params.x!, params.y!);
            else await requiredLocator(locator).click({ timeout });
            break;
          case "double_click":
            if (coordinateTarget) await page.mouse.dblclick(params.x!, params.y!);
            else await requiredLocator(locator).dblclick({ timeout });
            break;
          case "drag": {
            const source = coordinateTarget
              ? { x: params.x!, y: params.y! }
              : await locatorCenter(requiredLocator(locator), timeout);
            const hasAbsoluteTarget = params.target_x !== undefined && params.target_y !== undefined;
            const hasDelta = params.delta_x !== undefined || params.delta_y !== undefined;
            if (!hasAbsoluteTarget && !hasDelta) {
              throw new Error("drag requires target_x/target_y or delta_x/delta_y");
            }
            const target = hasAbsoluteTarget
              ? { x: params.target_x!, y: params.target_y! }
              : { x: source.x + (params.delta_x ?? 0), y: source.y + (params.delta_y ?? 0) };
            await page.mouse.move(source.x, source.y);
            await page.mouse.down();
            try {
              await page.mouse.move(target.x, target.y, { steps: params.steps ?? 10 });
            } finally {
              await page.mouse.up();
            }
            break;
          }
          case "hover":
            if (coordinateTarget) await page.mouse.move(params.x!, params.y!);
            else await requiredLocator(locator).hover({ timeout });
            break;
          case "fill":
            await requiredLocator(locator).fill(requiredValue(params.value, "fill"), { timeout });
            break;
          case "type":
            await requiredLocator(locator).pressSequentially(requiredValue(params.value, "type"), { timeout });
            break;
          case "press":
            if (locator) await locator.press(requiredValue(params.value, "press"), { timeout });
            else await page.keyboard.press(requiredValue(params.value, "press"));
            break;
          case "select":
            await requiredLocator(locator).selectOption(requiredValue(params.value, "select"), { timeout });
            break;
          case "check":
            await requiredLocator(locator).check({ timeout });
            break;
          case "uncheck":
            await requiredLocator(locator).uncheck({ timeout });
            break;
          case "scroll":
            await page.mouse.wheel(params.delta_x ?? 0, params.delta_y ?? 600);
            break;
          case "wait":
            await page.waitForTimeout(Math.min(params.timeout_ms === undefined ? 1_000 : timeout, 60_000));
            break;
        }

        if (params.expect_download) {
          await waitForDownload(firstDownload, timeout);
          // Image export can emit one file per CV page with a short delay between files.
          await page.waitForTimeout(300);
        }
      } finally {
        if (params.expect_download) page.off("download", onDownload);
      }

      throwIfAborted(signal);
      await page.waitForTimeout(100);
      const downloads = await Promise.all(capturedDownloads.map(downloadArtifact));
      const downloadText = downloads.length
        ? `\ndownloads=${downloads.length}\n${downloads.map(formatDownloadArtifact).join("\n")}`
        : "";
      return textResult(
        `Completed ${params.action}\ntitle=${await page.title()}\nurl=${page.url()}\npage_id=${pageId(page)}${downloadText}`,
        { action: params.action, pageId: pageId(page), url: page.url(), downloads },
      );
    },
  });

  pi.registerCommand("web-ui", {
    description: "Show web UI control status (usage: /web-ui [open URL])",
    handler: async (args, ctx) => {
      try {
        const match = args.trim().match(/^open\s+(.+)$/);
        const page = await getPage();
        if (match) await navigate(page, match[1]);
        ctx.ui.notify(`Web UI ${browser?.isConnected() ? "connected" : "disconnected"}: ${page.url()}`, "info");
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!CDP_URL && !process.env.PI_WEB_UI_EXECUTABLE_PATH) return;
    try {
      await ensureBrowser();
      ctx.ui.notify(`Web UI vision ready${CDP_URL ? ` via ${CDP_URL}` : ""}`, "info");
    } catch (error) {
      ctx.ui.notify(`Web UI vision: ${errorMessage(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    if (ownsBrowser && browser?.isConnected()) await browser.close().catch(() => undefined);
    browser = undefined;
    activePage = undefined;
    ownsBrowser = false;
  });
}

async function waitForDownload(download: Promise<Download>, timeout: number): Promise<Download> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      download,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Expected download did not start within ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadArtifact(download: Download): Promise<DownloadArtifact> {
  const [pathResult, failureResult] = await Promise.allSettled([download.path(), download.failure()]);
  return {
    suggestedFilename: download.suggestedFilename(),
    url: download.url(),
    ...(pathResult.status === "fulfilled" && pathResult.value ? { path: pathResult.value } : {}),
    ...(failureResult.status === "fulfilled" && failureResult.value ? { failure: failureResult.value } : {}),
  };
}

function formatDownloadArtifact(artifact: DownloadArtifact): string {
  return `download filename=${JSON.stringify(artifact.suggestedFilename)} url=${JSON.stringify(artifact.url)}` +
    `${artifact.path ? ` path=${JSON.stringify(artifact.path)}` : ""}` +
    `${artifact.failure ? ` failure=${JSON.stringify(artifact.failure)}` : ""}`;
}

function resolveLocator(page: Page, params: {
  ref?: string;
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
}): Locator | undefined {
  if (params.ref) return page.locator(`[data-pi-ui-ref="${cssEscape(params.ref)}"]`).first();
  if (params.selector) return page.locator(params.selector).first();
  if (params.role) return page.getByRole(params.role as Parameters<Page["getByRole"]>[0], { name: params.name, exact: true }).first();
  if (params.text) return page.getByText(params.text, { exact: true }).first();
  return undefined;
}

function requiredLocator(locator: Locator | undefined): Locator {
  if (!locator) throw new Error("This action requires ref, selector, text, role/name, or x/y coordinates");
  return locator;
}

function requireCoordinatePair(first: number | undefined, second: number | undefined, label: string): void {
  if ((first === undefined) !== (second === undefined)) throw new Error(`${label} must be provided together`);
}

async function locatorCenter(locator: Locator, timeout: number): Promise<{ x: number; y: number }> {
  await locator.waitFor({ state: "visible", timeout });
  const box = await locator.boundingBox({ timeout });
  if (!box) throw new Error("Drag source has no visible bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function annotateInteractiveElements(page: Page, limit: number): Promise<ElementSummary[]> {
  return page.evaluate((maxElements) => {
    document.querySelectorAll("[data-pi-ui-ref]").forEach((element) => element.removeAttribute("data-pi-ui-ref"));
    const selector = [
      "a[href]", "button", "input", "textarea", "select", "summary", "[role]", "[contenteditable=true]",
      "[tabindex]:not([tabindex='-1'])", "[onclick]",
    ].join(",");
    const output: ElementSummary[] = [];
    const seen = new Set<Element>();

    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (output.length >= maxElements || seen.has(element)) continue;
      seen.add(element);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 1 || rect.height <= 1 || style.visibility === "hidden" || style.display === "none") continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;

      const ref = `e${output.length + 1}`;
      element.setAttribute("data-pi-ui-ref", ref);
      const input = element instanceof HTMLInputElement ? element : undefined;
      const labelledBy = element.getAttribute("aria-labelledby")
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      const associatedLabel = input?.labels ? Array.from(input.labels).map((label) => label.innerText.trim()).join(" ") : "";
      const rawName = element.getAttribute("aria-label") || labelledBy || associatedLabel ||
        element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") ||
        element.innerText || element.textContent || "";
      const inputRole = input
        ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider" } as Record<string, string>)[input.type] ?? "textbox"
        : "textbox";
      const role = element.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: inputRole, TEXTAREA: "textbox", SELECT: "combobox" } as Record<string, string>)[element.tagName] || "interactive";
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? (input?.type === "password" ? "[redacted]" : element.value)
        : undefined;
      output.push({
        ref,
        tag: element.tagName.toLowerCase(),
        role,
        name: rawName.replace(/\s+/g, " ").trim().slice(0, 180),
        ...(value ? { value: value.slice(0, 180) } : {}),
        disabled: "disabled" in element && Boolean((element as HTMLButtonElement).disabled),
        ...(input && ["checkbox", "radio"].includes(input.type) ? { checked: input.checked } : {}),
        rect: {
          x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
        },
      });
    }
    return output;
  }, limit);
}

function formatElement(element: ElementSummary): string {
  const state = [element.disabled ? "disabled" : "", element.checked === undefined ? "" : `checked=${element.checked}`]
    .filter(Boolean).join(" ");
  return `${element.ref} ${element.role}<${element.tag}> ${JSON.stringify(element.name)}` +
    `${element.value ? ` value=${JSON.stringify(element.value)}` : ""}` +
    `${state ? ` ${state}` : ""} rect=${element.rect.x},${element.rect.y},${element.rect.width},${element.rect.height}`;
}

function formatPages(pages: Page[], active: Page | undefined, idFor: (page: Page) => string): string {
  if (pages.length === 0) return "No browser pages are open.";
  return pages.map((page) => `${page === active ? "*" : " "} ${idFor(page)} ${JSON.stringify(page.url())}`).join("\n");
}

async function navigate(page: Page, url: string): Promise<void> {
  const parsed = new URL(url);
  if (!(["http:", "https:"].includes(parsed.protocol) || parsed.href === "about:blank")) {
    throw new Error("Only http://, https://, and about:blank URLs are allowed");
  }
  await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT });
}

async function viewportText(page: Page): Promise<string> {
  return page.evaluate(() => `${innerWidth}x${innerHeight} scroll=${Math.round(scrollX)},${Math.round(scrollY)}`);
}

function findBrowserExecutable(): string | undefined {
  const configured = process.env.PI_WEB_UI_EXECUTABLE_PATH?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`PI_WEB_UI_EXECUTABLE_PATH does not exist: ${configured}`);
    return configured;
  }

  const candidates = platform() === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ]
    : platform() === "win32"
      ? [
          `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find(existsSync);
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function requiredValue(value: string | undefined, action: string): string {
  if (value === undefined) throw new Error(`${action} requires value`);
  return value;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString("utf8") + "\n[Interactive element list truncated at 32KB]";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
