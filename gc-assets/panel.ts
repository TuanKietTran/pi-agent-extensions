import v8 from "node:v8";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ageDays, state } from "./scanner.ts";

export const WIDGET_KEY = "gc-assets";

export function formatBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  const units = ["K", "M", "G", "T"];
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)}${units[i]}`;
}

function bar(ctx: ExtensionContext, percent: number, width = 10): string {
  const bounded = Math.max(0, Math.min(100, percent));
  const filled = Math.round((bounded / 100) * width);
  const tone = bounded >= 90 ? "error" : bounded >= 70 ? "warning" : "success";
  return ctx.ui.theme.fg(tone, "█".repeat(filled)) + ctx.ui.theme.fg("dim", "░".repeat(width - filled));
}

function memory() {
  const usage = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return { rss: usage.rss, heapUsed: usage.heapUsed, heapLimit: heap.heap_size_limit, external: usage.external + usage.arrayBuffers };
}

function panel(ctx: ExtensionContext): string[] {
  const theme = ctx.ui.theme;
  const mem = memory();
  const age = ageDays();
  const heapPercent = (mem.heapUsed / mem.heapLimit) * 100;
  const lines = [
    theme.fg("accent", "Memory & Assets"),
    `HEAP ${bar(ctx, heapPercent)} ${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapLimit)}`,
    `RSS  ${formatBytes(mem.rss)}  ${theme.fg("dim", `ext ${formatBytes(mem.external)}`)}`,
  ];
  if (state.categories.length === 0) {
    lines.push(theme.fg("dim", state.scanning ? "scanning assets…" : "no scan yet · /gc scan"));
    return lines;
  }
  let reclaimable = 0;
  for (const category of state.categories) {
    reclaimable += category.staleBytes;
    const stale = category.staleBytes > 0 ? theme.fg("warning", ` ⟳${formatBytes(category.staleBytes)}`) : "";
    const more = category.truncated ? "+" : "";
    lines.push(`${category.label.padEnd(11)} ${formatBytes(category.bytes).padStart(5)} ${theme.fg("dim", `${category.files}${more}f`)}${stale}`);
  }
  lines.push(theme.fg(reclaimable > 0 ? "warning" : "dim", `stale >${age}d: ${formatBytes(reclaimable)} · /gc sweep`));
  if (state.lastGc) lines.push(theme.fg("dim", `gc ${formatBytes(state.lastGc.freedBytes)} freed`));
  if (state.lastSweep) lines.push(theme.fg("dim", `swept ${state.lastSweep.files}f · ${formatBytes(state.lastSweep.bytes)}`));
  return lines;
}

export function publish(ctx: ExtensionContext | undefined): void {
  if (!ctx) return;
  try {
    ctx.ui.setWidget(WIDGET_KEY, panel(ctx), { placement: "aboveEditor" });
  } catch {
    // The context goes stale across session replacement; the next event refreshes it.
  }
}
