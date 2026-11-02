/**
 * muse-proxy Provider Extension for pi
 *
 * Registers `muse`, a chat-only provider that talks to a muse-proxy
 * (https://github.com/uezo/muse-proxy) over its OpenAI-compatible API.
 *
 * Muse runs its own tools in its own sandbox, refuses client-supplied tool
 * definitions (the proxy answers 400) and does not honour a text tool-call
 * protocol, so pi tools are NOT bridged: the provider drops them and Muse
 * answers in text. Muse owns the conversation history per `session_id` and the
 * proxy forwards only the last user message, so each turn sends just the new
 * messages (see session.ts).
 *
 * Config (first match wins): env PI_MUSE_PROXY_URL / PI_MUSE_PROXY_KEY, then
 * ~/.pi/agent/muse-proxy.json {"baseUrl": "...", "apiKey": "..."}.
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BASE_URL, errorMessageFromBody, loadConfig } from "./config.ts";
import { DEFAULT_LIMITS, SessionTracker, type MuseMessage } from "./session.ts";

const { createAssistantMessageEventStream } = piAi;

const PROVIDER_ID = "muse";
const MODEL_ID = "muse";
// The proxy gives up after request_timeout_seconds (180 by default).
const REQUEST_TIMEOUT_MS = 200_000;

const piAiCompat = piAi as unknown as {
  getCurrentSystemPrompt?: (messages: Message[]) => string | undefined;
};

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
      const plan = tracker.plan(
        context.messages as unknown as MuseMessage[],
        getSystemPrompt(context),
        process.cwd(),
        { ...DEFAULT_LIMITS, maxChars: config.maxChars },
      );

      const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (options?.signal) signals.push(options.signal);
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL_ID,
          session_id: plan.sessionId,
          stream: false,
          messages: [{ role: "user", content: plan.content }],
        }),
        signal: AbortSignal.any(signals),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(errorMessageFromBody(response.status, body));

      const parsed = JSON.parse(body);
      const text: string = (parsed?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error("muse-proxy returned an empty reply (the request may have been superseded or cancelled)");
      tracker.commit(plan);

      const contentIndex = output.content.length;
      output.content.push({ type: "text", text });
      stream.push({ type: "text_start", contentIndex, partial: output });
      stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
      stream.push({ type: "text_end", contentIndex, content: text, partial: output });

      output.stopReason = "stop";
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
        name: "Muse (muse-proxy, chat only)",
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
