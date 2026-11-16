import { z } from "zod";

import { createAgent, listAgents } from "@/lib/agents";
import { sql } from "@/lib/db";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };
const createSchema = z.strictObject({
  handle: z.string(), hostType: z.enum(["claude-code", "codex"]),
  role: z.string(), scopes: z.array(z.string()).optional(),
});

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    return listAgents(sql, { agentId: "", organizationId });
  });
}

export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    return createAgent(sql, organizationId, userId, await jsonBody(request, createSchema));
  });
}
