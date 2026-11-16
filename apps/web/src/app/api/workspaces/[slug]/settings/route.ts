import { z } from "zod";

import { sql } from "@/lib/db";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { readWorkspace, resolveWorkspaceId, WorkspaceError } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };
const updateSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().min(1).max(80).optional(),
  smartFeaturesEnabled: z.boolean().optional(),
  reminderAfterMinutes: z.number().int().min(5).max(10080).optional(),
  escalateAfterMinutes: z.number().int().min(10).max(20160).optional(),
}).refine((value) => Object.keys(value).length > 0);

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const [workspace, members] = await Promise.all([
      readWorkspace(sql, organizationId, userId),
      sql`SELECT u.name, u.email, m.role FROM member m JOIN "user" u ON u.id = m.user_id
          WHERE m.organization_id = ${organizationId} ORDER BY m.role, u.name`,
    ]);
    return { workspace, members };
  });
}

export async function PATCH(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const input = await jsonBody(request, updateSchema);
    const timezone = input.timezone;
    if (timezone) {
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
      catch { throw new WorkspaceError("INVALID_REQUEST"); }
      const valid = await sql`SELECT 1 FROM pg_timezone_names WHERE name = ${timezone}`;
      if (!valid.length) throw new WorkspaceError("INVALID_REQUEST");
    }
    const rows = await sql`UPDATE workspace_settings s SET
      display_name = coalesce(${input.displayName ?? null}, s.display_name),
      timezone = coalesce(${timezone ?? null}, s.timezone),
      smart_features_enabled = coalesce(${input.smartFeaturesEnabled ?? null}, s.smart_features_enabled),
      smart_enabled_at = CASE
        WHEN ${input.smartFeaturesEnabled ?? null}::boolean IS TRUE AND NOT s.smart_features_enabled THEN now()
        WHEN ${input.smartFeaturesEnabled ?? null}::boolean IS FALSE THEN NULL
        ELSE s.smart_enabled_at END,
      reminder_after_minutes = coalesce(${input.reminderAfterMinutes ?? null}, s.reminder_after_minutes),
      escalate_after_minutes = coalesce(${input.escalateAfterMinutes ?? null}, s.escalate_after_minutes),
      updated_at = now()
      WHERE s.organization_id = ${organizationId} AND EXISTS (
        SELECT 1 FROM member m WHERE m.organization_id = s.organization_id
        AND m.user_id = ${userId} AND m.role = 'owner')
        AND coalesce(${input.escalateAfterMinutes ?? null}, s.escalate_after_minutes)
          > coalesce(${input.reminderAfterMinutes ?? null}, s.reminder_after_minutes)
      RETURNING s.organization_id`;
    if (!rows.length) {
      const owner = await sql`SELECT 1 FROM member WHERE organization_id = ${organizationId}
        AND user_id = ${userId} AND role = 'owner'`;
      throw new WorkspaceError(owner.length ? "INVALID_REQUEST" : "FORBIDDEN");
    }
    return readWorkspace(sql, organizationId, userId);
  });
}
