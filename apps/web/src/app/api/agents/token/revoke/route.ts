import { revokeAgentToken } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";

export async function POST(request: Request) {
  return respond(async () => revokeAgentToken(sql, await requireAgent(request)));
}
