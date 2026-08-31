/**
 * answer-floor — stops the model's own reply from being cut off mid-sentence.
 *
 * Companion to context-guard.ts, which trims oversized *tool results*. This one
 * protects the opposite side: the answer budget.
 *
 * pi sizes every request with (ai/src/api/simple-options.ts):
 *
 *     available = model.contextWindow - estimatedContextTokens - 4096
 *     max_tokens = min(model.maxTokens, max(1, available))
 *
 * CONTEXT_SAFETY_TOKENS is a hardcoded 4096 and MIN_MAX_TOKENS is 1, so on a
 * small local window the budget collapses silently rather than erroring. That is
 * what cut session 01a0559f off mid-thought: an 8192-token window with 4024
 * tokens of context yielded max_tokens = 8192 - 4024 - 4096 = 72, and the reply
 * stopped after exactly 72 tokens with finish_reason "length".
 *
 * The settings are now sized so this cannot happen (compaction.reserveTokens >=
 * 4096 + model.maxTokens keeps `available` above the model's own ceiling). This
 * hook is the backstop for when they drift — a new model added to models.json
 * with a small window, or a hand-edited reserveTokens. It restores a usable
 * floor and says so, because a squeezed budget is a configuration bug and should
 * never pass unnoticed.
 *
 * The floor is safe to raise: llama.cpp bounds generation by its own n_ctx and
 * simply stops, so an over-large max_tokens cannot overflow the server. Only the
 * prompt can do that, and this hook does not touch the prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Enough to finish a reasoning block and the answer that follows it. */
const FLOOR_TOKENS = 2048;

/** The fields the various provider payloads use for the output cap. */
const CAP_FIELDS = ["max_tokens", "max_completion_tokens", "maxOutputTokens"] as const;

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;

		// Never ask for more than the model is declared to produce.
		const ceiling = (ctx.model as { maxTokens?: number } | undefined)?.maxTokens;
		const floor = ceiling && ceiling > 0 ? Math.min(FLOOR_TOKENS, ceiling) : FLOOR_TOKENS;

		let patched: Record<string, unknown> | undefined;
		for (const field of CAP_FIELDS) {
			const current = payload[field];
			if (typeof current !== "number" || current >= floor) continue;
			patched ??= { ...payload };
			patched[field] = floor;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`answer-floor: ${field} was ${current}, raised to ${floor}. ` +
						`Context is close to the window — compact or widen it.`,
					"info",
				);
			}
		}
		return patched;
	});

	// A "length" stop is the model being interrupted, not finishing. Surface it:
	// silent truncation is what made the original failure so hard to spot.
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string } | undefined;
		if (message?.role !== "assistant" || message.stopReason !== "length") return;
		if (!ctx.hasUI) return;
		ctx.ui.notify(
			"Reply hit the output cap and was cut off — it is incomplete. " +
				"Ask it to continue, or run /compact to free budget.",
			"error",
		);
	});
}
