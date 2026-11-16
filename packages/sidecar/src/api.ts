import { z } from "zod";

import { headerSchema, type InboxHeader } from "./cache.js";
import type { AgentConnection } from "./config.js";

const envelopeSchema = z.strictObject({ data: z.unknown().nullable(), error: z.object({ code: z.string(), message: z.string() }).nullable(), requestId: z.uuid() });
const pairedSchema = z.strictObject({ token: z.string().regex(/^a2a_[A-Za-z0-9_-]{43}$/), agentId: z.uuid(), organizationId: z.uuid(),
  hostType: z.enum(["claude-code", "codex"]),
  realtime: z.strictObject({ url: z.url(), publishableKey: z.string().min(1) }) });
const realtimeSchema = z.strictObject({ token: z.string(), expiresIn: z.number().int().positive(), url: z.url(), publishableKey: z.string().min(1) });
const inboxSchema = z.strictObject({ items: z.array(headerSchema), nextCursor: z.string().nullable(), briefing: z.unknown().optional() });

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

async function request<T>(url: string, schema: z.ZodType<T>, options: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { accept: "application/json", "cache-control": "no-store", ...options.headers } });
  let envelope: z.infer<typeof envelopeSchema>;
  try { envelope = envelopeSchema.parse(await response.json()); }
  catch { throw new ApiError("INVALID_RESPONSE", response.status); }
  if (!response.ok || envelope.error) throw new ApiError(envelope.error?.code ?? "HTTP_ERROR", response.status);
  try { return schema.parse(envelope.data); }
  catch { throw new ApiError("INVALID_RESPONSE", response.status); }
}

export async function pairAgent(apiUrl: string, code: string) {
  const base = new URL(apiUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))) {
    throw new Error("A2A API URL must use HTTPS");
  }
  return request(new URL("/api/agents/pair", base).toString(), pairedSchema, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
  });
}

export class AgentApi {
  constructor(private readonly config: AgentConnection, private readonly token: string) {}
  private call<T>(path: string, schema: z.ZodType<T>, method = "GET") {
    return request(new URL(path, this.config.apiUrl).toString(), schema, { method, headers: { authorization: `Bearer ${this.token}` } });
  }
  realtimeToken() { return this.call("/api/agents/realtime-token", realtimeSchema, "POST"); }
  heartbeat() { return this.call("/api/agents/heartbeat", z.strictObject({ online: z.boolean() }), "POST"); }
  revoke() { return this.call("/api/agents/token/revoke", z.strictObject({ revoked: z.boolean() }), "POST"); }
  pendingNotices() { return this.call("/api/agents/notifications", z.array(headerSchema)); }
  acknowledgeNotices(ids: string[]) {
    return request(new URL("/api/agents/notifications", this.config.apiUrl).toString(), z.strictObject({ acknowledged: z.array(z.uuid()) }), {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify({ ids }),
    });
  }
  inbox(options: { cursor?: string; includeBriefing?: boolean; unreadOnly?: boolean; limit?: number } = {}) {
    const url = new URL("/api/agents/inbox", this.config.apiUrl);
    url.searchParams.set("unreadOnly", String(options.unreadOnly ?? false));
    url.searchParams.set("limit", String(options.limit ?? 25));
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
    if (options.includeBriefing) url.searchParams.set("includeBriefing", "true");
    return request(url.toString(), inboxSchema, { method: "GET", headers: { authorization: `Bearer ${this.token}` } }) as Promise<{
      items: InboxHeader[]; nextCursor: string | null; briefing?: unknown;
    }>;
  }
  briefing() { return this.call("/api/agents/briefing", z.unknown()); }
}
