// handoff — durable, compact continuation state shared by compaction and restarts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_EVENT } from "./events.ts";
import { prompt } from "./md.ts";

const ENTRY_TYPE = "core-handoff";
const FILE_NAME = "handoff.json";
const TOOL_NAME = "handoff";
const MAX_ITEMS = 12;
const MAX_TEXT = 800;
const MAX_SUMMARY = 6000;
const NOTE_INFO = "info";
const GUIDANCE = prompt("rules.md", "handoff-guidance");
const ACTIONS = ["update", "show", "clear"] as const;
const fields = ["goal", "constraints", "decisions", "done", "in_progress", "files", "verification", "errors", "next", "rollback"] as const;
type Field = typeof fields[number];
type Handoff = { goal?: string; constraints: string[]; decisions: string[]; done: string[]; in_progress: string[]; files: string[]; verification: string[]; errors: string[]; next: string[]; rollback: string[]; updated_at: number };

type HandoffInput = { action: (typeof ACTIONS)[number]; goal?: string; constraints?: string[]; decisions?: string[]; done?: string[]; in_progress?: string[]; files?: string[]; verification?: string[]; errors?: string[]; next?: string[]; rollback?: string[] };

const empty = (): Handoff => ({ constraints: [], decisions: [], done: [], in_progress: [], files: [], verification: [], errors: [], next: [], rollback: [], updated_at: Date.now() });
let latestState = empty();
let latestTurns = 0;
const clean = (value: unknown): string => String(value ?? "").trim().slice(0, MAX_TEXT);
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(clean).filter(Boolean).slice(0, MAX_ITEMS) : [];
function valid(value: unknown): value is Handoff {
	if (!value || typeof value !== "object") return false;
	const x = value as Partial<Handoff>;
	return typeof x.updated_at === "number" && fields.slice(1).every((field) => Array.isArray(x[field]));
}
function normalize(value: unknown): Handoff {
	const x = value as Partial<Handoff>;
	return { goal: clean(x.goal) || undefined, constraints: list(x.constraints), decisions: list(x.decisions), done: list(x.done), in_progress: list(x.in_progress), files: list(x.files), verification: list(x.verification), errors: list(x.errors), next: list(x.next), rollback: list(x.rollback), updated_at: Date.now() };
}
function summary(state: Handoff): string {
	const lines = ["# Durable continuation handoff", state.goal && `Goal: ${state.goal}`, ...fields.slice(1).map((field) => {
		const values = state[field] as string[];
		return values.length ? `${field}:\n${values.map((value) => `- ${value}`).join("\n")}` : "";
	})].filter(Boolean);
	return lines.join("\n").slice(0, MAX_SUMMARY);
}
function writeDurable(ctx: ExtensionContext, state: Handoff): void {
	try {
		const dir = ctx.sessionManager.getSessionDir();
		mkdirSync(dir, { recursive: true });
		const target = join(dir, FILE_NAME);
		const temp = `${target}.tmp`;
		writeFileSync(temp, JSON.stringify(state), "utf8");
		renameSync(temp, target);
	} catch { /* session entries remain the fallback */ }
}
function readDurable(ctx: ExtensionContext): Handoff | undefined {
	try {
		const value = JSON.parse(readFileSync(join(ctx.sessionManager.getSessionDir(), FILE_NAME), "utf8"));
		return valid(value) ? normalize(value) : undefined;
	} catch { return undefined; }
}

export default function handoff(pi: ExtensionAPI): void {
	let state = empty();
	let context: ExtensionContext | undefined;
	let turnsSinceUpdate = 0;
	const persist = () => { state.updated_at = Date.now(); turnsSinceUpdate = 0; latestState = state; latestTurns = 0; pi.appendEntry(ENTRY_TYPE, state); if (context) writeDurable(context, state); };
	const restore = (ctx: ExtensionContext) => {
		context = ctx;
		const saved = readDurable(ctx);
		for (const entry of ctx.sessionManager.getBranch() as any[]) if (entry.type === "custom" && entry.customType === ENTRY_TYPE && valid(entry.data)) state = normalize(entry.data);
		if (saved && saved.updated_at > state.updated_at) state = saved;
		turnsSinceUpdate = 0;
		latestState = state;
		latestTurns = 0;
	};
	pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => restore(ctx));
	pi.on(PI_EVENT.SESSION_TREE, async (_event, ctx) => restore(ctx));
	pi.on(PI_EVENT.AGENT_START, async () => { turnsSinceUpdate++; latestTurns = turnsSinceUpdate; });
	pi.on(PI_EVENT.BEFORE_AGENT_START, async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}\n\n${summary(state)}` }));
	pi.registerTool({
		name: TOOL_NAME,
		label: "Handoff",
		description: "Maintain compact durable continuation state so compaction and restarts do not lose decisions or verified facts.",
		parameters: Type.Object({ action: StringEnum(ACTIONS), goal: Type.Optional(Type.String()), constraints: Type.Optional(Type.Array(Type.String())), decisions: Type.Optional(Type.Array(Type.String())), done: Type.Optional(Type.Array(Type.String())), in_progress: Type.Optional(Type.Array(Type.String())), files: Type.Optional(Type.Array(Type.String())), verification: Type.Optional(Type.Array(Type.String())), errors: Type.Optional(Type.Array(Type.String())), next: Type.Optional(Type.Array(Type.String())), rollback: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, input: HandoffInput) {
			if (input.action === "clear") state = empty();
			else if (input.action === "update") {
				const next = normalize({ ...state, ...Object.fromEntries(fields.map((field) => [field, input[field]])) });
				for (const field of fields) if (input[field] === undefined) (next as any)[field] = state[field];
				state = next;
			}
			persist();
			return { content: [{ type: "text" as const, text: summary(state) }], details: state };
		},
	});
	pi.registerCommand("handoff", { description: "Show durable continuation state", handler: async (_args, ctx) => ctx.ui.notify(summary(state), NOTE_INFO) });
}

export function handoffNudge(): string | undefined {
	const hasFacts = Boolean(latestState.goal) || fields.slice(1).some((field) => (latestState[field] as string[]).length > 0);
	if (!hasFacts) return "Handoff is empty; record the current goal, decisions, files, and next step with the handoff tool.";
	if (latestTurns >= 5) return `Handoff is ${latestTurns} turns old; refresh it with verified progress before continuing.`;
	return undefined;
}
