import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi reloads extensions in-process on session switch/fork, so module state is
// rebuilt but globalThis is not. Parking the timer here keeps one poller per
// process instead of one per session reload.
const STATE_KEY = Symbol.for("pi.touchbar-usage.state.v1");
const TICK_MS = 15_000;

type Core = typeof import("./src/usage.mjs");

type UsageState = {
  timer?: ReturnType<typeof setInterval>;
  ctx?: ExtensionContext;
  core?: Core;
  running: boolean;
};

const globals = globalThis as typeof globalThis & { [STATE_KEY]?: UsageState };
const state: UsageState = globals[STATE_KEY] ?? { running: false };
globals[STATE_KEY] = state;

// Loaded lazily so a broken core never stops the rest of pi from starting.
async function core(): Promise<Core> {
  state.core ??= (await import(new URL("./src/usage.mjs", import.meta.url).href)) as Core;
  return state.core;
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function resetIn(resetsAt: unknown): string {
  if (typeof resetsAt !== "number") return "";
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000));
  if (minutes <= 0) return "";
  if (minutes < 60) return ` ↻${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ` ↻${hours}h${minutes % 60 ? String(minutes % 60).padStart(2, "0") : ""}`;
  return ` ↻${Math.round(hours / 24)}d`;
}

function progressBar(ctx: ExtensionContext, percent: number, width = 10): string {
  const bounded = Math.max(0, Math.min(100, percent));
  const filled = Math.round((bounded / 100) * width);
  const tone = bounded >= 90 ? "error" : bounded >= 70 ? "warning" : "success";
  return ctx.ui.theme.fg(tone, "█".repeat(filled)) + ctx.ui.theme.fg("dim", "░".repeat(width - filled));
}

function tokenTotals(ctx: ExtensionContext): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    input += message.usage.input;
    output += message.usage.output;
  }
  return { input, output };
}

function usagePanel(ctx: ExtensionContext, published: any): string[] {
  const totals = tokenTotals(ctx);
  const context = ctx.getContextUsage();
  const contextPercent = context?.percent ?? 0;
  const lines = [
    ctx.ui.theme.fg("accent", "Usage"),
    `CTX ${progressBar(ctx, contextPercent)} ${Math.round(contextPercent).toString().padStart(3)}%`,
    `TOK ↑${compactNumber(totals.input)}  ↓${compactNumber(totals.output)}`,
  ];
  for (const [label, side] of [["CC", published?.claude], ["CX", published?.codex]] as const) {
    if (!side) continue;
    if (!side.ok && !side.windows?.length) {
      lines.push(`${label} ${ctx.ui.theme.fg("dim", side.error === "no-auth" ? "—" : `!${side.error ?? "error"}`)}`);
      continue;
    }
    for (const window of side.windows ?? []) {
      const percent = Number(window.percent) || 0;
      lines.push(`${label} ${String(window.label).padEnd(2)} ${progressBar(ctx, percent)} ${Math.round(percent).toString().padStart(3)}%${resetIn(window.resetsAt)}`);
    }
  }
  return lines;
}

function publishPanel(ctx: ExtensionContext, published: any): void {
  ctx.ui.setStatus("touchbar-usage", undefined);
  ctx.ui.setWidget("touchbar-usage", usagePanel(ctx, published), { placement: "aboveEditor" });
}

async function tick(force = false): Promise<string | undefined> {
  try {
    const usage = await core();
    const published = await usage.refresh({ force });
    const line = published ? usage.render(published) : undefined;
    if (published && state.ctx) publishPanel(state.ctx, published);
    return line;
  } catch {
    // The Touch Bar host reads the published file directly, so it keeps
    // working even when the in-pi poller is unhappy.
    return undefined;
  }
}

function start(): void {
  if (state.timer) return;
  // unref: this must never be the reason a pi session refuses to exit.
  state.timer = setInterval(() => void tick(), TICK_MS);
  state.timer.unref?.();
  state.running = true;
  void tick();
}

function stop(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.running = false;
}

export default function touchbarUsage(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    start();
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const usage = await core();
      const published = usage.readPublished();
      if (published) publishPanel(ctx, published);
    } catch {
      // Keep usage display failures isolated from the agent turn.
    }
  });

  pi.on("session_shutdown", async (event) => {
    state.ctx = undefined;
    // Only tear down on a real quit. A session switching or forking inside a
    // tmux pane while other panes live on should leave the poller running.
    if (event.reason === "quit") stop();
  });

  pi.registerCommand("touchbar-usage", {
    description: "Claude Code + Codex usage on the Touch Bar (start|stop|status|refresh)",
    handler: async (args, ctx) => {
      state.ctx = ctx;
      const action = args.trim().toLowerCase() || "status";

      if (action === "stop") {
        stop();
        ctx.ui.setStatus("touchbar-usage", undefined);
        ctx.ui.setWidget("touchbar-usage", undefined);
        ctx.ui.notify("Usage polling stopped (Touch Bar keeps its own timer)", "info");
        return;
      }

      if (action === "start") {
        start();
        ctx.ui.notify("Usage polling started", "info");
        return;
      }

      if (action === "refresh" || action === "status") {
        const line = await tick(action === "refresh");
        if (!line) {
          ctx.ui.notify("No usage data yet — run bin/pi-usagebar --json to see why", "warning");
          return;
        }
        const usage = await core();
        const published = usage.readPublished();
        if (published) publishPanel(ctx, published);
        return;
      }

      ctx.ui.notify("Usage: /touchbar-usage [start|stop|status|refresh]", "warning");
    },
  });
}
