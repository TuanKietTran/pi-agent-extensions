import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanCategories, sweep, type GcConfig } from "../scanner.ts";

const DAY_MS = 86_400_000;

async function touch(file: string, ageDays: number) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "x".repeat(100));
	const t = new Date(Date.now() - ageDays * DAY_MS);
	await fs.utimes(file, t, t);
}

/** /gc-replay — scan + sweep against a scratch dir. Never touches real pi assets or shared state. */
export function registerReplay(pi: ExtensionAPI) {
	pi.registerCommand("gc-replay", {
		description: "Replay gc-assets scan/sweep on a scratch directory and print PASS/FAIL",
		handler: async (_args, ctx) => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-replay-"));
			const checks: [string, boolean][] = [];
			try {
				await touch(path.join(dir, "auto/old.log"), 30);
				await touch(path.join(dir, "auto/new.log"), 0);
				await touch(path.join(dir, "keep/old.db"), 30);
				await touch(path.join(dir, "confirm/old.jsonl"), 30);
				const cfg: GcConfig = {
					tick_ms: 60_000,
					max_files: 50_000,
					age_days: 7,
					categories: [
						{ id: "auto", label: "auto", sweep: "auto", roots: [path.join(dir, "auto")] },
						{ id: "keep", label: "keep", sweep: "never", roots: [path.join(dir, "keep")] },
						{ id: "confirm", label: "confirm", sweep: "confirm", roots: [path.join(dir, "confirm")] },
					],
				};
				const cats = await scanCategories(cfg, 7);
				const by = (id: string) => cats.find((c) => c.id === id)!;
				checks.push(["auto: 2 files, 1 stale", by("auto").files === 2 && by("auto").staleFiles === 1]);
				checks.push(["never: counted, 0 stale", by("keep").files === 1 && by("keep").staleFiles === 0]);
				checks.push(["confirm: 1 stale", by("confirm").staleFiles === 1]);

				const done = await sweep(cats.filter((c) => c.sweep === "auto"), 7);
				const exists = (p: string) => fs.access(path.join(dir, p)).then(() => true, () => false);
				checks.push(["sweep removed 1 file, 100B", done.files === 1 && done.bytes === 100]);
				checks.push(["old auto file gone", !(await exists("auto/old.log"))]);
				checks.push(["fresh auto file kept", await exists("auto/new.log")]);
				checks.push(["never-category file kept", await exists("keep/old.db")]);
				checks.push(["confirm-category file kept (not targeted)", await exists("confirm/old.jsonl")]);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
			const ok = checks.every(([, pass]) => pass);
			ctx.ui.notify(
				[`▶ gc-replay`, ...checks.map(([n, pass]) => `  ${pass ? "✔" : "✘"} ${n}`), ok ? "✔ PASS" : "✘ FAIL"].join("\n"),
				ok ? "info" : "error",
			);
		},
	});
}
