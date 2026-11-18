import { randomUUID } from "node:crypto";

import { z } from "zod";

import { auth } from "./auth";
import { AgentError, authenticateAgentToken } from "./agents";
import { sql } from "./db";
import { recordRequestMetric } from "./observability";
import { WorkspaceError } from "./workspaces";

export async function requireHuman(request: Request): Promise<string> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new WorkspaceError("UNAUTHENTICATED");
  return session.user.id;
}

export function requireSameOrigin(request: Request) {
  const base = process.env.BETTER_AUTH_URL;
  if (!base || request.headers.get("origin") !== new URL(base).origin) {
    throw new WorkspaceError("FORBIDDEN");
  }
}

export async function requireAgent(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new AgentError("UNAUTHENTICATED");
  return authenticateAgentToken(sql, authorization.slice(7));
}

export async function jsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new WorkspaceError("INVALID_REQUEST"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WorkspaceError("INVALID_REQUEST");
  return parsed.data;
}

export async function respond(handler: () => Promise<unknown>) {
  const requestId = randomUUID();
  const started = performance.now();
  try {
    const data = await handler();
    recordRequestMetric({ surface: "api", status: 200, durationMs: performance.now() - started, requestId });
    return Response.json({ data, error: null, requestId }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const databaseCode = typeof error === "object" && error && "code" in error ? error.code : null;
    const authMessage = typeof error === "object" && error && "body" in error &&
      typeof error.body === "object" && error.body && "message" in error.body ? error.body.message : null;
    const code = error instanceof WorkspaceError || error instanceof AgentError ? error.code :
      databaseCode === "23505" || authMessage === "Organization already exists" ? "CONFLICT" : "INTERNAL_ERROR";
    const apiCode = code === "ALREADY_MEMBER" ? "CONFLICT" :
      code === "INVALID_INVITE" || code === "INVALID_BRIEF" || code === "INVALID_PAIRING_CODE" || code === "INVALID_ROUTE" ? "INVALID_REQUEST" : code;
    const status = apiCode === "UNAUTHENTICATED" ? 401 : apiCode === "FORBIDDEN" ? 403 : apiCode === "CONFLICT" ? 409 :
      apiCode === "NOT_FOUND" ? 404 : apiCode === "INVALID_REQUEST" ? 400 : 500;
    recordRequestMetric({ surface: "api", status, durationMs: performance.now() - started,
      requestId, errorCode: status === 500 && typeof databaseCode === "string" ? databaseCode : apiCode });
    return Response.json({ data: null, error: { code: apiCode, message: apiCode }, requestId }, { status, headers: { "cache-control": "no-store" } });
  }
}
