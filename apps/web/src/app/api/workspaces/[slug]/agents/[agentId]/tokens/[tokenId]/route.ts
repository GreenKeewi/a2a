import { z } from "zod";

import { AgentError, revokeAgentTokenForHuman } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string; agentId: string; tokenId: string }> };

export async function DELETE(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const { slug, agentId, tokenId } = await params;
    if (!z.uuid().safeParse(agentId).success || !z.uuid().safeParse(tokenId).success) throw new AgentError("INVALID_REQUEST");
    const organizationId = await resolveWorkspaceId(sql, slug, userId);
    return revokeAgentTokenForHuman(sql, organizationId, userId, agentId, tokenId);
  });
}
