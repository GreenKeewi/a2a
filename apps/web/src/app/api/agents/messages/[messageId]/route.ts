import { z } from "zod";

import { AgentError, readAgentMessage } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";

type Context = { params: Promise<{ messageId: string }> };

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const principal = await requireAgent(request);
    const { messageId } = await params;
    if (!z.uuid().safeParse(messageId).success) throw new AgentError("INVALID_REQUEST");
    return readAgentMessage(sql, principal, messageId);
  });
}
