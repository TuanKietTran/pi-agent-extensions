import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { PI_EVENT } from "./pi-events.ts";

// --- Bridge constants: local literals live together here. ---
const DEFAULT_HOST = "127.0.0.1";
const ENV_HOST = "PI_BRIDGE_HOST";
const ENV_PORT = "PI_BRIDGE_PORT";
const ENV_API_KEY = "PI_BRIDGE_API_KEY";
const ENV_MAX_BODY = "PI_BRIDGE_MAX_BODY_BYTES";
const ENV_TIMEOUT = "PI_BRIDGE_REQUEST_TIMEOUT_MS";
const ENV_HOST_FALLBACK = "HOST";
const ENV_PORT_FALLBACK = "PORT";
const NOTE_INFO = "info";
const SERVICE = "pi-odysseus-bridge";
const DEFAULT_MODEL = "pi-agent";
const MIME_JSON = "application/json; charset=utf-8";
const MIME_SSE = "text/event-stream; charset=utf-8";
const ENCODING = "utf8";
const DONE_MARKER = "data: [DONE]\n\n";
const ROLE_ASSISTANT = "assistant";
const ROLE_USER = "user";
const ROLE_SYSTEM = "system";
const ROLE_DEVELOPER = "developer";
const PART_TEXT = "text";
const PART_IMAGE = "image";
const ERROR_SERVER = "server_error";
const ERROR_INVALID_REQUEST = "invalid_request_error";
const ERROR_MODEL_NOT_FOUND = "model_not_found";
const ERROR_PI = "pi_error";
const ERROR_BAD_KEY = "invalid_api_key";
const ERROR_NOT_FOUND = "not_found";
const ERROR_UNAVAILABLE = "service_unavailable";
const ERROR_BUSY = "pi_busy";
const ERROR_AUTH = "authentication_error";
const METHOD_OPTIONS = "OPTIONS";
const METHOD_GET = "GET";
const METHOD_POST = "POST";
const ROOT_PATH = "/";
const HOST_FALLBACK = "localhost";
const HEALTH_PATHS = [ROOT_PATH, "/health", "/healthz", "/v1/health"];
const MODEL_PATHS = ["/models", "/v1/models"];
const CHAT_PATHS = ["/chat/completions", "/v1/chat/completions"];
const MODEL_PATH = /^\/v1\/models\/(.+)$/;
const TRIM_SLASH = /\/+$/;
const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;
const MESSAGE_NO_KEY = "Invalid or missing bearer token";
const MESSAGE_EMPTY_MESSAGES = "messages must be a non-empty array";
const MESSAGE_SESSION_NOT_READY = "Pi session is not ready";
const MESSAGE_PI_BUSY = "Pi is busy with another prompt";
const MESSAGE_NO_PROMPT = "No user text or image was found in messages";
const MESSAGE_TIMEOUT = "Pi bridge request timed out";
const MESSAGE_DISCONNECTED = "Client disconnected";
const MESSAGE_SHUTDOWN = "Pi session shut down";
const MESSAGE_LARGE_BODY = "Request body too large";
const MESSAGE_EMPTY_BODY = "Request body is empty";
const HTTP_BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
const HEADER_CONTENT_TYPE = "Content-Type";
const HEADER_CONTENT_LENGTH = "Content-Length";
const HEADER_CACHE_CONTROL = "Cache-Control";
const HEADER_CONNECTION = "Connection";
const HEADER_ACCEL = "X-Accel-Buffering";
const HEADER_CORS_ORIGIN = "Access-Control-Allow-Origin";
const HEADER_CORS_HEADERS = "Access-Control-Allow-Headers";
const HEADER_CORS_METHODS = "Access-Control-Allow-Methods";
const HEADER_AUTHORIZATION = "Authorization";
const HEADER_API_KEY = "x-api-key";
const SSE_CACHE = "no-cache, no-transform";
const KEEP_ALIVE = "keep-alive";
const NO = "no";
const CORS_HEADERS = "Authorization, Content-Type, X-API-Key";
const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_MAX_AGE = "600";
const OBJECT_MODEL = "model";
const OBJECT_LIST = "list";
const OBJECT_COMPLETION = "chat.completion";
const OBJECT_CHUNK = "chat.completion.chunk";
const OWNER_PI = "pi";
const STOP = "stop";
const PART_IMAGE_URL = "image_url";
const PART_INPUT_TEXT = "input_text";
const MODEL_ALIAS_SOURCE = "openai-codex";
const MODEL_ALIAS_TARGET = "chatgpt";
const MODEL_CODEX = /codex/gi;
const MODEL_CDX = "cdx";
const PROVIDER_ALIASES: Record<string, string> = { [MODEL_ALIAS_SOURCE]: MODEL_ALIAS_TARGET };
const BODY_TOO_LARGE = "too large";
const ADDRESS_IN_USE = "EADDRINUSE";
const BIND_ALL_IPV4 = "0.0.0.0";
const BIND_ALL_IPV6 = "::";
const LOOPBACK_IPV6 = "::1";
const BRIDGE_INSTRUCTIONS = "OpenAI client instructions for this request:";
const EVENT_CLIENT_ERROR = "clientError";
const EVENT_ABORTED = "aborted";
const EVENT_ERROR = "error";
const STOP_ERROR = "error";
const STOP_ABORTED = "aborted";
const DELTA_TEXT = "text_delta";
const HEALTH_OK = "ok";
const NEWLINE = "\n";
const PARAGRAPH_BREAK = "\n\n";
const CORS_ANY_ORIGIN = "*";
const bridgeUrl = () => `http://${HOST}:${PORT}/v1`;
const bridgeStarted = () => `Pi OpenAI bridge: ${bridgeUrl()}`;
const bridgeAlreadyRunning = () => `Pi OpenAI bridge already running at ${bridgeUrl()}`;
const modelMissing = (id: string) => `Model not found: ${id}`;
const routeMissing = (method: string, pathname: string) => `Route not found: ${method} ${pathname}`;

const HOST = process.env[ENV_HOST] ?? process.env[ENV_HOST_FALLBACK] ?? DEFAULT_HOST;
const PORT = parsePort(process.env[ENV_PORT] ?? process.env[ENV_PORT_FALLBACK], 8787);
const API_KEY = process.env[ENV_API_KEY];
const MAX_BODY_BYTES = parsePositiveInt(process.env[ENV_MAX_BODY], 10 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = parsePositiveInt(process.env[ENV_TIMEOUT], 30 * 60 * 1000);

type OpenAIMessage = {
  role?: string;
  content?: string | Array<Record<string, unknown>> | null;
  name?: string;
};

type ChatRequest = {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  user?: string;
};

type BridgeModel = NonNullable<ExtensionContext["model"]>;

type ActiveRequest = {
  id: string;
  model: string;
  stream: boolean;
  response: ServerResponse;
  text: string;
  done: boolean;
  timer: NodeJS.Timeout;
  error?: Error;
  streamUsage: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

export default function piOdysseusBridge(pi: ExtensionAPI) {
  let server: Server | undefined;
  let context: ExtensionContext | undefined;
  let active: ActiveRequest | undefined;
  let requestQueue: Promise<void> = Promise.resolve();

  pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => {
    context = ctx;
    if (server) return;

    const candidate = createServer((req, res) => {
      void route(req, res).catch((error: unknown) => {
        if (!res.headersSent) sendError(res, 500, errorMessage(error), ERROR_SERVER);
        else if (!res.writableEnded) res.end();
      });
    });

    candidate.on(EVENT_CLIENT_ERROR, (_error, socket) => {
      socket.end(HTTP_BAD_REQUEST);
    });

    try {
      await listen(candidate);
      server = candidate;
      ctx.ui.notify(bridgeStarted(), NOTE_INFO);
    } catch (error) {
      candidate.close();
      if (!isAddressInUse(error)) throw error;
      if (await existingBridgeIsHealthy()) {
        // Another Pi process owns the one bridge daemon. Loading this extension
        // is still successful; do not tear down that process's server on exit.
        ctx.ui.notify(bridgeAlreadyRunning(), NOTE_INFO);
      } else {
        // An unrelated process owns the port. Keep Pi startup healthy and make
        // the conflict actionable instead of throwing from SESSION_START.
        ctx.ui.notify(`Pi OpenAI bridge could not bind ${bridgeUrl()} (address already in use); choose ${ENV_PORT} or ${ENV_HOST}.`, "error");
      }
    }
  });

  pi.on(PI_EVENT.MODEL_SELECT, (_event, ctx) => {
    context = ctx;
  });

  pi.on(PI_EVENT.BEFORE_AGENT_START, (event) => {
    if (!active) return;
    const system = currentSystemInstructions;
    currentSystemInstructions = "";
    if (!system) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${BRIDGE_INSTRUCTIONS}\n${system}` };
  });

  pi.on(PI_EVENT.MESSAGE_UPDATE, (event) => {
    if (!active || event.assistantMessageEvent.type !== DELTA_TEXT) return;
    const delta = event.assistantMessageEvent.delta;
    active.text += delta;
    if (active.stream && !active.response.writableEnded) {
      writeSse(active.response, chatChunk(active, { content: delta }, null));
    }
  });

  pi.on(PI_EVENT.MESSAGE_END, (event) => {
    if (!active || event.message.role !== ROLE_ASSISTANT) return;
    if (event.message.stopReason === STOP_ERROR || event.message.stopReason === STOP_ABORTED) {
      active.error = new Error(event.message.errorMessage ?? `Pi request ${event.message.stopReason}`);
    }
  });

  pi.on(PI_EVENT.AGENT_SETTLED, () => {
    if (!active) return;
    if (active.error) failActive(active.error);
    else finishActive();
  });

  pi.on(PI_EVENT.SESSION_SHUTDOWN, async () => {
    context = undefined;
    if (active) failActive(new Error(MESSAGE_SHUTDOWN));
    const closing = server;
    server = undefined;
    if (closing) {
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
  });

  let currentSystemInstructions = "";

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === METHOD_OPTIONS) {
      res.writeHead(204).end();
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, MESSAGE_NO_KEY, ERROR_BAD_KEY);
      return;
    }

    const pathname = new URL(req.url ?? ROOT_PATH, `http://${req.headers.host ?? HOST_FALLBACK}`).pathname.replace(TRIM_SLASH, "") || ROOT_PATH;

    if (req.method === METHOD_GET && HEALTH_PATHS.includes(pathname)) {
      sendJson(res, 200, {
        status: HEALTH_OK,
        service: SERVICE,
        busy: Boolean(active) || Boolean(context && !context.isIdle()),
        model: activeModelId(),
      });
      return;
    }

    if (req.method === METHOD_GET && MODEL_PATHS.includes(pathname)) {
      sendJson(res, 200, modelList());
      return;
    }

    const modelMatch = pathname.match(MODEL_PATH);
    if (req.method === METHOD_GET && modelMatch) {
      const id = decodeURIComponent(modelMatch[1]);
      const model = findModel(id);
      if (!model) sendError(res, 404, modelMissing(id), ERROR_MODEL_NOT_FOUND);
      else sendJson(res, 200, modelObject(model));
      return;
    }

    if (req.method === METHOD_POST && CHAT_PATHS.includes(pathname)) {
      let body: ChatRequest;
      try {
        body = (await readJson(req)) as ChatRequest;
      } catch (error) {
        sendError(res, errorMessage(error).includes(BODY_TOO_LARGE) ? 413 : 400, errorMessage(error), ERROR_INVALID_REQUEST);
        return;
      }
      if (!isChatRequest(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
        sendError(res, 400, MESSAGE_EMPTY_MESSAGES, ERROR_INVALID_REQUEST);
        return;
      }

      requestQueue = requestQueue.then(
        () => runChat(body, req, res),
        () => runChat(body, req, res),
      );
      await requestQueue;
      return;
    }

    sendError(res, 404, routeMissing(req.method ?? METHOD_GET, pathname), ERROR_NOT_FOUND);
  }

  async function runChat(body: ChatRequest, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!context) {
      sendError(res, 503, MESSAGE_SESSION_NOT_READY, ERROR_UNAVAILABLE);
      return;
    }
    if (!context.isIdle()) {
      sendError(res, 409, MESSAGE_PI_BUSY, ERROR_BUSY);
      return;
    }

    const selected = resolveModel(body.model);
    if (body.model && body.model !== DEFAULT_MODEL && !selected) {
      sendError(res, 404, modelMissing(body.model), ERROR_MODEL_NOT_FOUND);
      return;
    }
    if (selected && publicModelId(selected) !== activeModelId()) {
      const switched = await pi.setModel(selected);
      if (!switched) {
        sendError(res, 401, `No authentication is available for ${body.model}`, ERROR_AUTH);
        return;
      }
    }

    const prompt = extractLatestPrompt(body.messages!);
    if (!prompt.text && prompt.images.length === 0) {
      sendError(res, 400, MESSAGE_NO_PROMPT, ERROR_INVALID_REQUEST);
      return;
    }

    currentSystemInstructions = extractSystemInstructions(body.messages!);
    const id = `chatcmpl-pi-${randomUUID()}`;
    const stream = body.stream === true;

    if (stream) {
      res.writeHead(200, {
        [HEADER_CONTENT_TYPE]: MIME_SSE,
        [HEADER_CACHE_CONTROL]: SSE_CACHE,
        [HEADER_CONNECTION]: KEEP_ALIVE,
        [HEADER_ACCEL]: NO,
      });
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        context?.abort();
        failActive(new Error(MESSAGE_TIMEOUT));
      }, REQUEST_TIMEOUT_MS);
      active = { id, model: activeModelId(), stream, streamUsage: body.stream_options?.include_usage === true, response: res, text: "", done: false, timer, resolve, reject };
      if (stream) writeSse(res, chatChunk(active, { role: ROLE_ASSISTANT }, null));

      req.once(EVENT_ABORTED, () => {
        if (active?.id === id) {
          context?.abort();
          failActive(new Error(MESSAGE_DISCONNECTED));
        }
      });

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      if (prompt.text) content.push({ type: PART_TEXT, text: prompt.text });
      content.push(...prompt.images);
      try {
        pi.sendUserMessage(content, { expandPromptTemplates: false });
      } catch (error) {
        failActive(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch((error: unknown) => {
      const message = errorMessage(error);
      const status = message === MESSAGE_TIMEOUT ? 504 : 500;
      if (!res.headersSent) sendError(res, status, message, message === MESSAGE_TIMEOUT ? ERROR_UNAVAILABLE : ERROR_PI);
      else if (!res.writableEnded) {
        writeSse(res, { error: { message: errorMessage(error), type: ERROR_PI } });
        res.write(DONE_MARKER);
        res.end();
      }
    });
  }

  function finishActive(): void {
    const request = active;
    if (!request || request.done) return;
    request.done = true;
    clearTimeout(request.timer);

    if (request.stream) {
      if (!request.response.writableEnded) {
        writeSse(request.response, chatChunk(request, {}, STOP, request.streamUsage));
        request.response.write(DONE_MARKER);
        request.response.end();
      }
    } else if (!request.response.writableEnded) {
      sendJson(request.response, 200, {
        id: request.id,
        object: OBJECT_COMPLETION,
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message: { role: ROLE_ASSISTANT, content: request.text }, finish_reason: STOP }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    active = undefined;
    request.resolve();
  }

  function failActive(error: Error): void {
    const request = active;
    if (!request || request.done) return;
    request.done = true;
    clearTimeout(request.timer);
    active = undefined;
    request.reject(error);
  }

  function availableModels(): BridgeModel[] {
    return context?.modelRegistry.getAvailable() ?? [];
  }

  function activeModelId(): string {
    return context?.model ? publicModelId(context.model) : DEFAULT_MODEL;
  }

  function resolveModel(requested?: string) {
    if (!requested || requested === DEFAULT_MODEL) return context?.model;
    return findModel(requested);
  }

  // Accept the public ID, then legacy provider/id and bare model IDs.
  function findModel(requested: string) {
    const models = availableModels();
    return models.find((model) => publicModelId(model) === requested)
      ?? models.find((model) => modelId(model) === requested)
      ?? models.find((model) => model.id === requested);
  }

  function modelList() {
    const data = availableModels().map(modelObject);
    if (data.length === 0) data.push({ id: DEFAULT_MODEL, object: OBJECT_MODEL, created: 0, owned_by: OWNER_PI });
    return { object: OBJECT_LIST, data };
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once(EVENT_ERROR, onError);
    server.listen(PORT, HOST, () => {
      server.off(EVENT_ERROR, onError);
      resolve();
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === ADDRESS_IN_USE;
}

async function existingBridgeIsHealthy(): Promise<boolean> {
  const host = HOST === BIND_ALL_IPV4 ? DEFAULT_HOST : HOST === BIND_ALL_IPV6 ? LOOPBACK_IPV6 : HOST;
  const headers = API_KEY ? { [HEADER_AUTHORIZATION]: `Bearer ${API_KEY}` } : undefined;
  try {
    const response = await fetch(`http://${formatUrlHost(host)}:${PORT}/health`, {
      headers,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json() as { service?: unknown };
    return body.service === SERVICE;
  } catch {
    return false;
  }
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function modelId(model: { id: string; provider: string }): string {
  return `${model.provider}/${model.id}`;
}

// Odysseus drops any model whose ID contains "codex" as non-chat, so public
// IDs use provider aliases and never contain that substring.
function publicModelId(model: { id: string; provider: string }): string {
  const provider = PROVIDER_ALIASES[model.provider] ?? model.provider;
  return `pi/${provider}/${model.id}`.replace(MODEL_CODEX, MODEL_CDX);
}

function modelObject(model: { id: string; provider: string; created?: number }) {
  return { id: publicModelId(model), object: OBJECT_MODEL, created: model.created ?? 0, owned_by: model.provider };
}

function chatChunk(request: Pick<ActiveRequest, "id" | "model">, delta: Record<string, string>, finishReason: string | null, includeUsage = false) {
  return {
    id: request.id,
    object: OBJECT_CHUNK,
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(includeUsage && finishReason === STOP ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}),
  };
}

function writeSse(res: ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function extractSystemInstructions(messages: OpenAIMessage[]): string {
  return messages
    .filter((message) => message.role === ROLE_SYSTEM || message.role === ROLE_DEVELOPER)
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join(PARAGRAPH_BREAK);
}

function extractLatestPrompt(messages: OpenAIMessage[]) {
  const latestUser = [...messages].reverse().find((message) => message.role === ROLE_USER) ?? messages.at(-1)!;
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  if (Array.isArray(latestUser.content)) {
    for (const part of latestUser.content) {
      if (part.type !== PART_IMAGE_URL) continue;
      const raw = typeof part.image_url === "string"
        ? part.image_url
        : typeof part.image_url === "object" && part.image_url !== null
          ? String((part.image_url as Record<string, unknown>).url ?? "")
          : "";
      const match = raw.match(DATA_URL);
      if (match) images.push({ type: PART_IMAGE, mimeType: match[1], data: match[2] });
    }
  }

  return { text: contentToText(latestUser.content), images };
}

export function contentToText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === PART_TEXT || part.type === PART_INPUT_TEXT)
    .map((part) => String(part.text ?? ""))
    .join(NEWLINE);
}

function isChatRequest(value: unknown): value is ChatRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error(MESSAGE_LARGE_BODY);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString(ENCODING);
  if (!raw) throw new Error(MESSAGE_EMPTY_BODY);
  return JSON.parse(raw);
}

function authorized(req: IncomingMessage): boolean {
  if (!API_KEY) return true;
  return req.headers.authorization === `Bearer ${API_KEY}` || req.headers[HEADER_API_KEY] === API_KEY;
}

function setCors(res: ServerResponse): void {
  res.setHeader(HEADER_CORS_ORIGIN, CORS_ANY_ORIGIN);
  res.setHeader(HEADER_CORS_HEADERS, CORS_HEADERS);
  res.setHeader(HEADER_CORS_METHODS, CORS_METHODS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { [HEADER_CONTENT_TYPE]: MIME_JSON, [HEADER_CONTENT_LENGTH]: Buffer.byteLength(body) });
  res.end(body);
}

export function errorBody(message: string, type: string): { error: { message: string; type: string; code: string } } {
  return { error: { message, type, code: type } };
}

function sendError(res: ServerResponse, status: number, message: string, type: string): void {
  sendJson(res, status, errorBody(message, type));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
