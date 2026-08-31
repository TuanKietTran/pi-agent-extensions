/**
 * Shared plumbing for talking to the local `claude` binary.
 *
 * Both entry points into Claude go through here: the `claude-cli` provider
 * (which makes a pi session's own turns run on Claude) and one-shot dispatch
 * runs (which hand a single task to a fresh headless Claude). They differ only
 * in what they do with the events, so the spawning and the stream-json parsing
 * live in one place.
 */

import { type ChildProcess, spawn } from "node:child_process";

export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

export interface ClaudeModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** Models exposed by the bundled `claude-cli` provider. */
export const CLAUDE_MODELS: ClaudeModelSpec[] = [
  { id: "claude-opus-5", name: "Claude Opus 5 (CLI)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5 (CLI)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-fable-5", name: "Claude Fable 5 (CLI)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8 (CLI)", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (CLI)", reasoning: true, contextWindow: 200000, maxTokens: 64000 },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5 (CLI)",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 64000,
  },
];

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0].id;

export interface SpawnClaudeOptions {
  prompt: string;
  cwd: string;
  model?: string;
  /**
   * Extra system prompt text. Appended rather than replacing, so Claude keeps
   * its own tool descriptions and CLAUDE.md discovery.
   */
  appendSystemPrompt?: string;
  /**
   * An in-process MCP server to expose to this run — how the dispatch tools
   * reach Claude. Its tools are pre-approved, since a headless run has no one
   * to ask for permission.
   */
  mcp?: { configPath: string; allowedTools: string[] };
}

/**
 * Spawn `claude -p`, with the prompt written to stdin rather than argv.
 *
 * The prompt is the one input with no upper bound — a routed session replays
 * its conversation into every turn — and a command line has a hard one: 32 KB
 * on Windows, past which spawn fails with ENAMETOOLONG and the session dies.
 * stdin has no such limit, so only bounded things (flags, the system prompt)
 * are passed as arguments.
 */
export function spawnClaude(options: SpawnClaudeOptions): ChildProcess {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--add-dir",
    options.cwd,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.mcp) {
    args.push("--mcp-config", options.mcp.configPath);
    if (options.mcp.allowedTools.length > 0) {
      args.push("--allowedTools", ...options.mcp.allowedTools);
    }
  }

  const proc = spawn(CLAUDE_BIN, args, { cwd: options.cwd, env: { ...process.env } });
  // stdin must be closed, not just written: claude reads the prompt to EOF.
  proc.stdin?.on("error", () => {
    // The child can die before the prompt is fully written; the close/error
    // handlers on the process itself are what report that.
  });
  proc.stdin?.end(options.prompt);
  return proc;
}

/**
 * Feed stdout chunks through this to get one parsed JSON object per line.
 * Returns a `push` for chunks; partial trailing lines are held until complete.
 */
export function createJsonLineReader(onValue: (value: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onValue(JSON.parse(line));
      } catch {
        // Not every line is JSON; ignore anything we cannot parse.
      }
    }
  };
}

/** Render a tool_use block as a single readable line. */
export function formatToolCall(name: string, inputJson: string): string {
  try {
    const input = JSON.parse(inputJson || "{}");
    if (name === "Bash" && input.command) return `▶ Bash: \`${input.command}\``;
    if ((name === "Read" || name === "Write" || name === "Edit") && input.file_path) {
      return `▶ ${name}: ${input.file_path}`;
    }
    if (name === "Glob" && input.pattern) return `▶ Glob: ${input.pattern}`;
    if (name === "WebFetch" && input.url) return `▶ WebFetch: ${input.url}`;
    const first = Object.entries(input)[0];
    if (first) return `▶ ${name}: ${String(first[1]).slice(0, 120)}`;
    return `▶ ${name}`;
  } catch {
    return `▶ ${name}`;
  }
}
