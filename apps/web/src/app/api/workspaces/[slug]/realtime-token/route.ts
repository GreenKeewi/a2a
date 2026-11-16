import { sql } from "@/lib/db";
import { requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { mintRealtimeToken, publicRealtimeConfig } from "@/lib/realtime";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };

export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    return { ...(await mintRealtimeToken(sql, { kind: "user", userId, organizationId })), ...publicRealtimeConfig() };
  });
}
