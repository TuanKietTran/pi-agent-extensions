/**
 * Cross-process registry for pi sessions.
 *
 * Every live pi process drops a peer file in ~/.pi/agent/dispatch/peers/ and
 * keeps it warm with a heartbeat. Sessions talk to each other through
 * append-only JSONL inboxes (prompts and control messages) and outboxes (an
 * activity tail another session can watch).
 *
 * Files rather than sockets: pi sessions come and go constantly, often via
 * SIGKILL or a closed terminal, and a dead peer must not leave a listening
 * port or a half-open pipe behind. A stale file is self-evidently stale — it
 * names a pid that no longer exists.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DISPATCH_DIR =
  process.env.PI_DISPATCH_DIR ?? join(homedir(), ".pi", "agent", "dispatch");

const PEERS_DIR = join(DISPATCH_DIR, "peers");
const INBOX_DIR = join(DISPATCH_DIR, "inbox");
const OUTBOX_DIR = join(DISPATCH_DIR, "outbox");
const CONFIG_FILE = join(DISPATCH_DIR, "config.json");

/** A peer whose heartbeat is older than this is treated as dead. */
const STALE_MS = 90_000;
/** Outboxes are trimmed to their newest half once they exceed this. */
const OUTBOX_MAX_BYTES = 256 * 1024;

export type PeerState = "idle" | "busy";

export interface Peer {
  sessionId: string;
  pid: number;
  cwd: string;
  /** pi run mode: "tui" | "rpc" | "json" | "print". */
  mode: string;
  sessionFile?: string;
  name?: string;
  provider?: string;
  model?: string;
  state: PeerState;
  /** Whether this session is currently routed to claude dispatch. */
  routed: boolean;
  lastPrompt?: string;
  startedAt: number;
  updatedAt: number;
}

export interface InboxMessage {
  id: string;
  kind: "prompt" | "abort";
  text?: string;
  /** Session id of the sender, or "cli". */
  from: string;
  fromCwd?: string;
  deliverAs?: "steer" | "followUp";
  ts: number;
}

export interface OutboxEvent {
  ts: number;
  kind: "prompt" | "text" | "tool" | "state";
  text: string;
}

export interface DispatchConfig {
  /** Master switch for claude routing across all sessions. */
  enabled: boolean;
  provider: string;
  model: string;
  /**
   * The model to fall back to when routing is off.
   *
   * pi.setModel() persists its choice as the global default in settings.json,
   * so once a session has been routed, pi's own "default model" is claude and
   * the user's real preference is gone. We record it here the first time we
   * see it and restore from here whenever routing is turned off.
   */
  fallbackProvider?: string;
  fallbackModel?: string;
  /**
   * Which models may call pi's `dispatch` tool.
   *
   * "any" — whatever model the session is on can drive its peers.
   * "anthropic" — only Anthropic models can; everything else gets an error
   * pointing at /dispatch on.
   *
   * Claude reaches the same actions over MCP either way, since a routed
   * session cannot call pi tools at all.
   */
  toolAccess?: "any" | "anthropic";
}

export const DEFAULT_CONFIG: DispatchConfig = {
  enabled: true,
  provider: "claude-cli",
  model: "claude-opus-5",
  toolAccess: "any",
};

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/** Session ids are uuidv7, but never trust an id enough to build a path from it raw. */
function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function peerPath(sessionId: string): string {
  return join(PEERS_DIR, `${safeId(sessionId)}.json`);
}

function inboxPath(sessionId: string): string {
  return join(INBOX_DIR, `${safeId(sessionId)}.jsonl`);
}

function outboxPath(sessionId: string): string {
  return join(OUTBOX_DIR, `${safeId(sessionId)}.jsonl`);
}

export function ensureDirs(): void {
  for (const dir of [PEERS_DIR, INBOX_DIR, OUTBOX_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export function readConfig(): DispatchConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<DispatchConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(patch: Partial<DispatchConfig>): DispatchConfig {
  const next = { ...readConfig(), ...patch };
  ensureDirs();
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------
// peers
// ---------------------------------------------------------------------------

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** Write via a temp file + rename so a concurrent reader never sees a half-written peer. */
export function writePeer(peer: Peer): void {
  try {
    ensureDirs();
    const target = peerPath(peer.sessionId);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(peer)}\n`);
    renameSync(tmp, target);
  } catch {
    // A registry write must never take the session down with it.
  }
}

export function removePeer(sessionId: string): void {
  for (const path of [peerPath(sessionId), inboxPath(sessionId), outboxPath(sessionId)]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

function readPeer(file: string): Peer | undefined {
  try {
    const peer = JSON.parse(readFileSync(file, "utf8")) as Peer;
    return peer && typeof peer.sessionId === "string" ? peer : undefined;
  } catch {
    // Mid-rename or truncated read — the next poll will pick it up.
    return undefined;
  }
}

/**
 * All peers that are still alive, newest heartbeat first. Dead peers are
 * reaped as a side effect: whoever looks at the registry cleans it.
 */
export function listPeers(): Peer[] {
  ensureDirs();
  const now = Date.now();
  const alive: Peer[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(PEERS_DIR);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(PEERS_DIR, entry);
    const peer = readPeer(file);
    if (!peer) continue;
    // A live pid with a stale heartbeat is still dead to us: it means the
    // process is running but the dispatch extension is no longer driving it.
    if (isAlive(peer.pid) && now - peer.updatedAt < STALE_MS) {
      alive.push(peer);
    } else {
      removePeer(peer.sessionId);
    }
  }

  return alive.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * How many leading characters it takes to tell these ids apart.
 *
 * Session ids are uuidv7, so sessions started in the same second share a long
 * prefix — an 8-character id is not necessarily a usable handle. Anything that
 * shows a shortened id has to shorten it by this much, or it is showing
 * something the reader cannot select with.
 */
export function idWidth(ids: string[], minimum = 8): number {
  const longest = Math.max(minimum, ...ids.map((id) => id.length));
  let width = minimum;
  while (width < longest && new Set(ids.map((id) => id.slice(0, width))).size < new Set(ids).size) {
    width++;
  }
  return width;
}

/** Resolve a user-typed id prefix (or session name) to exactly one peer. */
export function resolvePeer(
  query: string,
  peers: Peer[],
): { peer?: Peer; error?: string } {
  const q = query.trim().toLowerCase();
  if (!q) return { error: "No session id given" };

  const byPrefix = peers.filter((p) => p.sessionId.toLowerCase().startsWith(q));
  const matches =
    byPrefix.length > 0
      ? byPrefix
      : peers.filter(
          (p) =>
            p.name?.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q),
        );

  if (matches.length === 0) return { error: `No live session matches "${query}"` };
  if (matches.length > 1) {
    // Show prefixes long enough to actually pick one of them with.
    const width = idWidth(matches.map((p) => p.sessionId));
    const ids = matches.map((p) => p.sessionId.slice(0, width)).join(", ");
    return { error: `"${query}" matches ${matches.length} sessions: ${ids}` };
  }
  return { peer: matches[0] };
}

// ---------------------------------------------------------------------------
// inbox — messages dispatched *to* a session
// ---------------------------------------------------------------------------

/**
 * Byte offset already consumed per file. Readers only ever move forward, so
 * a writer appending concurrently can never lose a message to a truncation
 * race — nothing truncates an inbox except its owner, at session start.
 */
const offsets = new Map<string, number>();

export function pushInbox(
  targetSessionId: string,
  message: Omit<InboxMessage, "id" | "ts">,
): void {
  ensureDirs();
  const full: InboxMessage = {
    ...message,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
  };
  appendFileSync(inboxPath(targetSessionId), `${JSON.stringify(full)}\n`);
}

/** Read every complete line appended since the last drain. */
export function drainInbox(sessionId: string): InboxMessage[] {
  const path = inboxPath(sessionId);
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return [];
  }

  // The file shrank (deleted and recreated) — restart from the top.
  let start = offsets.get(path) ?? 0;
  if (buffer.length < start) start = 0;
  if (buffer.length === start) return [];

  const chunk = buffer.subarray(start).toString("utf8");
  const lastBreak = chunk.lastIndexOf("\n");
  if (lastBreak === -1) {
    offsets.set(path, start);
    return []; // no complete line yet
  }

  const complete = chunk.slice(0, lastBreak);
  offsets.set(path, start + Buffer.byteLength(complete, "utf8") + 1);

  const messages: InboxMessage[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as InboxMessage);
    } catch {
      // skip malformed line
    }
  }
  return messages;
}

/** Drop anything queued for a previous run of this session id. */
export function resetInbox(sessionId: string): void {
  ensureDirs();
  const path = inboxPath(sessionId);
  try {
    writeFileSync(path, "");
  } catch {
    // ignore
  }
  offsets.set(path, 0);
}

/**
 * Poll the inbox for new messages.
 *
 * watchFile polls rather than relying on inotify/ReadDirectoryChangesW, which
 * is the point: it behaves identically on Windows and it survives the file
 * being replaced underneath us.
 */
export function watchInbox(
  sessionId: string,
  onMessages: (messages: InboxMessage[]) => void,
  intervalMs = 400,
): () => void {
  ensureDirs();
  const path = inboxPath(sessionId);
  if (!existsSync(path)) writeFileSync(path, "");

  const listener = () => {
    const messages = drainInbox(sessionId);
    if (messages.length > 0) onMessages(messages);
  };
  watchFile(path, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(path, listener);
}

// ---------------------------------------------------------------------------
// outbox — activity tail another session can follow
// ---------------------------------------------------------------------------

export function appendOutbox(sessionId: string, event: OutboxEvent): void {
  try {
    ensureDirs();
    const path = outboxPath(sessionId);
    if (sizeOf(path) > OUTBOX_MAX_BYTES) trimOutbox(path);
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  } catch {
    // Losing an activity line is never worth an exception in a hot path.
  }
}

function trimOutbox(path: string): void {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
  } catch {
    // ignore
  }
}

export function tailOutbox(sessionId: string, count: number): OutboxEvent[] {
  try {
    const lines = readFileSync(outboxPath(sessionId), "utf8").split("\n").filter(Boolean);
    const events: OutboxEvent[] = [];
    for (const line of lines.slice(-count)) {
      try {
        events.push(JSON.parse(line) as OutboxEvent);
      } catch {
        // skip
      }
    }
    return events;
  } catch {
    return [];
  }
}

/** Byte size of an outbox, so a follower can tell when there is something new. */
export function outboxSize(sessionId: string): number {
  return sizeOf(outboxPath(sessionId));
}
