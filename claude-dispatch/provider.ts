/**
 * The `claude-cli` provider: makes a pi session's own turns run on the local
 * `claude` binary. Auth comes from whatever `claude` is already logged in as,
 * so there is no separate API key to configure.
 *
 * Derived from pi-extension-claude-cli. Bundled here so claude-dispatch is
 * self-contained — if you also have that extension installed, both register
 * the same provider name with equivalent models and the last one loaded wins.
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLAUDE_MODELS, createJsonLineReader, formatToolCall, spawnClaude } from "./claude";
import type { McpHandle } from "./mcp";

export const CLAUDE_PROVIDER = "claude-cli";

/**
 * Supplies the dispatch MCP server to every run. Resolved lazily and per turn,
 * because the server is owned by the session (which starts after the provider
 * is registered) and may legitimately be unavailable.
 */
type McpProvider = () => Promise<McpHandle | undefined>;

let getMcp: McpProvider | undefined;

/** Tells Claude what the mcp__pi-dispatch__* tools are for. */
const DISPATCH_BRIEFING =
  "You are running as the model behind a pi coding-agent session on this machine. " +
  "The mcp__pi-dispatch__* tools reach the other live pi sessions belonging to this " +
  "same user: list them, queue a prompt into one (it runs there, in its own directory " +
  "and conversation — not here), or read a session's recent activity. Use them when " +
  "the user asks about other sessions or wants work handed to one.";

function messageText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return (content as any[])
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n");
}

function buildHistory(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      parts.push(`Human: ${messageText(message.content)}`);
    } else if (message.role === "assistant") {
      const text = (message.content as any[])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) parts.push(`Assistant: ${text}`);
    }
  }
  return parts.join("\n\n");
}

function streamClaudeCLI(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
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
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Internal bookkeeping stripped before the message is handed back to pi.
    type TrackedBlock = (ThinkingContent | TextContent) & {
      _idx?: number;
      _isToolCall?: boolean;
      _toolName?: string;
      _inputJson?: string;
    };

    const scrub = () => {
      for (const block of output.content) {
        delete (block as any)._idx;
        delete (block as any)._isToolCall;
        delete (block as any)._toolName;
        delete (block as any)._inputJson;
      }
    };

    try {
      const messages = context.messages;
      const last = messages[messages.length - 1];
      const history = messages.slice(0, -1);

      const mcp = await getMcp?.();

      const appendParts: string[] = [];
      if (context.systemPrompt) appendParts.push(context.systemPrompt);
      if (mcp) appendParts.push(DISPATCH_BRIEFING);

      // The transcript rides in the prompt, which goes over stdin. It is the
      // part that grows without limit, so it is the part that must not be an
      // argument.
      const promptParts: string[] = [];
      if (history.length > 0) {
        promptParts.push(`<conversation_history>\n${buildHistory(history)}\n</conversation_history>`);
      }
      promptParts.push(messageText(last.content));

      const proc = spawnClaude({
        prompt: promptParts.join("\n\n"),
        cwd: process.cwd(),
        model: model.id,
        appendSystemPrompt: appendParts.length > 0 ? appendParts.join("\n\n") : undefined,
        mcp: mcp ? { configPath: mcp.configPath, allowedTools: mcp.allowedTools } : undefined,
      });

      stream.push({ type: "start", partial: output });

      const blocks: TrackedBlock[] = [];
      let stderr = "";
      let failure: Error | undefined;

      const read = createJsonLineReader((event: any) => {
        if (event.type === "result") {
          if (event.total_cost_usd != null) output.usage.cost.total = event.total_cost_usd;
          if (event.is_error || event.subtype === "error") {
            failure = new Error(event.error ?? event.result ?? "claude CLI error");
          }
          return;
        }
        if (event.type !== "stream_event") return;

        const e = event.event;

        if (e.type === "message_start" && e.message?.usage) {
          const usage = e.message.usage;
          output.usage.input = usage.input_tokens ?? 0;
          output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
          output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
          return;
        }

        if (e.type === "content_block_start") {
          if (e.content_block.type === "text") {
            const block = { type: "text" as const, text: "", _idx: e.index } as TrackedBlock;
            output.content.push(block as any);
            blocks.push(block);
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
          } else if (e.content_block.type === "thinking") {
            const block = {
              type: "thinking" as const,
              thinking: "",
              thinkingSignature: "",
              _idx: e.index,
            } as TrackedBlock;
            output.content.push(block as any);
            blocks.push(block);
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (e.content_block.type === "tool_use") {
            // Held as a text block; emitted as a "▶ Tool" line once the input
            // JSON has finished streaming and can actually be formatted.
            const block = {
              type: "text" as const,
              text: "",
              _idx: e.index,
              _isToolCall: true,
              _toolName: e.content_block.name,
              _inputJson: "",
            } as TrackedBlock;
            output.content.push(block as any);
            blocks.push(block);
          }
          return;
        }

        if (e.type === "content_block_delta") {
          const block = blocks.find((b) => b._idx === e.index);
          if (!block) return;
          const contentIndex = output.content.indexOf(block as any);

          if (e.delta.type === "text_delta" && block.type === "text" && !block._isToolCall) {
            (block as any).text += e.delta.text;
            stream.push({ type: "text_delta", contentIndex, delta: e.delta.text, partial: output });
          } else if (e.delta.type === "thinking_delta" && block.type === "thinking") {
            (block as any).thinking += e.delta.thinking;
            stream.push({ type: "thinking_delta", contentIndex, delta: e.delta.thinking, partial: output });
          } else if (e.delta.type === "signature_delta" && block.type === "thinking") {
            (block as any).thinkingSignature = ((block as any).thinkingSignature ?? "") + e.delta.signature;
          } else if (e.delta.type === "input_json_delta" && block._isToolCall) {
            block._inputJson = (block._inputJson ?? "") + e.delta.partial_json;
          }
          return;
        }

        if (e.type === "content_block_stop") {
          const block = blocks.find((b) => b._idx === e.index);
          if (!block) return;
          const contentIndex = output.content.indexOf(block as any);
          block._idx = undefined;

          if (block._isToolCall) {
            const line = `${formatToolCall(block._toolName ?? "tool", block._inputJson ?? "")}\n\n`;
            (block as any).text = line;
            stream.push({ type: "text_start", contentIndex, partial: output });
            stream.push({ type: "text_delta", contentIndex, delta: line, partial: output });
            stream.push({ type: "text_end", contentIndex, content: line, partial: output });
            block._isToolCall = undefined;
          } else if (block.type === "text") {
            stream.push({ type: "text_end", contentIndex, content: (block as any).text, partial: output });
          } else if (block.type === "thinking") {
            stream.push({ type: "thinking_end", contentIndex, content: (block as any).thinking, partial: output });
          }
          return;
        }

        if (e.type === "message_delta" && e.usage) {
          output.usage.output = e.usage.output_tokens ?? 0;
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        }
      });

      proc.stdout?.on("data", read);
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
          if (failure) reject(failure);
          else if (code === 0) resolve();
          else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        });
        proc.on("error", reject);
        options?.signal?.addEventListener("abort", () => proc.kill("SIGTERM"));
      });

      scrub();
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      scrub();
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export function registerClaudeProvider(pi: ExtensionAPI, mcpProvider?: McpProvider): void {
  getMcp = mcpProvider;
  pi.registerProvider(CLAUDE_PROVIDER, {
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-cli",
    api: "claude-cli-api",
    models: CLAUDE_MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
    streamSimple: streamClaudeCLI,
  } as any);
}
