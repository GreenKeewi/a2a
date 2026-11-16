import { listAgents } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";

export async function GET(request: Request) {
  return respond(async () => {
    const principal = await requireAgent(request);
    const query = new URL(request.url).searchParams;
    return listAgents(sql, principal, {
      onlineOnly: query.get("onlineOnly") === "true",
      scope: query.get("scope") ?? undefined,
    });
  });
}
