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

async function tick(force = false): Promise<string | undefined> {
  try {
    const usage = await core();
    const published = await usage.refresh({ force });
    const line = published ? usage.render(published) : undefined;
    if (line) state.ctx?.ui.setStatus("touchbar-usage", line);
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
        const detail = [line];
        // Show which account each number belongs to. A right number about the
        // wrong login looks identical to a bug otherwise.
        const cc = published?.claude;
        const cx = published?.codex;
        if (cc?.account || cc?.plan) {
          detail.push(`claude: ${cc?.account ?? "?"}${cc?.plan ? ` (${cc.plan})` : ""}`);
        }
        if (cx?.account || cx?.plan) {
          detail.push(`codex: ${cx?.account ?? "?"}${cx?.plan ? ` (${cx.plan})` : ""}`);
        }
        detail.push(`published: ${usage.TEXT_PATH}`);
        detail.push(`poller: ${state.running ? "on" : "off"}`);
        ctx.ui.setWidget("touchbar-usage", detail, { placement: "aboveEditor" });
        return;
      }

      ctx.ui.notify("Usage: /touchbar-usage [start|stop|status|refresh]", "warning");
    },
  });
}
