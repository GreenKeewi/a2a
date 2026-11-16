import { sql } from "@/lib/db";
import { requireHuman, respond } from "@/lib/http";
import { readWorkspace, resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    return readWorkspace(sql, organizationId, userId);
  });
}
