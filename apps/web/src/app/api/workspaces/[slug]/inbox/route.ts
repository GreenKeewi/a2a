import { sql } from "@/lib/db";
import { getHumanInbox } from "@/lib/human-dashboard";
import { requireHuman, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };
export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 40);
    return getHumanInbox(sql, organizationId, Number.isFinite(limit) ? limit : 40);
  });
}
