import { randomUUID } from "node:crypto";

import { type AgentsInput, type InboxInput, type ReadInput, type SendInput } from "@a2a/protocol";
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

export async function pairAgent(apiUrl: string, code: string, hostType: "claude-code" | "codex") {
  const base = new URL(apiUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))) {
    throw new Error("A2A API URL must use HTTPS");
  }
  return request(new URL("/api/agents/pair", base).toString(), pairedSchema, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, hostType }),
  });
}

export class AgentApi {
  constructor(private readonly config: AgentConnection, private readonly token: string) {}
  private call<T>(path: string, schema: z.ZodType<T>, method = "GET", body?: unknown) {
    return request(new URL(path, this.config.apiUrl).toString(), schema, { method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
  inbox(options: Partial<InboxInput> = {}) {
    const url = new URL("/api/agents/inbox", this.config.apiUrl);
    url.searchParams.set("unreadOnly", String(options.unreadOnly ?? true));
    url.searchParams.set("limit", String(options.limit ?? 10));
    if (options.cursor) url.searchParams.set("cursor", options.cursor);
    if (options.includeBriefing) url.searchParams.set("includeBriefing", "true");
    if (options.query) url.searchParams.set("query", options.query);
    for (const type of options.types ?? []) url.searchParams.append("type", type);
    return request(url.toString(), inboxSchema, { method: "GET", headers: { authorization: `Bearer ${this.token}` } }) as Promise<{
      items: InboxHeader[]; nextCursor: string | null; briefing?: unknown;
    }>;
  }
  briefing() { return this.call("/api/agents/briefing", z.unknown()); }
  send(input: SendInput) {
    return this.call("/api/agents/messages", z.strictObject({ messageId: z.uuid(), threadId: z.uuid(),
      recipientHandles: z.array(z.string()), senderUnreadCount: z.number().int().nonnegative() }), "POST",
      { ...input, clientMessageId: randomUUID() });
  }
  read(input: ReadInput) {
    const path = input.mode === "thread" ? `/api/agents/threads/${input.threadId}` : `/api/agents/messages/${input.messageId}`;
    return this.call(path, z.unknown());
  }
  agents(input: AgentsInput) {
    const url = new URL("/api/agents/directory", this.config.apiUrl);
    if (input.onlineOnly) url.searchParams.set("onlineOnly", "true");
    if (input.scope) url.searchParams.set("scope", input.scope);
    return request(url.toString(), z.unknown(), { method: "GET", headers: { authorization: `Bearer ${this.token}` } });
  }
}
