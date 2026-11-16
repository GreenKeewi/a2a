import { z } from "zod";

import { AgentError, resolveCoordinationItem } from "@/lib/agents";
import { sql } from "@/lib/db";
import { jsonBody, requireAgent, respond } from "@/lib/http";

type Context = { params: Promise<{ messageId: string }> };
const stateSchema = z.strictObject({ state: z.enum(["resolved", "cancelled"]) });

export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    const principal = await requireAgent(request);
    const { messageId } = await params;
    if (!z.uuid().safeParse(messageId).success) throw new AgentError("INVALID_REQUEST");
    const { state } = await jsonBody(request, stateSchema);
    return resolveCoordinationItem(sql, principal, messageId, state);
  });
}
