import { heartbeatAgent } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";

export async function POST(request: Request) {
  return respond(async () => heartbeatAgent(sql, await requireAgent(request)));
}
