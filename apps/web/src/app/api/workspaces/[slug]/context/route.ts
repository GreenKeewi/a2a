import { sql } from "@/lib/db";
import { getWorkspaceContext } from "@/lib/human-dashboard";
import { requireHuman, respond } from "@/lib/http";
import { readWorkspace, resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const workspace = await readWorkspace(sql, organizationId, userId);
    const context = await getWorkspaceContext(sql, organizationId);
    return { brief: workspace.brief, briefVersion: workspace.briefVersion, ...context,
      reminderAfterMinutes: workspace.reminderAfterMinutes, escalateAfterMinutes: workspace.escalateAfterMinutes };
  });
}
