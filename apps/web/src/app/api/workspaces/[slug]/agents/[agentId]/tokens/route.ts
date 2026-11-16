import { z } from "zod";

import { AgentError, listAgentTokensForHuman } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireHuman, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string; agentId: string }> };

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const { slug, agentId } = await params;
    if (!z.uuid().safeParse(agentId).success) throw new AgentError("INVALID_REQUEST");
    const organizationId = await resolveWorkspaceId(sql, slug, userId);
    return listAgentTokensForHuman(sql, organizationId, userId, agentId);
  });
}
