import { AgentCard } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, ServerCallContext } from "@a2a-js/sdk/server";
import { after } from "next/server";

import { AgentError } from "./agents";
import { A2ABridgeHandler, makeAgentCard } from "./a2a-bridge";
import { sql } from "./db";
import { requireAgent } from "./http";
import { recordRequestMetric } from "./observability";
import { runSmartJobs } from "./smart-worker";

function baseUrl() {
  const base = process.env.BETTER_AUTH_URL;
  if (!base) throw new Error("BETTER_AUTH_URL is required for A2A cards");
  return base;
}

export async function agentCardResponse(request: Request, handle: string) {
  let principal;
  try { principal = await requireAgent(request); }
  catch (error) {
    if (error instanceof AgentError) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    throw error;
  }
  const target = await sql`SELECT handle, role FROM agents WHERE organization_id = ${principal.organizationId}
    AND normalized_handle = ${handle.toLowerCase()} AND revoked_at IS NULL AND id <> ${principal.agentId}`;
  if (!target[0]) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const card = makeAgentCard(baseUrl(), { handle: String(target[0].handle), role: String(target[0].role),
    organizationId: principal.organizationId });
  return Response.json(AgentCard.toJSON(card), { headers: { "cache-control": "no-store" } });
}

export function gatewayCardResponse() {
  return Response.json(AgentCard.toJSON(makeAgentCard(baseUrl())), { headers: { "cache-control": "no-store" } });
}

export async function a2aRpcResponse(request: Request, fixedTarget?: string) {
  const started = performance.now();
  const finish = (response: Response, errorCode?: string) => {
    recordRequestMetric({ surface: "a2a_rpc", status: response.status,
      durationMs: performance.now() - started, ...(errorCode ? { errorCode } : {}) });
    return response;
  };
  let principal;
  try { principal = await requireAgent(request); }
  catch (error) {
    if (error instanceof AgentError) return finish(Response.json({ error: "UNAUTHENTICATED" }, { status: 401 }), "UNAUTHENTICATED");
    throw error;
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    let id: string | number | null = null;
    try {
      const parsed: unknown = JSON.parse(await request.text());
      if (typeof parsed === "object" && parsed && "id" in parsed &&
          (typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null)) id = parsed.id;
    } catch { /* An invalid body has no request ID to echo. */ }
    return finish(Response.json({ jsonrpc: "2.0", id,
      error: { code: -32005, message: "Content type not supported" } },
    { status: 415, headers: { "cache-control": "no-store" } }), "CONTENT_TYPE_NOT_SUPPORTED");
  }
  const body = await request.text();
  if (body.length > 256_000) return finish(Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 }), "REQUEST_TOO_LARGE");
  const card = makeAgentCard(baseUrl());
  const context = new ServerCallContext({ requestedVersion: request.headers.get("a2a-version") ?? "0.3",
    user: { isAuthenticated: true, userName: principal.agentId } });
  const transport = new JsonRpcTransportHandler(new A2ABridgeHandler(sql, principal, card, fixedTarget));
  const result = await transport.handle(body, context);
  if (Symbol.asyncIterator in result) {
    let id: string | number | null = null;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed && "id" in parsed &&
          (typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null)) id = parsed.id;
    } catch { /* The SDK already handles malformed JSON. */ }
    return finish(Response.json({ jsonrpc: "2.0", id, error: { code: -32004, message: "Streaming is not supported" } },
      { headers: { "cache-control": "no-store" } }), "STREAMING_NOT_SUPPORTED");
  }
  if ((result.error as { code?: number } | undefined)?.code === -32603) {
    return finish(Response.json({ jsonrpc: "2.0", id: result.id, error: { code: -32603, message: "Internal error" } },
      { headers: { "cache-control": "no-store" } }), "INTERNAL_ERROR");
  }
  if (!result.error && process.env.A2A_TRIAGE_MODEL) {
    try {
      const payload: unknown = JSON.parse(body);
      if (payload && typeof payload === "object" && "method" in payload && payload.method === "SendMessage") {
        after(() => runSmartJobs(sql).then(() => {}).catch(() => {}));
      }
    } catch { /* The SDK has already handled malformed JSON. */ }
  }
  return finish(Response.json(result, { headers: { "cache-control": "no-store" } }),
    result.error ? String((result.error as { code?: number }).code ?? "PROTOCOL_ERROR") : undefined);
}
