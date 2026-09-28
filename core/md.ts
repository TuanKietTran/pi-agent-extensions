import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Read a file relative to core/. Returns "" when missing so callers stay fail-soft. */
export function readCore(rel: string): string {
	try {
		return fs.readFileSync(path.join(CORE_DIR, rel), "utf8");
	} catch {
		return "";
	}
}

/** Every ```json fenced block in the markdown, parsed. */
export function jsonBlocks(md: string): unknown[] {
	const out: unknown[] = [];
	for (const m of md.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
		try {
			out.push(JSON.parse(m[1]));
		} catch {}
	}
	return out;
}

/** First ```text fenced block under the `## name` heading. */
export function prompt(rel: string, name: string): string {
	const m = readCore(rel).match(new RegExp(`^## ${name}[^\\n]*\\n[\\s\\S]*?\`\`\`text\\n([\\s\\S]*?)\`\`\``, "m"));
	return m ? m[1].trim() : "";
}

/** Tunables for one guard, from the first json block of the given md file. */
export function guardSettings<T>(rel: string, guard: string): T {
	const blocks = jsonBlocks(readCore(rel)) as Record<string, unknown>[];
	return (blocks[0]?.[guard] ?? {}) as T;
}
