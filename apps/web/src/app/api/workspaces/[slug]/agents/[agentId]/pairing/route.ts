import { z } from "zod";

import { AgentError, createPairingCode } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string; agentId: string }> };

export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const { slug, agentId } = await params;
    if (!z.uuid().safeParse(agentId).success) throw new AgentError("INVALID_REQUEST");
    const organizationId = await resolveWorkspaceId(sql, slug, userId);
    return { code: await createPairingCode(sql, organizationId, agentId, userId) };
  });
}
