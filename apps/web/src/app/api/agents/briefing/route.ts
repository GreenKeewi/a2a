import { getAgentBriefing } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";

export async function GET(request: Request) {
  return respond(async () => getAgentBriefing(sql, await requireAgent(request)));
}
