/**
 * context-guard — stops a single tool result from blowing the context window.
 *
 * pi's built-in cap is 50KB / 2000 lines, which is ~12k tokens: fine for a
 * 200k cloud model, fatal for a local one. A `ls -R` that returned 31KB is what
 * wedged session 01a039e0 — every retry resent the oversized history and the
 * llama.cpp server answered 400 exceed_context_size_error forever.
 *
 * This scales the cap to whatever model is actually active (a share of its
 * context window) and spills the full output to a file so nothing is lost.
 *
 * Truncation keeps both ends and elides the middle. A recursive listing names
 * its directories at the top while a build or test run puts the verdict at the
 * bottom, and the tool name alone does not say which of the two a `bash` call
 * is, so keeping one end only guesses wrong half the time.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";

/** Share of the context window one tool result may occupy. */
const RESULT_SHARE = 0.06;
const CHARS_PER_TOKEN = 4;
/** Never cap below this — small caps make the model blind. */
const MIN_BYTES = 4_000;
/** pi's own ceiling; this extension only ever tightens it. */
const MAX_BYTES = 50_000;
const MAX_LINES = 400;
/** How much of the budget goes to the head; the rest keeps the tail. */
const HEAD_SHARE = 0.4;

const SPILL_DIR = join(tmpdir(), "pi-context-guard");

interface Trim {
	content: string;
	truncated: boolean;
	keptLines: number;
	totalLines: number;
	keptBytes: number;
	totalBytes: number;
}

function bytes(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

function trimMiddle(text: string, maxBytes: number, maxLines: number): Trim {
	const totalBytes = bytes(text);
	const lines = text.split("\n");
	const totalLines = lines.length;
	if (totalBytes <= maxBytes && totalLines <= maxLines) {
		return { content: text, truncated: false, keptLines: totalLines, totalLines, keptBytes: totalBytes, totalBytes };
	}

	const maxHeadLines = Math.floor(maxLines * HEAD_SHARE);
	const maxHeadBytes = Math.floor(maxBytes * HEAD_SHARE);
	const head: string[] = [];
	let headBytes = 0;
	for (const line of lines) {
		if (head.length >= maxHeadLines || headBytes + bytes(line) + 1 > maxHeadBytes) break;
		head.push(line);
		headBytes += bytes(line) + 1;
	}

	const maxTailLines = maxLines - head.length;
	const maxTailBytes = maxBytes - headBytes;
	const tail: string[] = [];
	let tailBytes = 0;
	for (let i = lines.length - 1; i >= head.length; i--) {
		const line = lines[i];
		if (tail.length >= maxTailLines || tailBytes + bytes(line) + 1 > maxTailBytes) break;
		tail.unshift(line);
		tailBytes += bytes(line) + 1;
	}

	const omitted = totalLines - head.length - tail.length;
	const content = [...head, `[… ${omitted} lines elided by context-guard …]`, ...tail].join("\n");
	return {
		content,
		truncated: true,
		keptLines: head.length + tail.length,
		totalLines,
		keptBytes: bytes(content),
		totalBytes,
	};
}

function budgetFor(ctx: ExtensionContext): number {
	const window = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
	if (!window) return MAX_BYTES;
	const budget = Math.floor(window * RESULT_SHARE * CHARS_PER_TOKEN);
	return Math.min(MAX_BYTES, Math.max(MIN_BYTES, budget));
}

function spill(toolName: string, toolCallId: string, text: string): string | undefined {
	try {
		mkdirSync(SPILL_DIR, { recursive: true });
		const path = join(SPILL_DIR, `${toolName}-${toolCallId}.txt`);
		writeFileSync(path, text, "utf8");
		return path;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", (event, ctx) => {
		const blocks = Array.isArray(event.content) ? event.content : [];
		const textBlocks = blocks.filter((b: any) => b?.type === "text");
		if (textBlocks.length === 0) return;

		const full = textBlocks.map((b: any) => b.text ?? "").join("\n");
		const trim = trimMiddle(full, budgetFor(ctx), MAX_LINES);
		if (!trim.truncated) return;

		// When pi's own 50KB/2000-line cap already fired it saved the genuinely
		// complete output; point at that rather than spilling a second, shorter copy.
		const piPath = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
		const path = piPath ?? spill(event.toolName, event.toolCallId, full);
		let notice = `\n\n[context-guard: kept ${trim.keptLines} of ${trim.totalLines} lines`;
		notice += ` (${formatSize(trim.keptBytes)} of ${formatSize(trim.totalBytes)}).`;
		if (piPath) {
			notice += ` Complete untruncated output: ${path}.`;
		} else if (path) {
			notice += ` Output as received: ${path}.`;
		} else {
			notice += ` The trimmed content could not be saved.`;
		}
		notice += ` Do NOT re-run the same broad command — narrow it (head/tail, a subdirectory,`;
		notice += ` --max-depth) or grep the saved file instead.]`;

		if (ctx.hasUI) {
			ctx.ui.notify(`context-guard trimmed ${event.toolName} output to ${formatSize(trim.keptBytes)}`, "info");
		}

		// Keep non-text blocks (images etc.) after the trimmed text.
		const kept = blocks.filter((b: any) => b?.type !== "text");
		return { content: [{ type: "text", text: trim.content + notice }, ...kept] };
	});
}
