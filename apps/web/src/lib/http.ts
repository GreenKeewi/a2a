import { randomUUID } from "node:crypto";

import { z } from "zod";

import { auth } from "./auth";
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

export async function jsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new WorkspaceError("INVALID_REQUEST"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WorkspaceError("INVALID_REQUEST");
  return parsed.data;
}

export async function respond(handler: () => Promise<unknown>) {
  const requestId = randomUUID();
  try {
    return Response.json({ data: await handler(), error: null, requestId });
  } catch (error) {
    const databaseCode = typeof error === "object" && error && "code" in error ? error.code : null;
    const authMessage = typeof error === "object" && error && "body" in error &&
      typeof error.body === "object" && error.body && "message" in error.body ? error.body.message : null;
    const code = error instanceof WorkspaceError ? error.code :
      databaseCode === "23505" || authMessage === "Organization already exists" ? "CONFLICT" : "INTERNAL_ERROR";
    const apiCode = code === "ALREADY_MEMBER" ? "CONFLICT" :
      code === "INVALID_INVITE" || code === "INVALID_BRIEF" ? "INVALID_REQUEST" : code;
    const status = apiCode === "UNAUTHENTICATED" ? 401 : apiCode === "FORBIDDEN" ? 403 : apiCode === "CONFLICT" ? 409 :
      apiCode === "INVALID_REQUEST" ? 400 : 500;
    if (status === 500) console.error("a2a request failed", { requestId, errorCode: typeof databaseCode === "string" ? databaseCode : "unknown" });
    return Response.json({ data: null, error: { code: apiCode, message: apiCode }, requestId }, { status });
  }
}
