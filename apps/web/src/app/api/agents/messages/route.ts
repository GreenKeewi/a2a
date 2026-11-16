import { sendRequestSchema } from "@a2a/protocol";

import { sendAgentMessage } from "@/lib/agents";
import { sql } from "@/lib/db";
import { jsonBody, requireAgent, respond } from "@/lib/http";

export async function POST(request: Request) {
  return respond(async () => {
    const principal = await requireAgent(request);
    const input = await jsonBody(request, sendRequestSchema);
    return sendAgentMessage(sql, principal, input);
  });
}
