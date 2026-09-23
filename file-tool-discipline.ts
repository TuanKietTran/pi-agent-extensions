// file-tool-discipline — keep GPT file mutations on Pi's auditable write/edit tools.
//
// GPT coding models are strongly trained to use shell heredocs and small Python/
// Node scripts. Pi exposes `write`, but its built-in prompt only says to use it
// for new files or complete rewrites, so shell authoring remains common. This
// extension adds explicit guidance and blocks only obvious direct content writes;
// normal shell commands, generated build artifacts, logs, and temporary files
// remain available.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FILE_POLICY = `## File mutation policy for GPT models
- Use Pi's write tool to create new source, configuration, documentation, and test files, or to replace a file completely.
- Use Pi's edit tool for targeted changes to existing files.
- Do not author those files through bash/powershell, shell redirection, cat/tee heredocs, sed -i, or Python/Node/Ruby/Perl filesystem APIs.
- Shell commands may still create compiler/build artifacts, dependency metadata, logs, PID files, and files under temporary directories.`;

function isGpt(ctx: ExtensionContext): boolean {
  const provider = ctx.model?.provider.toLowerCase() ?? "";
  const model = ctx.model?.id.toLowerCase() ?? "";
  return provider.includes("openai") || model.startsWith("gpt-");
}

function hasFileTools(pi: ExtensionAPI): boolean {
  const active = new Set(pi.getActiveTools());
  return active.has("write") && active.has("edit");
}

function isTemporaryTarget(target: string): boolean {
  const value = target.replace(/^['"]|['"]$/g, "");
  return value === "/dev/null"
    || value.startsWith("/tmp/")
    || value.startsWith("${TMPDIR}")
    || value.startsWith("$TMPDIR")
    || value.startsWith("${TMP}")
    || value.startsWith("$TMP");
}

function hasProjectRedirection(command: string): boolean {
  const redirects = command.matchAll(/(?:^|[\s;&|])(?:\d*)(?:>>|>)[ \t]*(?!&)("[^"]+"|'[^']+'|[^\s;&|]+)/gm);
  for (const match of redirects) {
    if (!isTemporaryTarget(match[1] ?? "")) return true;
  }
  return false;
}

function hasProjectTeeTarget(command: string): boolean {
  const invocations = command.matchAll(/(?:^|[;&|]\s*)tee\b(?:\s+-[^\s]+)*\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gm);
  for (const match of invocations) {
    if (!isTemporaryTarget(match[1] ?? "")) return true;
  }
  return false;
}

export function directlyAuthorsFile(toolName: string, command: string): boolean {
  if (toolName === "powershell") {
    return /\b(?:Set-Content|Add-Content|Out-File)\b|\[IO\.File\]::Write(?:AllText|AllLines|AllBytes)/i.test(command);
  }
  if (toolName !== "bash") return false;

  const shellAuthor = (
    /(?:^|[;&|]\s*)(?:cat|echo|printf)\b/m.test(command) && hasProjectRedirection(command)
  ) || hasProjectTeeTarget(command);
  const inPlaceEditor = /\b(?:sed\s+(?:-[^\s]*i[^\s]*|--in-place)|perl\s+-[^\s]*i[^\s]*)\b/i.test(command);
  const scriptWriter = /\b(?:writeFile(?:Sync)?|write_text|write_bytes)\s*\(|\bopen\s*\([^\n,]+,[^\n]*(?:['"]w['"]|['"]a['"])/i.test(command);
  const explicitFileApi = /\b(?:fs\.|Deno\.|Bun\.)write(?:File|TextFile)|\bFile\.write\b/i.test(command);

  return shellAuthor || inPlaceEditor || scriptWriter || explicitFileApi;
}

export default function fileToolDiscipline(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!isGpt(ctx) || !hasFileTools(pi)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${FILE_POLICY}` };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!isGpt(ctx) || !hasFileTools(pi)) return;
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const command = (event.input as { command?: unknown })?.command;
    if (typeof command !== "string" || !directlyAuthorsFile(event.toolName, command)) return;

    return {
      block: true,
      reason: "Use Pi's write tool for new/full files or edit for targeted changes; direct shell-based file authoring is disabled for GPT models.",
    };
  });
}
