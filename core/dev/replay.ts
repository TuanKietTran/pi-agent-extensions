import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Supervisor, type JobEvent, type JobRecord, type JobState, type KindConfig } from "../supervisor.ts";

/** Short SLAs so every scenario finishes in seconds. Isolated from the real supervisor. */
const KINDS: Record<string, KindConfig> = {
	shell: { sla_s: 2, heartbeat_s: 0, class: "idempotent", cancelable: true },
	watch: { sla_s: 30, heartbeat_s: 1, class: "idempotent", cancelable: true },
};

const OPTIONS: Record<string, string[]> = {
	timed_out: ["cancel", "keep_waiting", "rollback", "inspect_logs"],
	lost: ["cancel", "inspect_logs", "restart"],
	failed: ["inspect_logs", "restart"],
};

interface Scenario {
	name: string;
	desc: string;
	expect: JobState[];
	run(sup: Supervisor): void;
}

const SCENARIOS: Scenario[] = [
	{
		name: "pass",
		desc: "test passes -> one completed",
		expect: ["completed"],
		run: (s) => void s.start("shell", "echo tests ok", "/tmp"),
	},
	{
		name: "hang",
		desc: "job hangs -> timed_out, then operator cancels",
		expect: ["timed_out", "cancelled"],
		run: (s) => void s.start("shell", "sleep 30", "/tmp"),
	},
	{
		name: "lost",
		desc: "silent process, heartbeat missed -> lost (never completed)",
		expect: ["lost"],
		run: (s) => void s.start("watch", "sleep 30", "/tmp"),
	},
	{
		name: "cancel",
		desc: "user cancels mid-job -> cancelled",
		expect: ["cancelled"],
		run: (s) => {
			const r = s.start("shell", "sleep 30", "/tmp");
			setTimeout(() => s.cancel(r.job_id), 400);
		},
	},
	{
		name: "resume",
		desc: "resume with a running record and dead pid -> lost",
		expect: ["lost"],
		run: (s) => {
			const rec: JobRecord = {
				job_id: "shell-99",
				kind: "shell",
				command: "sleep 30",
				cwd: "/tmp",
				state: "running",
				pid: 2 ** 22 - 1,
				started_at: Date.now() - 5000,
				sla_s: 60,
				heartbeat_s: 0,
				reversible: true,
				cancelable: true,
			};
			s.restore([rec]);
		},
	},
];

function runScenario(sc: Scenario, log: (line: string) => void, forward?: (ev: JobEvent) => void) {
	return new Promise<{ ok: boolean; got: JobState[] }>((resolve) => {
		const got: JobState[] = [];
		let sup: Supervisor;
		const done = (ok: boolean) => {
			clearTimeout(guard);
			sup.shutdown();
			resolve({ ok, got });
		};
		const guard = setTimeout(() => done(false), 8000);
		sup = new Supervisor(
			KINDS,
			OPTIONS,
			{
				onPersist() {},
				onEvent(ev) {
					got.push(ev.state);
					log(`  ${ev.job_id} ${ev.state}${ev.step ? ` [${ev.step}]` : ""} ${ev.elapsed_s}s "${ev.last_line}" opts=${ev.options.join("|")}`);
					forward?.(ev);
					// Stand-in for the model's decision so the process does not linger.
					if (ev.state === "timed_out") setTimeout(() => sup.cancel(ev.job_id), 300);
					if (got.length >= sc.expect.length) setTimeout(() => done(sc.expect.every((s, i) => got[i] === s)), 100);
				},
			},
			false,
		);
		sc.run(sup);
	});
}

/** /core-replay [all|pass|hang|lost|cancel|resume] [live] — scripted job-bus scenarios for interactive testing. */
export function registerReplay(pi: ExtensionAPI) {
	pi.registerCommand("core-replay", {
		description: "Replay job-bus scenarios: /core-replay [all|pass|hang|lost|cancel|resume] [live]",
		handler: async (args, ctx) => {
			const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const live = words.includes("live");
			const pick = words.find((w) => w !== "live") ?? "all";
			const list = pick === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.name === pick);
			if (list.length === 0) {
				ctx.ui.notify(`unknown scenario '${pick}'. Use: all, ${SCENARIOS.map((s) => s.name).join(", ")}`, "warning");
				return;
			}
			const forward = live
				? (ev: JobEvent) => pi.sendUserMessage(`[replay] ${JSON.stringify(ev)}`, { deliverAs: "steer" })
				: undefined;

			const summary: string[] = [];
			for (const sc of list) {
				ctx.ui.setStatus("core-replay", `replay: ${sc.name}`);
				const lines: string[] = [`▶ ${sc.name}: ${sc.desc}`];
				const r = await runScenario(sc, (l) => lines.push(l), forward);
				lines.push(`${r.ok ? "✔ PASS" : "✘ FAIL"} expected [${sc.expect.join(",")}] got [${r.got.join(",")}]`);
				ctx.ui.notify(lines.join("\n"), r.ok ? "info" : "error");
				summary.push(`${r.ok ? "PASS" : "FAIL"} ${sc.name}`);
			}
			ctx.ui.setStatus("core-replay", undefined);
			ctx.ui.notify(`replay done${live ? " (live steer)" : ""}: ${summary.join(", ")}`, "info");
		},
	});
}
