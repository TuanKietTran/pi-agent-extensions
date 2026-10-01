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
import { prompt } from "./md.ts";
import todo from "./todo.ts";
import { Supervisor, type JobEvent, type JobRecord, type KindConfig } from "./supervisor.ts";

import { PI_EVENT } from "./events.ts";

// --- Constants: every local literal lives here. ---

const ENTRY_TYPE = "core_job";
const STEER_STATES = new Set(["completed", "failed", "timed_out", "lost", "cancelled"]);
const ENTRY_CUSTOM = "custom";
const EXTENSIONS_SUBDIR = [".pi", "agent", "extensions", "core"];
const ENV_ALLOW_IRREVERSIBLE = "PI_JOBS_ALLOW_IRREVERSIBLE";
const ENV_ENABLED = "1";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const DEFAULT_AGENT_DIR = [".pi", "agent"];
const SETTINGS_FILE = "settings.json";

// Markdown files and headings
const RULES_FILE = "rules.md";
const CONTEXTS_FILE = "contexts.md";
const COMMANDS_FILE = "commands.md";
const JOB_RULES_HEADING = "job-rules";
const JOB_CONTEXT_HEADING = "job-context";
const SLA_KEY = "sla_s";

// Tools and command
const START_TOOL = "start_job";
const START_LABEL = "Start job";
const START_DESCRIPTION = "Start a host-managed long-running job. Returns immediately; a job_event is steered on completion.";
const KIND_DESCRIPTION = `Job kind defined in ${COMMANDS_FILE} (e.g. shell, test)`;
const COMMAND_DESCRIPTION = "Shell command to run";
const STATUS_TOOL = "job_status";
const STATUS_LABEL = "Job status";
const STATUS_DESCRIPTION = "Snapshot of a job. Rare; the host steers on state changes.";
const CANCEL_TOOL = "cancel_job";
const CANCEL_LABEL = "Cancel job";
const CANCEL_DESCRIPTION = "Cancel a running job (signals its process group).";
const LOGS_TOOL = "job_logs";
const LOGS_LABEL = "Job logs";
const LOGS_DESCRIPTION = "Last N log lines of a job (bounded to 200).";
const DEFAULT_TAIL = 20;
const JOBS_COMMAND = "jobs";
const JOBS_DESCRIPTION = "List jobs and states";

// Messages
const NO_KINDS_NOTE = `core: no job kinds found in ${COMMANDS_FILE}`;
const NO_JOBS = "no jobs";
const NO_OUTPUT = "(no output)";
const NOTE_WARNING = "warning";
const NOTE_INFO = "info";
const unknownJob = (id: string) => `Unknown job ${id}`;
const jobLine = (j: JobRecord) => `${j.job_id}: ${j.state}`;

function agentDir(): string {
	return process.env[AGENT_DIR_ENV] || path.join(os.homedir(), ...DEFAULT_AGENT_DIR);
}

function allowIrreversibleJobs(): boolean {
	if (process.env[ENV_ALLOW_IRREVERSIBLE] === ENV_ENABLED) return true;
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir(), SETTINGS_FILE), "utf8"));
		return settings?.jobs?.allowIrreversible === true;
	} catch {
		return false;
	}
}

function coreDir(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return path.join(os.homedir(), ...EXTENSIONS_SUBDIR);
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
	const commands = readFile(COMMANDS_FILE);
	const blocks = jsonBlocks(commands) as Record<string, any>[];
	const kinds = (blocks.find((b) => b && Object.values(b).every((v: any) => v && SLA_KEY in v)) ?? {}) as Record<
		string,
		KindConfig
	>;
	const options = (blocks.find((b) => b && Object.values(b).every((v) => Array.isArray(v))) ?? {}) as Record<
		string,
		string[]
	>;
	return { rules: prompt(RULES_FILE, JOB_RULES_HEADING), contexts: prompt(CONTEXTS_FILE, JOB_CONTEXT_HEADING), commands, kinds, options };
}

export default function core(pi: ExtensionAPI) {
	contextGuard(pi);
	answerFloor(pi);
	contextOptimize(pi);
	fileToolDiscipline(pi);
	todo(pi);
	registerReplay(pi);
	let cfg = loadConfig();
	let sup: Supervisor | undefined;
	const allowIrreversible = allowIrreversibleJobs();

	const text = (t: string, details: unknown = undefined) => ({ content: [{ type: "text" as const, text: t }], details });

	pi.on(PI_EVENT.SESSION_START, async (_e, ctx) => {
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
			if (e.type === ENTRY_CUSTOM && e.customType === ENTRY_TYPE && e.data) latest.set(e.data.job_id, e.data);
		}
		sup.restore([...latest.values()]);
		if (Object.keys(cfg.kinds).length === 0) ctx.ui.notify(NO_KINDS_NOTE, NOTE_WARNING);
	});

	pi.on(PI_EVENT.SESSION_SHUTDOWN, async () => {
		sup?.shutdown();
	});

	// Re-read the markdown on every run: edits apply immediately, no reload command or tool call.
	pi.on(PI_EVENT.BEFORE_AGENT_START, async (event) => {
		cfg = loadConfig();
		sup?.setConfig(cfg.kinds, cfg.options);
		return { systemPrompt: `${event.systemPrompt}\n\n${cfg.rules}\n\n${cfg.contexts}` };
	});

	pi.registerTool({
		name: START_TOOL,
		label: START_LABEL,
		description: START_DESCRIPTION,
		parameters: Type.Object({
			kind: Type.String({ description: KIND_DESCRIPTION }),
			spec: Type.Object({
				command: Type.String({ description: COMMAND_DESCRIPTION }),
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
		name: STATUS_TOOL,
		label: STATUS_LABEL,
		description: STATUS_DESCRIPTION,
		parameters: Type.Object({ job_id: Type.String() }),
		async execute(_id, p) {
			const s = sup!.status(p.job_id);
			if (!s) throw new Error(unknownJob(p.job_id));
			return text(JSON.stringify(s), s);
		},
	});

	pi.registerTool({
		name: CANCEL_TOOL,
		label: CANCEL_LABEL,
		description: CANCEL_DESCRIPTION,
		parameters: Type.Object({ job_id: Type.String() }),
		async execute(_id, p) {
			return text(sup!.cancel(p.job_id));
		},
	});

	pi.registerTool({
		name: LOGS_TOOL,
		label: LOGS_LABEL,
		description: LOGS_DESCRIPTION,
		parameters: Type.Object({ job_id: Type.String(), tail: Type.Optional(Type.Number({ default: DEFAULT_TAIL })) }),
		async execute(_id, p) {
			const lines = sup!.logs(p.job_id, p.tail ?? DEFAULT_TAIL);
			if (!lines) throw new Error(unknownJob(p.job_id));
			return text(lines.join("\n") || NO_OUTPUT);
		},
	});

	pi.registerCommand(JOBS_COMMAND, {
		description: JOBS_DESCRIPTION,
		handler: async (_a, ctx) => {
			const l = sup?.list() ?? [];
			ctx.ui.notify(l.length ? l.map(jobLine).join("\n") : NO_JOBS, NOTE_INFO);
		},
	});
}
