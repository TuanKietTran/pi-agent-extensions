/**
 * One-shot dispatch to a headless Claude Code run.
 *
 * Unlike the provider, this does not become the session's model — it hands a
 * single self-contained task to a fresh `claude -p` in the given directory and
 * streams the activity back so the caller can show progress.
 */

import { createJsonLineReader, formatToolCall, spawnClaude } from "./claude";

export interface DispatchProgress {
  kind: "text" | "tool";
  text: string;
}

export interface DispatchResult {
  text: string;
  toolCount: number;
  cost: number;
  error?: string;
}

export interface RunClaudeOptions {
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  appendSystemPrompt?: string;
  onProgress?: (progress: DispatchProgress) => void;
}

interface Block {
  isTool: boolean;
  toolName?: string;
  inputJson: string;
}

export async function runClaude(prompt: string, options: RunClaudeOptions): Promise<DispatchResult> {
  const result: DispatchResult = { text: "", toolCount: 0, cost: 0 };
  const blocks = new Map<number, Block>();
  let stderr = "";

  const proc = spawnClaude({
    prompt,
    cwd: options.cwd,
    model: options.model,
    appendSystemPrompt: options.appendSystemPrompt,
  });

  const read = createJsonLineReader((event: any) => {
    if (event.type === "result") {
      if (event.total_cost_usd != null) result.cost = event.total_cost_usd;
      if (event.subtype === "error") result.error = event.error ?? "claude CLI error";
      // `result` carries the final answer; keep it only if nothing streamed.
      if (!result.text.trim() && typeof event.result === "string") result.text = event.result;
      return;
    }
    if (event.type !== "stream_event") return;

    const e = event.event;

    if (e.type === "content_block_start") {
      blocks.set(e.index, {
        isTool: e.content_block.type === "tool_use",
        toolName: e.content_block.name,
        inputJson: "",
      });
      return;
    }

    if (e.type === "content_block_delta") {
      const block = blocks.get(e.index);
      if (!block) return;
      if (e.delta.type === "text_delta" && !block.isTool) {
        result.text += e.delta.text;
        options.onProgress?.({ kind: "text", text: e.delta.text });
      } else if (e.delta.type === "input_json_delta" && block.isTool) {
        block.inputJson += e.delta.partial_json;
      }
      return;
    }

    if (e.type === "content_block_stop") {
      const block = blocks.get(e.index);
      if (!block?.isTool) return;
      result.toolCount += 1;
      options.onProgress?.({
        kind: "tool",
        text: formatToolCall(block.toolName ?? "tool", block.inputJson),
      });
    }
  });

  proc.stdout?.on("data", read);
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const onAbort = () => proc.kill("SIGTERM");
  options.signal?.addEventListener("abort", onAbort);

  try {
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0 || result.text.trim()) resolve();
        else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      });
      proc.on("error", reject);
    });
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (options.signal?.aborted) result.error = result.error ?? "aborted";
  return result;
}
