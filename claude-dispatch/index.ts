/**
 * claude-dispatch — hooks every pi session to Claude, and lets any session
 * drive the others.
 *
 * Two halves:
 *
 *  1. Routing. On session start the session is switched to the bundled
 *     `claude-cli` provider, so `pi "…"` runs on Claude everywhere without a
 *     --provider flag. Opt out per session with --no-claude-dispatch or
 *     /dispatch off, globally with /dispatch default off.
 *
 *  2. Control plane. Every session registers itself in a file-backed registry
 *     under ~/.pi/agent/dispatch, so any session can list its peers, send them
 *     prompts, follow their activity, or abort them — and can hand a one-shot
 *     task to a headless Claude Code run in any directory.
 *
 * Commands: /dispatch list | send | broadcast | attach | detach | tail | stop
 *                     | claude | on | off | status | default
 * Tool: dispatch (so the model can orchestrate sibling sessions itself)
 */

import { basename } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "./claude";
import { runClaude } from "./dispatch";
import { type McpHandle, startMcpServer } from "./mcp";
import { registerClaudeProvider } from "./provider";
import * as registry from "./registry";

const HEARTBEAT_MS = 10_000;
const ATTACH_POLL_MS = 700;
const REPORT_ENTRY = "claude-dispatch-report";

interface Report {
  title: string;
  lines: string[];
}

const shortId = (id: string) => id.slice(0, 8);

function relTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function peerLabel(peer: registry.Peer): string {
  return peer.name?.trim() || basename(peer.cwd) || peer.cwd;
}

/**
 * @param idChars how much of the session id to show — never less than it takes
 * to tell the listed sessions apart, or the line names a handle nobody can use.
 */
function peerLine(peer: registry.Peer, selfId?: string, idChars = 8): string {
  const marker = peer.sessionId === selfId ? "•" : " ";
  const model = peer.routed ? "claude" : (peer.model ?? "?");
  const busy = peer.state === "busy" ? "busy" : "idle";
  return `${marker} ${peer.sessionId.slice(0, idChars)}  ${busy}  ${model.padEnd(18)}  ${peerLabel(peer)}  (${peer.cwd}, ${relTime(peer.updatedAt)} ago)`;
}

/** Render a set of peers with ids long enough to be unambiguous. */
function peerLines(peers: registry.Peer[], selfId?: string): string[] {
  const width = registry.idWidth(peers.map((p) => p.sessionId));
  return peers.map((p) => peerLine(p, selfId, width));
}

/** Split "send abc123 do the thing" into ["send", "abc123", "do the thing"]. */
function splitArgs(args: string, count: number): string[] {
  const parts: string[] = [];
  let rest = args.trim();
  while (parts.length < count - 1 && rest) {
    const index = rest.search(/\s/);
    if (index === -1) {
      parts.push(rest);
      rest = "";
    } else {
      parts.push(rest.slice(0, index));
      rest = rest.slice(index).trim();
    }
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Dispatch is driven from Claude, never from a third-party model.
 *
 * Both routes to the control plane are gated on this: pi's `dispatch` tool
 * refuses to run for a non-Anthropic model, and the MCP tools are only ever
 * handed to the Claude subprocess.
 */
function isAnthropic(model?: { provider: string }): boolean {
  return !!model && /anthropic|claude/i.test(model.provider);
}

export default function (pi: ExtensionAPI) {
  registerClaudeProvider(pi, ensureMcp);

  pi.registerFlag("no-claude-dispatch", {
    type: "boolean",
    description: "Do not route this session to Claude",
  });
  pi.registerFlag("dispatch-model", {
    type: "string",
    description: "Claude model to route this session to",
  });

  let peer: registry.Peer | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopInbox: (() => void) | undefined;
  let attached: { sessionId: string; timer: ReturnType<typeof setInterval>; lastSize: number } | undefined;
  /** True once routing has been applied or deliberately declined. */
  let routingSettled = false;
  let optedOut = false;

  // -------------------------------------------------------------------------
  // output
  // -------------------------------------------------------------------------

  pi.registerEntryRenderer<Report>(REPORT_ENTRY, (entry, _options, theme) => {
    const data = entry.data ?? { title: "dispatch", lines: [] };
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", `⇢ ${data.title}`), 0, 0));
    for (const line of data.lines) box.addChild(new Text(line, 0, 0));
    return box;
  });

  /** Show control-plane output in the transcript without feeding it to the LLM. */
  function report(ctx: ExtensionContext, title: string, lines: string[]): void {
    pi.appendEntry<Report>(REPORT_ENTRY, { title, lines });
    if (ctx.hasUI && lines.length === 0) ctx.ui.notify(title, "info");
  }

  // -------------------------------------------------------------------------
  // registry bookkeeping
  // -------------------------------------------------------------------------

  function touch(ctx: ExtensionContext, patch: Partial<registry.Peer> = {}): void {
    if (!peer) return;
    const config = registry.readConfig();
    peer = {
      ...peer,
      ...patch,
      name: pi.getSessionName() ?? peer.name,
      sessionFile: ctx.sessionManager.getSessionFile() ?? peer.sessionFile,
      provider: ctx.model?.provider ?? peer.provider,
      model: ctx.model?.id ?? peer.model,
      routed: ctx.model?.provider === config.provider,
      updatedAt: Date.now(),
    };
    registry.writePeer(peer);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !peer) return;
    const peers = registry.listPeers().filter((p) => p.sessionId !== peer?.sessionId);
    const suffix = peers.length > 0 ? ` · ${peers.length} peer${peers.length === 1 ? "" : "s"}` : "";
    ctx.ui.setStatus("claude-dispatch", peer.routed ? `⇢ claude${suffix}` : `⇢ off${suffix}`);
  }

  /**
   * Remember what the user actually runs on.
   *
   * pi.setModel() writes its choice through to settings.json as the global
   * default, so the moment we route a session, pi forgets what the user picked.
   * Capture it the first time we see a non-claude model; that record is what
   * /dispatch off and --no-claude-dispatch restore from.
   */
  function captureFallback(ctx: ExtensionContext): void {
    const config = registry.readConfig();
    if (config.fallbackProvider) return;
    const model = ctx.model;
    if (!model || model.provider === config.provider) return;
    registry.writeConfig({ fallbackProvider: model.provider, fallbackModel: model.id });
  }

  /** Put the session back on the user's own model when routing is off. */
  async function restoreFallback(ctx: ExtensionContext): Promise<void> {
    const config = registry.readConfig();
    if (!config.fallbackProvider || !config.fallbackModel) return;
    if (ctx.model && ctx.model.provider !== config.provider) return; // already off claude
    const model = ctx.modelRegistry.find(config.fallbackProvider, config.fallbackModel);
    if (model) await pi.setModel(model);
  }

  /**
   * Switch this session onto the claude provider.
   *
   * Called from both session_start and before_agent_start: extension-registered
   * providers are not guaranteed to be flushed into the model registry by the
   * time session_start fires, so the first attempt may find nothing to switch
   * to and the next turn retries.
   */
  async function ensureRouted(ctx: ExtensionContext): Promise<void> {
    if (routingSettled || !peer) return;

    const config = registry.readConfig();
    if (optedOut || pi.getFlag("no-claude-dispatch") === true || !config.enabled) {
      routingSettled = true;
      await restoreFallback(ctx);
      touch(ctx);
      updateStatus(ctx);
      return;
    }

    const wanted = (pi.getFlag("dispatch-model") as string | undefined) || config.model || DEFAULT_CLAUDE_MODEL;
    const model =
      ctx.modelRegistry.find(config.provider, wanted) ??
      ctx.modelRegistry.find(config.provider, DEFAULT_CLAUDE_MODEL);
    if (!model) return; // provider not registered yet — retry next turn

    if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
      routingSettled = true;
      touch(ctx);
      return;
    }

    const ok = await pi.setModel(model);
    routingSettled = true;
    touch(ctx);
    updateStatus(ctx);
    if (ctx.hasUI) {
      ctx.ui.notify(
        ok ? `claude-dispatch → ${model.id}` : `claude-dispatch could not switch to ${model.id}`,
        ok ? "info" : "warning",
      );
    }
  }

  // -------------------------------------------------------------------------
  // inbox — prompts and control messages sent by other sessions
  // -------------------------------------------------------------------------

  function handleInbox(messages: registry.InboxMessage[], ctx: ExtensionContext): void {
    for (const message of messages) {
      if (message.kind === "abort") {
        ctx.abort();
        if (ctx.hasUI) ctx.ui.notify(`Aborted by ${shortId(message.from)}`, "warning");
        continue;
      }
      if (!message.text?.trim()) continue;

      // Provenance matters, but so does framing: a bare "[dispatch from …]"
      // header reads like injected third-party content and agents refuse it.
      // The registry is local and same-user by construction — only processes
      // running as this user can write to it — so say that plainly.
      const origin = message.from === "cli" ? "the local dispatch CLI" : `pi session ${shortId(message.from)}`;
      const where = message.fromCwd ? ` in ${message.fromCwd}` : "";
      const banner =
        `[dispatch] Instruction relayed from ${origin}${where} — another of your own pi sessions on this machine.\n\n` +
        `${message.text}`;
      pi.sendUserMessage(banner, {
        deliverAs: ctx.isIdle() ? undefined : (message.deliverAs ?? "followUp"),
      });
      if (ctx.hasUI) ctx.ui.notify(`Prompt dispatched from ${origin}`, "info");
    }
  }

  // -------------------------------------------------------------------------
  // attach — follow another session's activity live
  // -------------------------------------------------------------------------

  function detach(ctx: ExtensionContext): void {
    if (!attached) return;
    clearInterval(attached.timer);
    attached = undefined;
    if (ctx.hasUI) ctx.ui.setWidget("claude-dispatch-attach", undefined);
  }

  function attach(ctx: ExtensionContext, target: registry.Peer): void {
    detach(ctx);
    const sessionId = target.sessionId;

    const render = () => {
      const size = registry.outboxSize(sessionId);
      const alive = registry.listPeers().some((p) => p.sessionId === sessionId);
      if (!alive) {
        if (ctx.hasUI) {
          ctx.ui.setWidget("claude-dispatch-attach", [`⇢ ${shortId(sessionId)} ended`]);
          ctx.ui.notify(`Session ${shortId(sessionId)} ended — detached`, "info");
        }
        if (attached) {
          clearInterval(attached.timer);
          attached = undefined;
        }
        return;
      }
      if (attached && size === attached.lastSize) return;
      if (attached) attached.lastSize = size;

      const lines = registry
        .tailOutbox(sessionId, 8)
        .map((event) => `  ${event.kind === "tool" ? "▶" : event.kind === "prompt" ? "»" : " "} ${event.text.replace(/\s+/g, " ").slice(0, 110)}`);
      if (ctx.hasUI) {
        ctx.ui.setWidget("claude-dispatch-attach", [
          `⇢ attached to ${shortId(sessionId)} · ${peerLabel(target)}`,
          ...lines,
        ]);
      }
    };

    const timer = setInterval(render, ATTACH_POLL_MS);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    attached = { sessionId, timer, lastSize: -1 };
    render();
  }

  // -------------------------------------------------------------------------
  // session lifecycle
  // -------------------------------------------------------------------------

  pi.on("session_start", async (event, ctx) => {
    registry.ensureDirs();
    const sessionId = ctx.sessionManager.getSessionId();
    const config = registry.readConfig();

    // A reload keeps the same session id and may have prompts in flight.
    if (event.reason !== "reload") registry.resetInbox(sessionId);

    peer = {
      sessionId,
      pid: process.pid,
      cwd: ctx.cwd,
      mode: ctx.mode,
      sessionFile: ctx.sessionManager.getSessionFile(),
      name: pi.getSessionName(),
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      state: "idle",
      routed: ctx.model?.provider === config.provider,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    registry.writePeer(peer);

    routingSettled = false;
    captureFallback(ctx);
    await ensureRouted(ctx);

    heartbeat = setInterval(() => {
      touch(ctx);
    }, HEARTBEAT_MS);
    if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();

    // The watcher is non-persistent and unref'd, so it can never hold a
    // finished print-mode session open — but while one is still working it can
    // be steered like any other session.
    stopInbox = registry.watchInbox(sessionId, (messages) => handleInbox(messages, ctx));
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    detach(ctx);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    stopInbox?.();
    stopInbox = undefined;
    mcp?.close();
    mcp = undefined;
    mcpStart = undefined;
    if (peer) registry.removePeer(peer.sessionId);
    peer = undefined;
    if (ctx.hasUI) ctx.ui.setStatus("claude-dispatch", undefined);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    touch(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    // A deliberate model change is the user's decision; stop trying to re-route.
    if (event.source !== "restore") routingSettled = true;
    touch(ctx);
    updateStatus(ctx);
  });

  // -------------------------------------------------------------------------
  // activity → outbox, so peers can follow along
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureRouted(ctx);
    touch(ctx, { state: "busy", lastPrompt: event.prompt.slice(0, 200) });
    if (peer) {
      registry.appendOutbox(peer.sessionId, {
        ts: Date.now(),
        kind: "prompt",
        text: event.prompt.slice(0, 300),
      });
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    touch(ctx, { state: "idle" });
    updateStatus(ctx);
  });

  pi.on("tool_execution_start", async (event) => {
    if (!peer) return;
    const first = Object.values(event.args ?? {})[0];
    const detail = first === undefined ? "" : `: ${String(first).slice(0, 100)}`;
    registry.appendOutbox(peer.sessionId, {
      ts: Date.now(),
      kind: "tool",
      text: `${event.toolName}${detail}`,
    });
  });

  pi.on("message_end", async (event) => {
    if (!peer || event.message.role !== "assistant") return;
    const text = (event.message.content as any[])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) {
      registry.appendOutbox(peer.sessionId, { ts: Date.now(), kind: "text", text: text.slice(0, 400) });
    }
  });

  // -------------------------------------------------------------------------
  // shared actions (used by both the command and the tool)
  // -------------------------------------------------------------------------

  function livePeers(): registry.Peer[] {
    return registry.listPeers();
  }

  function otherPeers(): registry.Peer[] {
    return livePeers().filter((p) => p.sessionId !== peer?.sessionId);
  }

  function sendTo(target: registry.Peer, text: string, deliverAs?: "steer" | "followUp"): void {
    registry.pushInbox(target.sessionId, {
      kind: "prompt",
      text,
      from: peer?.sessionId ?? "cli",
      fromCwd: peer?.cwd,
      deliverAs,
    });
  }

  // The four actions a model is allowed to take, as plain text in / text out.
  // pi's `dispatch` tool and the MCP tools handed to Claude are two front doors
  // onto exactly these.

  function actionList(): string {
    const peers = livePeers();
    if (peers.length === 0) return "No live pi sessions.";
    // Full ids for a model: it has to hand one back to send or tail, and it
    // cannot ask a follow-up question of a truncated one.
    return [
      `${peers.length} live pi session(s). • marks this session.`,
      ...peers.map((p) => peerLine(p, peer?.sessionId, p.sessionId.length)),
    ].join("\n");
  }

  function actionSend(session: string, prompt: string): string {
    if (!prompt.trim()) return "A prompt is required.";
    const { peer: found, error } = registry.resolvePeer(session, otherPeers());
    if (!found) return error ?? "No such session";
    sendTo(found, prompt);
    return `Queued prompt into session ${shortId(found.sessionId)} (${found.cwd}). It runs there, not here.`;
  }

  function actionBroadcast(prompt: string): string {
    if (!prompt.trim()) return "A prompt is required.";
    const targets = otherPeers();
    for (const target of targets) sendTo(target, prompt);
    return targets.length === 0
      ? "No other live sessions to broadcast to."
      : `Queued prompt into ${targets.length} session(s): ${targets.map((p) => shortId(p.sessionId)).join(", ")}`;
  }

  function actionTail(session: string, lines?: number): string {
    const { peer: found, error } = registry.resolvePeer(session, livePeers());
    if (!found) return error ?? "No such session";
    const events = registry.tailOutbox(found.sessionId, lines ?? 20);
    if (events.length === 0) return `No recorded activity for ${shortId(found.sessionId)}.`;
    return [
      `${shortId(found.sessionId)} (${found.cwd}) — last ${events.length}:`,
      ...events.map((e) => `${new Date(e.ts).toISOString()} [${e.kind}] ${e.text.replace(/\s+/g, " ")}`),
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // MCP — the same actions, exposed to the Claude subprocess
  // -------------------------------------------------------------------------

  let mcp: McpHandle | undefined;
  let mcpStart: Promise<McpHandle | undefined> | undefined;

  async function ensureMcp(): Promise<McpHandle | undefined> {
    if (!mcpStart) {
      mcpStart = startMcpServer("pi-dispatch", [
        {
          name: "dispatch_list",
          description:
            "List every live pi agent session on this machine, with its id, working directory, model and whether it is idle or busy.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: () => actionList(),
        },
        {
          name: "dispatch_send",
          description:
            "Queue a prompt into another live pi session. It runs there — in that session's own directory and conversation — not here. Returns as soon as the prompt is queued; use dispatch_tail to see what happened.",
          inputSchema: {
            type: "object",
            properties: {
              session: {
                type: "string",
                description:
                  "Target session id from dispatch_list. A unique prefix, or a substring of the session's working directory, also resolves.",
              },
              prompt: { type: "string", description: "The prompt to run in that session." },
            },
            required: ["session", "prompt"],
            additionalProperties: false,
          },
          handler: (args) => actionSend(String(args.session ?? ""), String(args.prompt ?? "")),
        },
        {
          name: "dispatch_broadcast",
          description: "Queue the same prompt into every other live pi session.",
          inputSchema: {
            type: "object",
            properties: { prompt: { type: "string", description: "The prompt to run in every other session." } },
            required: ["prompt"],
            additionalProperties: false,
          },
          handler: (args) => actionBroadcast(String(args.prompt ?? "")),
        },
        {
          name: "dispatch_tail",
          description: "Read another pi session's recent activity: its prompts, tool calls and replies.",
          inputSchema: {
            type: "object",
            properties: {
              session: {
                type: "string",
                description:
                  "Session id from dispatch_list. A unique prefix, or a substring of the session's working directory, also resolves.",
              },
              lines: { type: "number", description: "How many activity lines to return (default 20)." },
            },
            required: ["session"],
            additionalProperties: false,
          },
          handler: (args) =>
            actionTail(String(args.session ?? ""), typeof args.lines === "number" ? args.lines : undefined),
        },
      ])
        .then((handle) => {
          mcp = handle;
          return handle;
        })
        .catch(() => {
          // No control plane for Claude this session; its own tools still work.
          return undefined;
        });
    }
    return mcpStart;
  }

  // -------------------------------------------------------------------------
  // /dispatch
  // -------------------------------------------------------------------------

  pi.registerCommand("dispatch", {
    description:
      "Control pi sessions and Claude routing: list | send | broadcast | attach | detach | tail | stop | claude | on | off | status | default",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const [sub = "", rest = ""] = splitArgs(rawArgs, 2);
      const config = registry.readConfig();

      switch (sub.toLowerCase()) {
        case "":
        case "list": {
          const peers = livePeers();
          report(
            ctx,
            `${peers.length} live pi session${peers.length === 1 ? "" : "s"}`,
            peerLines(peers, peer?.sessionId),
          );
          return;
        }

        case "status": {
          report(ctx, "claude-dispatch", [
            `routing        ${peer?.routed ? "on" : "off"}${optedOut ? " (session opted out)" : ""}`,
            `global default ${config.enabled ? "on" : "off"} · ${config.provider}/${config.model}`,
            `fallback       ${config.fallbackProvider ?? "(unset)"}/${config.fallbackModel ?? ""}`,
            `tool access    ${config.toolAccess ?? "any"}`,
            `model          ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
            `session        ${peer ? shortId(peer.sessionId) : "unregistered"} (pid ${process.pid})`,
            `peers          ${otherPeers().length}`,
            `attached to    ${attached ? shortId(attached.sessionId) : "none"}`,
            `claude tools   ${mcp ? mcp.url : "not started"}`,
          ]);
          return;
        }

        case "on":
        case "off": {
          optedOut = sub.toLowerCase() === "off";
          routingSettled = false;
          if (optedOut) {
            await restoreFallback(ctx);
            routingSettled = true;
            touch(ctx);
            updateStatus(ctx);
            report(ctx, "Routing off for this session", [
              ctx.model ? `Now on ${ctx.model.provider}/${ctx.model.id}.` : "No model selected.",
              "claude-dispatch will not override your model in this session.",
            ]);
          } else {
            await ensureRouted(ctx);
            report(ctx, "Routing on for this session", []);
          }
          return;
        }

        case "default": {
          const [key = "", value = ""] = splitArgs(rest, 2);
          if (key === "on" || key === "off") {
            const next = registry.writeConfig({ enabled: key === "on" });
            if (!next.enabled) {
              optedOut = true;
              routingSettled = true;
              await restoreFallback(ctx);
              touch(ctx);
              updateStatus(ctx);
            }
            report(ctx, `Global default routing ${key}`, [
              next.enabled
                ? `New sessions will start on ${next.provider}/${next.model}.`
                : `New sessions will start on ${next.fallbackProvider ?? "their configured"}/${next.fallbackModel ?? "model"}.`,
            ]);
            return;
          }

          if (key === "fallback") {
            const spec = value.trim();
            const slash = spec.indexOf("/");
            if (slash <= 0) {
              report(ctx, "Usage: /dispatch default fallback <provider>/<model>", [
                `current: ${config.fallbackProvider ?? "(unset)"}/${config.fallbackModel ?? ""}`,
              ]);
              return;
            }
            const provider = spec.slice(0, slash);
            const id = spec.slice(slash + 1);
            if (!ctx.modelRegistry.find(provider, id)) {
              report(ctx, `Unknown model "${spec}"`, ["Run pi --list-models to see what is available."]);
              return;
            }
            registry.writeConfig({ fallbackProvider: provider, fallbackModel: id });
            report(ctx, `Fallback model → ${spec}`, ["Used whenever claude routing is turned off."]);
            return;
          }
          if (key === "tool") {
            const mode = value.trim().toLowerCase();
            if (mode !== "any" && mode !== "anthropic") {
              report(ctx, "Usage: /dispatch default tool any|anthropic", [
                `current: ${config.toolAccess ?? "any"}`,
                "any        every pi model can call the dispatch tool",
                "anthropic  only Anthropic models can",
              ]);
              return;
            }
            registry.writeConfig({ toolAccess: mode });
            report(ctx, `dispatch tool → ${mode === "any" ? "every model" : "Anthropic models only"}`, [
              mode === "any"
                ? "Sessions on codex, llama-swap or anything else can drive their peers."
                : "Other providers get an error pointing at /dispatch on.",
              "Claude reaches the same actions over MCP either way.",
            ]);
            return;
          }
          if (key === "model") {
            const id = value.trim();
            if (!CLAUDE_MODELS.some((m) => m.id === id)) {
              report(ctx, `Unknown model "${id}"`, CLAUDE_MODELS.map((m) => `  ${m.id}`));
              return;
            }
            registry.writeConfig({ model: id });
            report(ctx, `Global default model → ${id}`, ["Applies to sessions started from now on."]);
            return;
          }
          report(ctx, "Usage: /dispatch default on|off|model <id>|fallback <provider>/<model>|tool any|anthropic", [
            `current:  ${config.enabled ? "on" : "off"} · ${config.provider}/${config.model}`,
            `fallback: ${config.fallbackProvider ?? "(unset)"}/${config.fallbackModel ?? ""}`,
            `tool:     ${config.toolAccess ?? "any"}`,
          ]);
          return;
        }

        case "send": {
          const [target = "", prompt = ""] = splitArgs(rest, 2);
          if (!target || !prompt.trim()) {
            report(ctx, "Usage: /dispatch send <session> <prompt>", []);
            return;
          }
          const { peer: found, error } = registry.resolvePeer(target, otherPeers());
          if (!found) {
            report(ctx, error ?? "No such session", []);
            return;
          }
          sendTo(found, prompt);
          report(ctx, `Sent to ${shortId(found.sessionId)} · ${peerLabel(found)}`, [prompt.slice(0, 200)]);
          return;
        }

        case "broadcast": {
          if (!rest.trim()) {
            report(ctx, "Usage: /dispatch broadcast <prompt>", []);
            return;
          }
          const targets = otherPeers();
          for (const target of targets) sendTo(target, rest);
          report(
            ctx,
            `Broadcast to ${targets.length} session${targets.length === 1 ? "" : "s"}`,
            peerLines(targets),
          );
          return;
        }

        case "stop": {
          const { peer: found, error } = registry.resolvePeer(rest, otherPeers());
          if (!found) {
            report(ctx, error ?? "No such session", []);
            return;
          }
          registry.pushInbox(found.sessionId, { kind: "abort", from: peer?.sessionId ?? "cli" });
          report(ctx, `Abort sent to ${shortId(found.sessionId)}`, []);
          return;
        }

        case "attach": {
          const peers = otherPeers();
          let target = rest.trim() ? registry.resolvePeer(rest, peers).peer : undefined;
          if (!target && rest.trim()) {
            report(ctx, registry.resolvePeer(rest, peers).error ?? "No such session", []);
            return;
          }
          if (!target) {
            if (!ctx.hasUI || peers.length === 0) {
              report(ctx, peers.length === 0 ? "No other live sessions" : "Usage: /dispatch attach <session>", []);
              return;
            }
            const labels = peerLines(peers);
            const picked = await ctx.ui.select("Attach to session:", labels);
            if (!picked) return;
            target = peers[labels.indexOf(picked)];
          }
          if (!target) return;
          attach(ctx, target);
          report(ctx, `Attached to ${shortId(target.sessionId)} — /dispatch detach to stop`, []);
          return;
        }

        case "detach": {
          const was = attached?.sessionId;
          detach(ctx);
          report(ctx, was ? `Detached from ${shortId(was)}` : "Not attached", []);
          return;
        }

        case "tail": {
          const [target = "", countRaw = ""] = splitArgs(rest, 2);
          const { peer: found, error } = registry.resolvePeer(target, livePeers());
          if (!found) {
            report(ctx, error ?? "No such session", []);
            return;
          }
          const count = Number.parseInt(countRaw, 10) || 20;
          const events = registry.tailOutbox(found.sessionId, count);
          report(
            ctx,
            `${shortId(found.sessionId)} · ${peerLabel(found)} — last ${events.length}`,
            events.map((e) => `  ${relTime(e.ts).padStart(4)} ago  ${e.kind === "tool" ? "▶" : e.kind === "prompt" ? "»" : " "} ${e.text.replace(/\s+/g, " ").slice(0, 120)}`),
          );
          return;
        }

        case "claude": {
          if (!rest.trim()) {
            report(ctx, "Usage: /dispatch claude <prompt>", []);
            return;
          }
          if (ctx.hasUI) ctx.ui.setStatus("claude-dispatch-run", "⇢ claude running…");
          const lines: string[] = [];
          const result = await runClaude(rest, {
            cwd: ctx.cwd,
            model: config.model,
            onProgress: (progress) => {
              if (progress.kind !== "tool") return;
              lines.push(`  ${progress.text}`);
              if (ctx.hasUI) ctx.ui.setStatus("claude-dispatch-run", `⇢ ${progress.text.slice(0, 60)}`);
            },
          });
          if (ctx.hasUI) ctx.ui.setStatus("claude-dispatch-run", undefined);
          report(ctx, result.error ? `Claude dispatch failed: ${result.error}` : "Claude dispatch complete", [
            ...lines.slice(-12),
            ...(result.text ? ["", ...result.text.trim().split("\n").slice(-40)] : []),
          ]);
          return;
        }

        default:
          report(ctx, `Unknown subcommand "${sub}"`, [
            "list                       live pi sessions",
            "send <session> <prompt>    queue a prompt into another session",
            "broadcast <prompt>         queue a prompt into every other session",
            "attach [session]           follow a session's activity live",
            "detach                     stop following",
            "tail <session> [n]         recent activity of a session",
            "stop <session>             abort a session's current run",
            "claude <prompt>            one-shot headless Claude run here",
            "on | off | status          routing for this session",
            "default on|off             routing for all new sessions",
            "default model <id>         which Claude model to route to",
            "default fallback <p>/<m>   model to restore when routing is off",
            "default tool any|anthropic which models may call the dispatch tool",
          ]);
      }
    },
  });

  // -------------------------------------------------------------------------
  // dispatch tool — lets the model orchestrate sessions itself
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "dispatch",
    label: "Dispatch",
    description:
      "Inspect and drive other live pi agent sessions, or hand a self-contained task to a headless Claude Code run. " +
      "Actions: 'list' returns every live pi session with its id, directory and state; " +
      "'send' queues a prompt into another session (it runs there, not here); " +
      "'broadcast' queues a prompt into every other session; " +
      "'tail' returns another session's recent activity; " +
      "'claude' runs a one-shot Claude Code agent in this working directory and returns its answer.",
    promptSnippet: "List and drive other pi sessions, or delegate a task to a headless Claude Code run",
    promptGuidelines: [
      "Use dispatch when the user asks what other pi sessions are running, or wants work sent to one of them.",
      "Use dispatch with action 'claude' to delegate a self-contained subtask that should run in its own agent.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "send", "broadcast", "tail", "claude"] as const),
      session: Type.Optional(
        Type.String({ description: "Target session id or unique prefix. Required for send and tail." }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "Prompt text. Required for send, broadcast and claude." }),
      ),
      lines: Type.Optional(
        Type.Number({ description: "How many activity lines to return for tail (default 20)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
      const config = registry.readConfig();

      // Any model may drive the control plane unless the registry says
      // otherwise. Locking it to Claude is a deliberate choice, not the default:
      // dispatching is a local, same-user operation, and a session on codex or
      // a local llama has as much business orchestrating its peers as Claude.
      if (config.toolAccess === "anthropic" && !isAnthropic(ctx.model)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `dispatch is restricted to Anthropic models. This session is on ` +
                `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "an unknown model"}. ` +
                `Either route it to Claude with /dispatch on, or lift the restriction with ` +
                `/dispatch default tool any.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      if (params.action === "list") return text(actionList());

      if (params.action === "tail") return text(actionTail(params.session ?? "", params.lines));

      if (!params.prompt?.trim()) return text("A prompt is required for this action.");

      if (params.action === "send") return text(actionSend(params.session ?? "", params.prompt));

      if (params.action === "broadcast") return text(actionBroadcast(params.prompt));

      // action === "claude"
      const toolLines: string[] = [];
      const result = await runClaude(params.prompt, {
        cwd: ctx.cwd,
        model: config.model,
        signal,
        onProgress: (progress) => {
          if (progress.kind !== "tool") return;
          toolLines.push(progress.text);
          onUpdate?.({ content: [{ type: "text", text: toolLines.slice(-10).join("\n") }] });
        },
      });
      if (result.error && !result.text.trim()) {
        return { content: [{ type: "text", text: `Claude dispatch failed: ${result.error}` }], details: {}, isError: true };
      }
      return text(
        [
          `Claude dispatch finished (${result.toolCount} tool call(s), $${result.cost.toFixed(4)}).`,
          "",
          result.text.trim() || "(no output)",
        ].join("\n"),
      );
    },
  });
}
