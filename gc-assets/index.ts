import v8 from "node:v8";
import vm from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerReplay } from "./dev/replay.ts";
import { WIDGET_KEY, formatBytes, publish } from "./panel.ts";
import { ageDays, loadConfig, scan, state, sweep } from "./scanner.ts";

async function refresh(ctx: ExtensionContext | undefined): Promise<void> {
  try {
    await scan();
  } catch {
    // Scan failures must never disturb the agent turn.
  }
  publish(ctx ?? state.ctx);
}

function runGc(): number {
  const before = process.memoryUsage().heapUsed;
  let gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    try {
      v8.setFlagsFromString("--expose-gc");
      gc = vm.runInNewContext("gc") as () => void;
    } catch {}
  }
  gc?.();
  return Math.max(0, before - process.memoryUsage().heapUsed);
}

function start(): void {
  if (state.timer) return;
  // unref: this must never be the reason a pi session refuses to exit.
  state.timer = setInterval(() => void refresh(undefined), loadConfig().tick_ms);
  state.timer.unref?.();
  void refresh(undefined);
}

function stop(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
}

export default function gcAssets(pi: ExtensionAPI): void {
  registerReplay(pi);

  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    publish(ctx);
    start();
  });

  pi.on("turn_end", async (_event, ctx) => {
    state.ctx = ctx;
    publish(ctx);
  });

  pi.on("session_shutdown", async (event) => {
    state.ctx = undefined;
    if (event.reason === "quit") stop();
  });

  pi.registerCommand("gc", {
    description: "Memory GC and asset cleanup (status|scan|heap|sweep [sessions]|age <days>|hide|show)",
    handler: async (args, ctx) => {
      state.ctx = ctx;
      const [action = "status", arg] = args.trim().toLowerCase().split(/\s+/);

      if (action === "status" || action === "scan") {
        await refresh(ctx);
        const total = state.categories.reduce((sum, c) => sum + c.bytes, 0);
        ctx.ui.notify(`Assets ${formatBytes(total)} · stale >${ageDays()}d ${formatBytes(state.categories.reduce((sum, c) => sum + c.staleBytes, 0))}`, "info");
        return;
      }

      if (action === "heap") {
        const freed = runGc();
        state.lastGc = { at: Date.now(), freedBytes: freed };
        publish(ctx);
        ctx.ui.notify(`Heap GC freed ${formatBytes(freed)}`, "info");
        return;
      }

      if (action === "age") {
        const days = Number(arg);
        if (!Number.isFinite(days) || days < 0) {
          ctx.ui.notify("Usage: /gc age <days>", "warning");
          return;
        }
        state.ageDays = days;
        await refresh(ctx);
        return;
      }

      if (action === "hide") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }

      if (action === "show") {
        await refresh(ctx);
        return;
      }

      if (action === "sweep") {
        await refresh(ctx);
        const age = ageDays();
        const includeSessions = arg === "sessions";
        const targets = state.categories.filter((c) => c.staleFiles > 0 && (c.sweep === "auto" || (includeSessions && c.sweep === "confirm")));
        const files = targets.reduce((sum, c) => sum + c.staleFiles, 0);
        const bytes = targets.reduce((sum, c) => sum + c.staleBytes, 0);
        if (files === 0) {
          ctx.ui.notify(`Nothing older than ${age}d to sweep${includeSessions ? "" : " (sessions excluded; use /gc sweep sessions)"}`, "info");
          return;
        }
        const list = targets.map((c) => `${c.label}: ${c.staleFiles} files, ${formatBytes(c.staleBytes)}`).join("\n");
        if (!(await ctx.ui.confirm("Delete stale assets?", `Older than ${age} days:\n${list}\n\nTotal ${files} files, ${formatBytes(bytes)}. This cannot be undone.`))) return;
        const done = await sweep(targets, age);
        state.lastSweep = { at: Date.now(), ...done };
        runGc();
        await refresh(ctx);
        ctx.ui.notify(`Swept ${done.files} files, ${formatBytes(done.bytes)}`, "info");
        return;
      }

      ctx.ui.notify("Usage: /gc [status|scan|heap|sweep [sessions]|age <days>|hide|show]", "warning");
    },
  });
}
