import { z } from "zod";

import { sql } from "@/lib/db";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { createInviteCode, resolveWorkspaceId, revokeInviteCode } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };
const createSchema = z.strictObject({
  maxUses: z.number().int().min(1).max(100).default(5),
  expiresInHours: z.number().int().min(1).max(168).default(24),
});
const revokeSchema = z.strictObject({ inviteId: z.uuid() });

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const members = await sql`SELECT role FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId}`;
    if (!members[0] || members[0].role !== "owner") return [];
    return sql`
      SELECT id, expires_at, maximum_uses, use_count, revoked_at, created_at
      FROM workspace_invite_codes WHERE organization_id = ${organizationId}
      ORDER BY created_at DESC LIMIT 50
    `;
  });
}

export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const options = await jsonBody(request, createSchema);
    return { code: await createInviteCode(sql, organizationId, userId, options) };
  });
}

export async function DELETE(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const { inviteId } = await jsonBody(request, revokeSchema);
    return revokeInviteCode(sql, organizationId, userId, inviteId);
  });
}
