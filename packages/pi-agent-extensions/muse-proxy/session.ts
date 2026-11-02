/**
 * Pure helpers for the muse-proxy provider: Muse keeps the conversation
 * server-side per `session_id` and the proxy forwards only the LAST user
 * message, so each turn sends just the messages Muse has not seen yet.
 */

import { createHash, randomBytes } from "node:crypto";

export interface MuseBlock {
  type: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

export interface MuseMessage {
  role: string;
  content: string | MuseBlock[];
  toolName?: string;
  isError?: boolean;
}

export interface PlanLimits {
  /** Hard cap for the whole message (the proxy default is 16000). */
  maxChars: number;
  /** Share of the cap pi's system prompt may take on a fresh session. */
  systemChars: number;
}

export const DEFAULT_LIMITS: PlanLimits = { maxChars: 15000, systemChars: 3000 };

export const NO_TOOLS_NOTE =
  "Note: this chat is connected to a coding harness that cannot run host tools through this connection. Answer in plain text; do not emit tool calls.";

export function textOf(content: MuseMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Keep the head and tail of an oversized text so both ends survive. */
export function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const marker = "\n[… clipped …]\n";
  if (max <= marker.length + 8) return text.slice(0, max);
  const keep = max - marker.length;
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + marker + text.slice(text.length - (keep - head));
}

/** One line-block per message Muse should see; assistant turns are Muse's own. */
export function formatMessage(message: MuseMessage, includeAssistant: boolean): string | undefined {
  if (message.role === "assistant") {
    if (!includeAssistant) return undefined;
    const text = textOf(message.content).trim();
    return text ? `Assistant: ${text}` : undefined;
  }
  if (message.role === "toolResult") {
    const text = textOf(message.content).trim();
    return `Tool result (${message.isError ? "error" : "success"}) for ${message.toolName ?? "tool"}:\n${text}`;
  }
  if (message.role === "system") return undefined;
  const text = textOf(message.content).trim();
  return text || undefined;
}

export function conversationKey(messages: MuseMessage[], salt = ""): string {
  const first = messages.find((message) => message.role === "user");
  const text = first ? textOf(first.content).slice(0, 2000) : "";
  return createHash("sha1").update(salt).update("\u0000").update(text).digest("hex");
}

export function newSessionId(): string {
  // The proxy accepts 1-64 ASCII letters, digits or hyphens.
  return `pi-${randomBytes(6).toString("hex")}`;
}

export interface Plan {
  key: string;
  sessionId: string;
  content: string;
  /** True when Muse has not seen this conversation (first turn, rewind, restart). */
  fresh: boolean;
  /** Message count to record once the request succeeds. */
  sentAfter: number;
}

interface State {
  sessionId: string;
  sent: number;
}

export class SessionTracker {
  private readonly states = new Map<string, State>();
  private readonly limits: PlanLimits;

  constructor(limits: PlanLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  plan(messages: MuseMessage[], systemPrompt: string | undefined, salt = "", limits: PlanLimits = this.limits): Plan {
    const convo = messages.filter((message) => message.role !== "system");
    if (convo.length === 0) throw new Error("muse-proxy received an empty context");

    const key = conversationKey(convo, salt);
    const state = this.states.get(key);
    const fresh = !state || convo.length < state.sent;
    const sessionId = fresh ? newSessionId() : state!.sessionId;

    const content = fresh
      ? this.freshContent(convo, systemPrompt, limits)
      : this.deltaContent(convo, state!.sent, limits);

    return { key, sessionId, content, fresh, sentAfter: convo.length };
  }

  commit(plan: Plan): void {
    this.states.set(plan.key, { sessionId: plan.sessionId, sent: plan.sentAfter });
  }

  private deltaContent(convo: MuseMessage[], sent: number, limits: PlanLimits): string {
    const fresh = convo.slice(sent).map((m) => formatMessage(m, false)).filter((x): x is string => !!x);
    // Nothing new apart from assistant turns: resend the latest user text rather than nothing.
    const parts = fresh.length > 0 ? fresh : [formatMessage(convo[convo.length - 1], true) ?? ""].filter(Boolean);
    return this.fit([], parts, limits);
  }

  private freshContent(convo: MuseMessage[], systemPrompt: string | undefined, limits: PlanLimits): string {
    const head: string[] = [NO_TOOLS_NOTE];
    if (systemPrompt?.trim()) {
      head.push(`<pi_system>\n${clip(systemPrompt.trim(), limits.systemChars)}\n</pi_system>`);
    }
    const blocks = convo.map((m) => formatMessage(m, true)).filter((x): x is string => !!x);
    return this.fit(head, blocks, limits);
  }

  /** Newest blocks win; the last block is always kept, clipped if it must be. */
  private fit(head: string[], blocks: string[], limits: PlanLimits): string {
    const sep = "\n\n";
    const max = limits.maxChars;
    const headText = head.join(sep);
    const last = blocks[blocks.length - 1] ?? "";
    const reserve = headText.length + (headText ? sep.length : 0);
    const lastBudget = Math.max(max - reserve, Math.floor(max / 2));
    const keptLast = clip(last, lastBudget);

    const history: string[] = [];
    let used = reserve + keptLast.length;
    let dropped = false;
    for (let i = blocks.length - 2; i >= 0; i--) {
      const cost = blocks[i].length + sep.length;
      if (used + cost > max) { dropped = true; break; }
      history.unshift(blocks[i]);
      used += cost;
    }
    const marker = dropped ? ["[earlier messages omitted]"] : [];
    const parts = [headText, ...marker, ...history, keptLast].filter(Boolean);
    return clip(parts.join(sep), max);
  }
}
