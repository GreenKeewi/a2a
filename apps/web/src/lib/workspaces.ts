import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Sql } from "postgres";

export class WorkspaceError extends Error {
  constructor(public readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "CONFLICT" | "INVALID_INVITE" | "ALREADY_MEMBER" | "INVALID_BRIEF" | "INVALID_REQUEST") {
    super(code);
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newInviteCode(): string {
  // Nine random bytes carry 72 bits. Base32 needs 15 characters for them.
  let pending = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of randomBytes(9)) {
    pending = (pending << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += inviteAlphabet[(pending >> bitCount) & 31];
      pending &= (1 << bitCount) - 1;
    }
  }
  if (bitCount) encoded += inviteAlphabet[(pending << (5 - bitCount)) & 31];
  return `A2A-${encoded.slice(0, 5)}-${encoded.slice(5, 10)}-${encoded.slice(10)}`;
}

export async function readWorkspace(sql: Sql, organizationId: string, userId: string) {
  const rows = await sql`
    SELECT s.organization_id, s.slug, s.display_name, s.timezone, s.brief,
           s.brief_version, s.smart_features_enabled,
           coalesce((to_jsonb(s)->>'reminder_after_minutes')::int, 120) AS reminder_after_minutes,
           coalesce((to_jsonb(s)->>'escalate_after_minutes')::int, 480) AS escalate_after_minutes,
           m.role
    FROM workspace_settings s
    JOIN member m ON m.organization_id = s.organization_id
    WHERE s.organization_id = ${organizationId} AND m.user_id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new WorkspaceError("FORBIDDEN");
  return {
    organizationId: String(row.organization_id), slug: String(row.slug),
    displayName: String(row.display_name), timezone: String(row.timezone),
    brief: String(row.brief), briefVersion: Number(row.brief_version),
    smartFeaturesEnabled: Boolean(row.smart_features_enabled),
    reminderAfterMinutes: Number(row.reminder_after_minutes), escalateAfterMinutes: Number(row.escalate_after_minutes),
    role: String(row.role),
  };
}

export async function resolveWorkspaceId(sql: Sql, slug: string, userId: string): Promise<string> {
  const rows = await sql`
    SELECT s.organization_id FROM workspace_settings s
    JOIN member m ON m.organization_id = s.organization_id
    WHERE s.slug = ${slug} AND m.user_id = ${userId}
    LIMIT 1
  `;
  if (!rows[0]) throw new WorkspaceError("FORBIDDEN");
  return String(rows[0].organization_id);
}

export async function listWorkspaces(sql: Sql, userId: string) {
  const rows = await sql`
    SELECT s.organization_id, s.slug, s.display_name, m.role
    FROM workspace_settings s JOIN member m ON m.organization_id = s.organization_id
    WHERE m.user_id = ${userId} ORDER BY s.display_name
  `;
  return rows.map((row) => ({
    organizationId: String(row.organization_id), slug: String(row.slug),
    displayName: String(row.display_name), role: String(row.role),
  }));
}

export async function createInviteCode(
  sql: Sql,
  organizationId: string,
  userId: string,
  options: { maxUses: number; expiresInHours: number } = { maxUses: 5, expiresInHours: 24 },
): Promise<string> {
  if (!Number.isInteger(options.maxUses) || options.maxUses < 1 || options.maxUses > 100 ||
      !Number.isInteger(options.expiresInHours) || options.expiresInHours < 1 || options.expiresInHours > 168) {
    throw new WorkspaceError("INVALID_REQUEST");
  }
  const code = newInviteCode();
  const hash = hashCode(code);
  await sql.begin(async (tx) => {
    const members = await tx`SELECT role FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR SHARE`;
    if (!members[0] || members[0].role !== "owner") throw new WorkspaceError("FORBIDDEN");
    await tx`
      INSERT INTO workspace_invite_codes (id, organization_id, code_hash, created_by_user_id, expires_at, maximum_uses)
      VALUES (${randomUUID()}, ${organizationId}, ${hash}, ${userId}, now() + (${options.expiresInHours} * interval '1 hour'), ${options.maxUses})
    `;
    await tx`
      INSERT INTO audit_events (organization_id, actor_user_id, action, target_id)
      VALUES (${organizationId}, ${userId}, 'invite.created', ${organizationId})
    `;
  });
  return code;
}

export async function redeemInviteCode(sql: Sql, code: string, userId: string): Promise<{ organizationId: string }> {
  const normalized = code.trim().toUpperCase();
  if (!/^A2A-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(normalized)) {
    throw new WorkspaceError("INVALID_INVITE");
  }
  const hash = hashCode(normalized);
  return sql.begin(async (tx) => {
    const codes = await tx`
      SELECT id, organization_id, code_hash, expires_at, maximum_uses, use_count, revoked_at
      FROM workspace_invite_codes WHERE code_hash = ${hash} FOR UPDATE
    `;
    const invite = codes[0];
    if (!invite || !timingSafeEqual(Buffer.from(String(invite.code_hash), "hex"), Buffer.from(hash, "hex")) ||
        invite.revoked_at || new Date(String(invite.expires_at)).getTime() <= Date.now() ||
        Number(invite.use_count) >= Number(invite.maximum_uses)) {
      throw new WorkspaceError("INVALID_INVITE");
    }
    const organizationId = String(invite.organization_id);
    const membership = await tx`SELECT 1 FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId}`;
    if (membership.length) throw new WorkspaceError("ALREADY_MEMBER");
    const updated = await tx`
      UPDATE workspace_invite_codes SET use_count = use_count + 1
      WHERE id = ${invite.id} AND revoked_at IS NULL AND expires_at > now() AND use_count < maximum_uses
      RETURNING id
    `;
    if (!updated.length) throw new WorkspaceError("INVALID_INVITE");
    await tx`
      INSERT INTO member (id, organization_id, user_id, role, created_at)
      VALUES (${randomUUID()}, ${organizationId}, ${userId}, 'member', now())
    `;
    return { organizationId };
  });
}

export async function revokeInviteCode(sql: Sql, organizationId: string, userId: string, inviteId: string) {
  return sql.begin(async (tx) => {
    const members = await tx`SELECT role FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR SHARE`;
    if (!members[0] || members[0].role !== "owner") throw new WorkspaceError("FORBIDDEN");
    const revoked = await tx`
      UPDATE workspace_invite_codes SET revoked_at = now()
      WHERE id = ${inviteId} AND organization_id = ${organizationId} AND revoked_at IS NULL
      RETURNING id
    `;
    if (!revoked.length) throw new WorkspaceError("INVALID_INVITE");
    await tx`
      INSERT INTO audit_events (organization_id, actor_user_id, action, target_id)
      VALUES (${organizationId}, ${userId}, 'invite.revoked', ${inviteId})
    `;
    return { revoked: true };
  });
}

export async function updateProjectBrief(sql: Sql, organizationId: string, userId: string, brief: string) {
  if (typeof brief !== "string" || brief.length > 2000) throw new WorkspaceError("INVALID_BRIEF");
  return sql.begin(async (tx) => {
    const members = await tx`SELECT role FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR SHARE`;
    if (!members[0] || members[0].role !== "owner") throw new WorkspaceError("FORBIDDEN");
    const settings = await tx`SELECT brief_version FROM workspace_settings WHERE organization_id = ${organizationId} FOR UPDATE`;
    if (!settings[0]) throw new WorkspaceError("FORBIDDEN");
    const version = Number(settings[0].brief_version) + 1;
    await tx`UPDATE workspace_settings SET brief = ${brief}, brief_version = ${version}, updated_at = now() WHERE organization_id = ${organizationId}`;
    await tx`
      INSERT INTO workspace_brief_versions (organization_id, version, brief, created_by_user_id)
      VALUES (${organizationId}, ${version}, ${brief}, ${userId})
    `;
    await tx`
      INSERT INTO audit_events (organization_id, actor_user_id, action, target_id)
      VALUES (${organizationId}, ${userId}, 'brief.updated', ${organizationId})
    `;
    return { version };
  });
}
