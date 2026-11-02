/**
 * muse-proxy Provider Extension for pi
 *
 * Registers `muse`, a provider that talks to a muse-proxy
 * (https://github.com/uezo/muse-proxy) over its OpenAI-compatible API.
 *
 * The proxy rejects client-supplied tool definitions and Muse refuses a
 * "harness" framing, so pi tools travel as plain conversation: the first
 * message says "I'm your hands on my laptop" and lists the tools, Muse asks for
 * one with an `@@RUN {"name":...,"arguments":{...}}` line, the provider
 * captures it as a real pi ToolCall, and the result goes back as "OUTPUT ...".
 * Muse keeps the history per `session_id` and the proxy forwards only the last
 * user message, so each turn sends just the new messages (see session.ts).
 *
 * Config (first match wins): env PI_MUSE_PROXY_URL / PI_MUSE_PROXY_KEY, then
 * ~/.pi/agent/muse-proxy.json {"baseUrl": "...", "apiKey": "..."}.
 */

import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, errorMessageFromBody, loadConfig } from "./config.ts";
import { correctionMessage, parseRuns, type ToolDef } from "./protocol.ts";
import { DEFAULT_LIMITS, SessionTracker, type MuseMessage } from "./session.ts";

const { createAssistantMessageEventStream } = piAi;

const PROVIDER_ID = "muse";
const MODEL_ID = "muse";
// The proxy gives up after request_timeout_seconds (180 by default).
const REQUEST_TIMEOUT_MS = 200_000;

const piAiCompat = piAi as unknown as {
  getCurrentSystemPrompt?: (messages: Message[]) => string | undefined;
  getCurrentTools?: (messages: Message[]) => Tool[];
};

function getTools(context: { messages: Message[]; tools?: Tool[] }): Tool[] {
  if (typeof piAiCompat.getCurrentTools === "function") return piAiCompat.getCurrentTools(context.messages) ?? [];
  return context.tools ?? [];
}

const MAX_FORMAT_RETRIES = 2;

function getSystemPrompt(context: { messages: Message[]; systemPrompt?: string }): string | undefined {
  if (typeof piAiCompat.getCurrentSystemPrompt === "function") {
    return piAiCompat.getCurrentSystemPrompt(context.messages);
  }
  return context.systemPrompt;
}

const tracker = new SessionTracker();

function emptyOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

async function askMuse(
  config: ReturnType<typeof loadConfig>,
  sessionId: string,
  content: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL_ID,
      session_id: sessionId,
      stream: false,
      messages: [{ role: "user", content }],
    }),
    signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(errorMessageFromBody(response.status, body));
  return String(JSON.parse(body)?.choices?.[0]?.message?.content ?? "").trim();
}

function streamMuse(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output = emptyOutput(model);
    try {
      const config = loadConfig();
      const tools = getTools(context);
      const toolDefs: ToolDef[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      const plan = tracker.plan(
        context.messages as unknown as MuseMessage[],
        getSystemPrompt(context),
        process.cwd(),
        { ...DEFAULT_LIMITS, maxChars: config.maxChars },
        toolDefs,
      );

      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (options?.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);

      let content = plan.content;
      let text = "";
      let parsed = parseRuns("", toolDefs);
      for (let attempt = 0; ; attempt++) {
        text = await askMuse(config, plan.sessionId, content, signal);
        if (toolDefs.length === 0) break;
        parsed = parseRuns(text, toolDefs);
        // Ask Muse to fix a malformed request instead of silently dropping it.
        if (parsed.calls.length === 0 && parsed.errors.length > 0 && attempt < MAX_FORMAT_RETRIES) {
          content = correctionMessage(parsed.errors);
          continue;
        }
        break;
      }
      tracker.commit(plan);

      const calls: ToolCall[] = parsed.calls.map((call) => ({
        type: "toolCall",
        id: `muse_${randomUUID()}`,
        name: call.name,
        arguments: call.arguments as ToolCall["arguments"],
      }));
      const prose = calls.length > 0 ? parsed.text : text;

      if (calls.length > 0 && prose) {
        // Muse reasoned before asking for the tool: show it as thinking.
        const contentIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: prose, thinkingSignature: "" } as any);
        stream.push({ type: "thinking_start", contentIndex, partial: output });
        stream.push({ type: "thinking_delta", contentIndex, delta: prose, partial: output });
        stream.push({ type: "thinking_end", contentIndex, content: prose, partial: output });
      } else if (calls.length === 0) {
        if (!prose) throw new Error("muse-proxy returned an empty reply (the request may have been superseded or cancelled)");
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: prose });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: prose, partial: output });
        stream.push({ type: "text_end", contentIndex, content: prose, partial: output });
      }

      for (const call of calls) {
        const contentIndex = output.content.length;
        const block: ToolCall = { ...call, arguments: {} };
        output.content.push(block);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
        block.arguments = call.arguments;
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      }

      output.stopReason = calls.length > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: DEFAULT_BASE_URL,
    apiKey: PROVIDER_ID,
    api: "muse-proxy-api",
    models: [
      {
        id: MODEL_ID,
        name: "Muse (muse-proxy)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
    streamSimple: streamMuse,
  });
}
