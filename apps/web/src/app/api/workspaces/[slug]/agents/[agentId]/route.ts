import { z } from "zod";

import { AgentError, revokeAgent } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string; agentId: string }> };

export async function DELETE(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const { slug, agentId } = await params;
    if (!z.uuid().safeParse(agentId).success) throw new AgentError("INVALID_REQUEST");
    const organizationId = await resolveWorkspaceId(sql, slug, userId);
    return revokeAgent(sql, organizationId, userId, agentId);
  });
}
