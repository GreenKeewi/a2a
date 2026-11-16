import { z } from "zod";

import { AgentError, readAgentThread } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";

type Context = { params: Promise<{ threadId: string }> };

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const principal = await requireAgent(request);
    const { threadId } = await params;
    if (!z.uuid().safeParse(threadId).success) throw new AgentError("INVALID_REQUEST");
    return readAgentThread(sql, principal, threadId);
  });
}
