import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CURSOR_MARKER,
  Input,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CLOUDFLARE_BASE = "https://api.cloudflare.com/client/v4";
const TAILSCALE_BASE = "https://api.tailscale.com/api/v2";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(^|_)(authorization|cookie|password|secret|token|api[_-]?key|key)($|_)/i;

type Provider = "cloudflare" | "tailscale";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Credential {
  authorization: string;
  source: "interactive" | "environment";
  expiresAt?: number;
}

interface ApiDetails {
  provider: Provider;
  method: Method;
  path: string;
  status: number;
  statusText: string;
  truncated: boolean;
}

class MaskedInput implements Component, Focusable {
  private readonly input = new Input();

  constructor(
    private readonly title: string,
    private readonly requestRender: () => void,
    done: (value: string | undefined) => void,
  ) {
    this.input.onSubmit = (value) => done(value.trim() || undefined);
    this.input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    const count = Array.from(this.input.getValue()).length;
    const available = Math.max(1, width - 4);
    const hidden = count > available ? `…${"•".repeat(Math.max(0, available - 1))}` : "•".repeat(count);
    const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : " ";
    return [
      truncateToWidth(this.title, width, "…"),
      truncateToWidth(`> ${hidden}${cursor}`, width, ""),
      truncateToWidth("Enter to submit · Escape to cancel · value is not persisted", width, "…"),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

function validatePath(path: string): string {
  const value = path.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("://") || value.includes("#")) {
    throw new Error("path must be a relative API path beginning with one '/', without a URL or fragment");
  }
  return value;
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen),
    ]),
  );
}

function displayResponse(text: string): string {
  if (!text) return "(empty response body)";
  try {
    return JSON.stringify(redact(JSON.parse(text)), null, 2);
  } catch {
    return text;
  }
}

function parseBody(body: string | undefined): string | undefined {
  if (body === undefined || body.trim() === "") return undefined;
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error(`request body exceeds ${formatSize(MAX_BODY_BYTES)}`);
  }
  try {
    return JSON.stringify(JSON.parse(body));
  } catch (error) {
    throw new Error(`body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isMutation(method: Method): boolean {
  return method !== "GET";
}

export default function cloudAdminExtension(pi: ExtensionAPI) {
  let cloudflare: Credential | undefined;
  let tailscale: Credential | undefined;

  const credentialFor = (provider: Provider): Credential | undefined => {
    const credential = provider === "cloudflare" ? cloudflare : tailscale;
    if (credential?.expiresAt && credential.expiresAt <= Date.now()) {
      if (provider === "cloudflare") cloudflare = undefined;
      else tailscale = undefined;
      return undefined;
    }
    return credential;
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    const active = (["cloudflare", "tailscale"] as const).filter((provider) => credentialFor(provider));
    ctx.ui.setStatus(
      "cloud-admin",
      active.length ? ctx.ui.theme.fg("warning", `admin: ${active.join("+")}`) : undefined,
    );
  };

  const secretPrompt = async (ctx: ExtensionContext, title: string): Promise<string | undefined> => {
    if (ctx.mode !== "tui") return undefined;
    return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) =>
      new MaskedInput(title, () => tui.requestRender(), done),
    );
  };

  const exchangeTailscaleOAuth = async (
    clientId: string,
    clientSecret: string,
    signal?: AbortSignal,
  ): Promise<Credential> => {
    const response = await fetch(`${TAILSCALE_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Tailscale OAuth login failed (${response.status}): ${displayResponse(text)}`);
    const result = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!result.access_token) throw new Error("Tailscale OAuth response did not include access_token");
    return {
      authorization: `Bearer ${result.access_token}`,
      source: "interactive",
      expiresAt: result.expires_in ? Date.now() + result.expires_in * 1000 : undefined,
    };
  };

  const apiRequest = async (
    provider: Provider,
    method: Method,
    path: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; details: ApiDetails }> => {
    const credential = credentialFor(provider);
    if (!credential) throw new Error(`${provider} is not logged in; run /cloud-admin-login ${provider}`);
    const safePath = validatePath(path);
    const payload = parseBody(body);
    const base = provider === "cloudflare" ? CLOUDFLARE_BASE : TAILSCALE_BASE;
    const response = await fetch(`${base}${safePath}`, {
      method,
      headers: {
        Authorization: credential.authorization,
        Accept: "application/json",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    const raw = await response.text();
    const printable = displayResponse(raw);
    const truncation = truncateHead(printable, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    const suffix = truncation.truncated
      ? `\n\n[Response truncated to ${truncation.outputLines} lines / ${formatSize(truncation.outputBytes)}; full response was not written to disk because it may contain sensitive data.]`
      : "";
    const result = `${truncation.content}${suffix}`;
    if (!response.ok) throw new Error(`${provider} API ${response.status} ${response.statusText}:\n${result}`);
    return {
      text: result,
      details: {
        provider,
        method,
        path: safePath,
        status: response.status,
        statusText: response.statusText,
        truncated: truncation.truncated,
      },
    };
  };

  const loginCloudflare = async (ctx: ExtensionContext): Promise<void> => {
    const token = await secretPrompt(ctx, "Cloudflare API token");
    if (!token) return;
    cloudflare = { authorization: `Bearer ${token}`, source: "interactive" };
    try {
      await apiRequest("cloudflare", "GET", "/user/tokens/verify", undefined, new AbortController().signal);
      updateStatus(ctx);
      ctx.ui.notify("Cloudflare session login verified", "info");
    } catch (error) {
      cloudflare = undefined;
      updateStatus(ctx);
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const loginTailscale = async (ctx: ExtensionContext): Promise<void> => {
    const mode = await ctx.ui.select("Tailscale session login", ["API access token", "OAuth client"]);
    if (mode === "API access token") {
      const token = await secretPrompt(ctx, "Tailscale API access token");
      if (!token) return;
      tailscale = {
        authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}`,
        source: "interactive",
      };
    } else if (mode === "OAuth client") {
      const clientId = await secretPrompt(ctx, "Tailscale OAuth client ID");
      if (!clientId) return;
      const clientSecret = await secretPrompt(ctx, "Tailscale OAuth client secret");
      if (!clientSecret) return;
      try {
        tailscale = await exchangeTailscaleOAuth(clientId, clientSecret);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
    } else {
      return;
    }
    updateStatus(ctx);
    ctx.ui.notify("Tailscale credentials loaded for this session", "info");
  };

  pi.registerCommand("cloud-admin-login", {
    description: "Load Cloudflare or Tailscale admin credentials into memory for this Pi session",
    getArgumentCompletions: (prefix) =>
      (["cloudflare", "tailscale"] as const)
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Interactive login requires TUI mode; use documented environment variables instead", "error");
        return;
      }
      const requested = args.trim().toLowerCase();
      const provider = requested || (await ctx.ui.select("Admin session login", ["cloudflare", "tailscale"]));
      if (provider === "cloudflare") await loginCloudflare(ctx);
      else if (provider === "tailscale") await loginTailscale(ctx);
      else if (requested) ctx.ui.notify("Usage: /cloud-admin-login [cloudflare|tailscale]", "error");
    },
  });

  pi.registerCommand("cloud-admin-logout", {
    description: "Erase session-scoped Cloudflare and Tailscale credentials",
    handler: async (args, ctx) => {
      const provider = args.trim().toLowerCase();
      if (!provider || provider === "all") {
        cloudflare = undefined;
        tailscale = undefined;
      } else if (provider === "cloudflare") cloudflare = undefined;
      else if (provider === "tailscale") tailscale = undefined;
      else {
        ctx.ui.notify("Usage: /cloud-admin-logout [cloudflare|tailscale|all]", "error");
        return;
      }
      updateStatus(ctx);
      ctx.ui.notify("Admin credentials erased from memory", "info");
    },
  });

  pi.registerCommand("cloud-admin-status", {
    description: "Show session login status without revealing credentials",
    handler: async (_args, ctx) => {
      const describe = (provider: Provider) => {
        const credential = credentialFor(provider);
        if (!credential) return `${provider}: logged out`;
        const expiry = credential.expiresAt ? `, expires ${new Date(credential.expiresAt).toISOString()}` : "";
        return `${provider}: logged in (${credential.source}${expiry})`;
      };
      ctx.ui.notify(`${describe("cloudflare")}\n${describe("tailscale")}`, "info");
      updateStatus(ctx);
    },
  });

  const ApiParameters = Type.Object({
    method: StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE"] as const, {
      description: "HTTP method",
    }),
    path: Type.String({
      description: "Provider API path beginning with '/', including an optional query string; absolute URLs are rejected",
    }),
    body: Type.Optional(Type.String({ description: "JSON request body encoded as a string" })),
    dry_run: Type.Optional(Type.Boolean({ description: "For mutations, show the request without sending it" })),
  });

  const registerApiTool = (provider: Provider) => {
    pi.registerTool({
      name: `${provider}_admin_api`,
      label: `${provider[0]!.toUpperCase()}${provider.slice(1)} Admin API`,
      description: `Call the ${provider} admin REST API using credentials loaded for this Pi session. Supports GET/POST/PUT/PATCH/DELETE. Mutations require explicit user confirmation. Output is redacted and truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
      promptSnippet: `Make authenticated ${provider} administrative API requests`,
      promptGuidelines: [
        `Use ${provider}_admin_api only when the user explicitly asks to inspect or manage ${provider}.`,
        `Prefer dry_run=true before consequential ${provider} mutations and explain the impact before executing them.`,
      ],
      parameters: ApiParameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const method = params.method as Method;
        const path = validatePath(params.path);
        const body = parseBody(params.body);
        if (params.dry_run) {
          return {
            content: [{ type: "text", text: `Dry run only; no request sent.\n${method} ${path}\n${body ?? "(no body)"}` }],
            details: { provider, method, path, dryRun: true },
          };
        }
        if (isMutation(method)) {
          if (!ctx.hasUI) throw new Error("Mutating admin requests are blocked without interactive confirmation");
          const approved = await ctx.ui.confirm(
            `${provider} admin mutation`,
            `${method} ${path}\n\nThis uses admin credentials and may change or delete production resources. Continue?`,
          );
          if (!approved) throw new Error("Admin mutation cancelled by user");
        }
        const result = await apiRequest(provider, method, path, body, signal);
        return { content: [{ type: "text", text: result.text }], details: result.details };
      },
    });
  };

  registerApiTool("cloudflare");
  registerApiTool("tailscale");

  pi.on("session_start", async (_event, ctx) => {
    const cfToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
    const tsToken = process.env.TAILSCALE_API_KEY || process.env.TS_API_KEY;
    if (cfToken) cloudflare = { authorization: `Bearer ${cfToken}`, source: "environment" };
    if (tsToken) {
      tailscale = {
        authorization: `Basic ${Buffer.from(`${tsToken}:`).toString("base64")}`,
        source: "environment",
      };
    } else if (process.env.TAILSCALE_OAUTH_CLIENT_ID && process.env.TAILSCALE_OAUTH_CLIENT_SECRET) {
      try {
        tailscale = {
          ...(await exchangeTailscaleOAuth(
            process.env.TAILSCALE_OAUTH_CLIENT_ID,
            process.env.TAILSCALE_OAUTH_CLIENT_SECRET,
          )),
          source: "environment",
        };
      } catch (error) {
        ctx.ui.notify(`Tailscale OAuth environment login failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    cloudflare = undefined;
    tailscale = undefined;
  });
}
