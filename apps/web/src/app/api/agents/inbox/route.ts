import type { InboxInput } from "@a2a/protocol";

import { listAgentInbox } from "@/lib/agents";
import { sql } from "@/lib/db";
import { requireAgent, respond } from "@/lib/http";

export async function GET(request: Request) {
  return respond(async () => {
    const principal = await requireAgent(request);
    const query = new URL(request.url).searchParams;
    return listAgentInbox(sql, principal, {
      unreadOnly: query.has("unreadOnly") ? query.get("unreadOnly") === "true" : undefined,
      limit: query.has("limit") ? Number(query.get("limit")) : undefined,
      cursor: query.get("cursor") ?? undefined,
      includeBriefing: query.get("includeBriefing") === "true",
      types: query.getAll("type").length ? query.getAll("type") as InboxInput["types"] : undefined,
      query: query.get("query") ?? undefined,
    });
  });
}
