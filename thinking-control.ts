/**
 * thinking-control — a /think slash command, and thinking genuinely off by default.
 *
 * pi ships no slash command for the thinking level: it is reachable only via the
 * Shift+Tab cycle (`app.thinking.cycle`), the `defaultThinkingLevel` setting, or
 * `pi.setThinkingLevel()` from an extension. This adds `/think <level>`.
 *
 * The second half matters more. Setting a level to "off" is not by itself enough
 * for these local models. pi only emits `reasoning_effort` when the model declares
 * `compat.supportsReasoningEffort`, and it maps "off" through `thinkingLevelMap.off`
 * — neither is set for the llama-swap models, so pi sends nothing at all and the
 * chat template decides. Qwen3.8's template decides badly:
 *
 *     {%- if enable_thinking is undefined or enable_thinking is true %}
 *     {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
 *
 * Undefined means on, and unspecified effort means *xhigh* — the most expensive
 * setting there is, chosen silently. That is why replies opened with long reasoning
 * blocks, and why one of them burned the whole 72-token budget it had been given
 * without ever reaching an answer.
 *
 * So "off" is enforced where the template actually reads it, as a chat template
 * kwarg. The same template raises a Jinja exception (a 500, not a warning) for any
 * effort outside ('xhigh', 'medium', 'low'), so levels are mapped into that set
 * rather than passed through.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Effort values each model's chat template will accept. A model absent from this
 * map is left entirely alone — pi's own handling is correct for hosted providers.
 */
const TEMPLATE_EFFORTS: Record<string, Partial<Record<ThinkingLevel, string>>> = {
	// Qwen3.8 accepts only xhigh | medium | low, and raises on anything else.
	"qwen3.8-27b": { minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" },
};

function levelFor(ctx: ExtensionContext): ThinkingLevel {
	return ((ctx as { thinkingLevel?: ThinkingLevel }).thinkingLevel ?? "off") as ThinkingLevel;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("think", {
		description: "Set the thinking level (off | minimal | low | medium | high | xhigh | max)",
		getArgumentCompletions: (prefix: string) => {
			const items = LEVELS.filter((l) => l.startsWith(prefix)).map((l) => ({ value: l, label: l }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const wanted = args.trim().toLowerCase() as ThinkingLevel;
			if (!wanted) {
				ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}. Usage: /think ${LEVELS.join(" | ")}`, "info");
				return;
			}
			if (!LEVELS.includes(wanted)) {
				ctx.ui.notify(`Unknown level "${args.trim()}". Use one of: ${LEVELS.join(", ")}`, "error");
				return;
			}
			// pi clamps to what the model supports, so report what actually took effect.
			pi.setThinkingLevel(wanted);
			ctx.ui.notify(`Thinking: ${pi.getThinkingLevel()}`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		const modelId = (ctx.model as { id?: string } | undefined)?.id;
		if (!modelId || !(modelId in TEMPLATE_EFFORTS)) return;

		const level = levelFor(ctx);
		const kwargs = { ...((payload.chat_template_kwargs as Record<string, unknown>) ?? {}) };

		if (level === "off") {
			// The only switch this template reads. Without it the template defaults
			// to thinking on at xhigh effort, whatever pi believes the level to be.
			kwargs.enable_thinking = false;
			const next = { ...payload, chat_template_kwargs: kwargs };
			delete next.reasoning_effort;
			return next;
		}

		kwargs.enable_thinking = true;
		const effort = TEMPLATE_EFFORTS[modelId][level];
		return { ...payload, chat_template_kwargs: kwargs, ...(effort ? { reasoning_effort: effort } : {}) };
	});
}
