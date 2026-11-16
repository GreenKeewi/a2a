import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";
import { mintRealtimeToken, publicRealtimeConfig } from "@/lib/realtime";

export async function POST(request: Request) {
  return respond(async () => ({ ...(await mintRealtimeToken(sql, { kind: "agent", agent: await requireAgent(request) })), ...publicRealtimeConfig() }));
}
