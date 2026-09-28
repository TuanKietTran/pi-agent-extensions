import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import answerFloor from "./guards/answer-floor.ts";
import contextGuard from "./guards/context-guard.ts";
import contextOptimize from "./guards/context-optimize.ts";
import fileToolDiscipline from "./guards/file-tool-discipline.ts";
import { registerReplay } from "./dev/replay.ts";
import { Supervisor, type JobEvent, type JobRecord, type KindConfig } from "./supervisor.ts";

const ENTRY_TYPE = "core_job";
const STEER_STATES = new Set(["completed", "failed", "timed_out", "lost", "cancelled"]);

function coreDir(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return path.join(os.homedir(), ".pi", "agent", "extensions", "core");
	}
}

function readFile(name: string): string {
	try {
		return fs.readFileSync(path.join(coreDir(), name), "utf8");
	} catch {
		return "";
	}
}

/** Extract every ```json fenced block from markdown, parsed. */
function jsonBlocks(md: string): unknown[] {
	const out: unknown[] = [];
	for (const m of md.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
		try {
			out.push(JSON.parse(m[1]));
		} catch {}
	}
	return out;
}

interface CoreConfig {
	rules: string;
	contexts: string;
	commands: string;
	kinds: Record<string, KindConfig>;
	options: Record<string, string[]>;
}

/** All behavior comes from rules.md, commands.md, contexts.md. Nothing hardcoded here. */
function loadConfig(): CoreConfig {
	const commands = readFile("commands.md");
	const blocks = jsonBlocks(commands) as Record<string, any>[];
	const kinds = (blocks.find((b) => b && Object.values(b).every((v: any) => v && "sla_s" in v)) ?? {}) as Record<
		string,
		KindConfig
	>;
	const options = (blocks.find((b) => b && Object.values(b).every((v) => Array.isArray(v))) ?? {}) as Record<
		string,
		string[]
	>;
	return { rules: readFile("rules.md"), contexts: readFile("contexts.md"), commands, kinds, options };
}

export default function core(pi: ExtensionAPI) {
	contextGuard(pi);
	answerFloor(pi);
	contextOptimize(pi);
	fileToolDiscipline(pi);
	registerReplay(pi);
	let cfg = loadConfig();
	let sup: Supervisor | undefined;
	const allowIrreversible = process.env.PI_JOBS_ALLOW_IRREVERSIBLE === "1";

	const text = (t: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text: t }], details });

	pi.on("session_start", async (_e, ctx) => {
		cfg = loadConfig();
		sup?.shutdown();
		sup = new Supervisor(
			cfg.kinds,
			cfg.options,
			{
				onEvent: (ev: JobEvent) => {
					if (!STEER_STATES.has(ev.state)) return;
					pi.sendUserMessage(JSON.stringify(ev), { deliverAs: "steer" });
				},
				onPersist: (rec: JobRecord) => pi.appendEntry(ENTRY_TYPE, rec),
			},
			allowIrreversible,
		);
		const latest = new Map<string, JobRecord>();
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e.type === "custom" && e.customType === ENTRY_TYPE && e.data) latest.set(e.data.job_id, e.data);
		}
		sup.restore([...latest.values()]);
		if (Object.keys(cfg.kinds).length === 0) ctx.ui.notify("core: no job kinds found in commands.md", "warning");
	});

	pi.on("session_shutdown", async () => {
		sup?.shutdown();
	});

	// Re-read the markdown on every run: edits apply immediately, no reload command or tool call.
	pi.on("before_agent_start", async (event) => {
		cfg = loadConfig();
		sup?.setConfig(cfg.kinds, cfg.options);
		return { systemPrompt: `${event.systemPrompt}\n\n${cfg.rules}\n\n${cfg.contexts}` };
	});

	pi.registerTool({
		name: "start_job",
		label: "Start job",
		description: "Start a host-managed long-running job. Returns immediately; a job_event is steered on completion.",
		parameters: Type.Object({
			kind: Type.String({ description: "Job kind defined in commands.md (e.g. shell, test)" }),
			spec: Type.Object({
				command: Type.String({ description: "Shell command to run" }),
				cwd: Type.Optional(Type.String()),
			}),
		}),
		async execute(_id, p, _sig, _upd, ctx) {
			const rec = sup!.start(p.kind, p.spec.command, p.spec.cwd ?? ctx.cwd);
			return text(
				JSON.stringify({
					job_id: rec.job_id,
					state: rec.state,
					sla_s: rec.sla_s,
					heartbeat_s: rec.heartbeat_s,
					cancelable: rec.cancelable,
					reversible: rec.reversible,
				}),
				rec,
			);
		},
	});

	pi.registerTool({
		name: "job_status",
		label: "Job status",
		description: "Snapshot of a job. Rare; the host steers on state changes.",
		parameters: Type.Object({ job_id: Type.String() }),
		async execute(_id, p) {
			const s = sup!.status(p.job_id);
			if (!s) throw new Error(`Unknown job ${p.job_id}`);
			return text(JSON.stringify(s), s);
		},
	});

	pi.registerTool({
		name: "cancel_job",
		label: "Cancel job",
		description: "Cancel a running job (signals its process group).",
		parameters: Type.Object({ job_id: Type.String() }),
		async execute(_id, p) {
			return text(sup!.cancel(p.job_id));
		},
	});

	pi.registerTool({
		name: "job_logs",
		label: "Job logs",
		description: "Last N log lines of a job (bounded to 200).",
		parameters: Type.Object({ job_id: Type.String(), tail: Type.Optional(Type.Number({ default: 20 })) }),
		async execute(_id, p) {
			const lines = sup!.logs(p.job_id, p.tail ?? 20);
			if (!lines) throw new Error(`Unknown job ${p.job_id}`);
			return text(lines.join("\n") || "(no output)");
		},
	});

	pi.registerCommand("jobs", {
		description: "List jobs and states",
		handler: async (_a, ctx) => {
			const l = sup?.list() ?? [];
			ctx.ui.notify(l.length ? l.map((j) => `${j.job_id}: ${j.state}`).join("\n") : "no jobs", "info");
		},
	});
}
