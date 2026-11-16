import { z } from "zod";

import { acknowledgeAgentNotices, pendingAgentNotices } from "@/lib/agents";
import { sql } from "@/lib/db";
import { jsonBody, requireAgent, respond } from "@/lib/http";

const ackSchema = z.strictObject({ ids: z.array(z.uuid()).min(1).max(25) });

export async function GET(request: Request) {
  return respond(async () => pendingAgentNotices(sql, await requireAgent(request)));
}

export async function POST(request: Request) {
  return respond(async () => acknowledgeAgentNotices(sql, await requireAgent(request), (await jsonBody(request, ackSchema)).ids));
}
