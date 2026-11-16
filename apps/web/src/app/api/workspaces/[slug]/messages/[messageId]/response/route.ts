import { z } from "zod";

import { sql } from "@/lib/db";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { resolveWorkspaceId, WorkspaceError } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string; messageId: string }> };
const inputSchema = z.strictObject({ state: z.enum(["resolved", "cancelled"]) });

export async function PATCH(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const { slug, messageId } = await params;
    if (!z.uuid().safeParse(messageId).success) throw new WorkspaceError("INVALID_REQUEST");
    const organizationId = await resolveWorkspaceId(sql, slug, userId);
    const { state } = await jsonBody(request, inputSchema);
    await sql.begin(async (tx) => {
      const rows = await tx`UPDATE messages SET response_state = ${state}, resolved_by_user_id = ${userId}, resolved_at = now()
        WHERE id = ${messageId} AND organization_id = ${organizationId} AND response_state = 'open'
        RETURNING id`;
      if (!rows.length) throw new WorkspaceError("CONFLICT");
      await tx`INSERT INTO audit_events (organization_id, actor_user_id, action, target_id)
        VALUES (${organizationId}, ${userId}, ${`message.response.${state}`}, ${messageId})`;
    });
    return { id: messageId, state };
  });
}
