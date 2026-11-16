import { z } from "zod";

import { sql } from "@/lib/db";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { readWorkspace, resolveWorkspaceId, updateProjectBrief } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };
const updateSchema = z.strictObject({ brief: z.string().max(2000) });

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const workspace = await readWorkspace(sql, organizationId, userId);
    const versions = await sql`
      SELECT version, brief, created_at FROM workspace_brief_versions
      WHERE organization_id = ${organizationId} ORDER BY version DESC LIMIT 20
    `;
    return { brief: workspace.brief, version: workspace.briefVersion, versions };
  });
}

export async function PATCH(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const { brief } = await jsonBody(request, updateSchema);
    return updateProjectBrief(sql, organizationId, userId, brief);
  });
}
