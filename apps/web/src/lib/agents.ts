import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { agentsInputSchema, decodeCursor, encodeCursor, inboxInputSchema, sendRequestSchema, type SendRequest } from "@a2a/protocol";
import type { Sql } from "postgres";
import { z } from "zod";

export class AgentError extends Error {
  constructor(public readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INVALID_REQUEST" | "INVALID_PAIRING_CODE" | "INVALID_ROUTE") {
    super(code);
  }
}

export type AgentPrincipal = { agentId: string; organizationId: string; tokenId?: string };

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const agentInputSchema = z.strictObject({
  handle: z.string().trim().min(2).max(40).regex(/^[A-Za-z][A-Za-z0-9-]*$/),
  hostType: z.enum(["claude-code", "codex"]),
  role: z.string().trim().min(1).max(100),
  scopes: z.array(z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_./-]+(?:\/\*\*)?$/)).max(20).default([]),
});
export type AgentInput = z.input<typeof agentInputSchema>;

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function base32(bytes: Buffer): string {
  let pending = 0;
  let bits = 0;
  let result = "";
  for (const byte of bytes) {
    pending = (pending << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(pending >> bits) & 31];
      pending &= (1 << bits) - 1;
    }
  }
  if (bits) result += alphabet[(pending << (5 - bits)) & 31];
  return result;
}

function scopeBase(scope: string) { return scope.endsWith("/**") ? scope.slice(0, -3) : scope; }
function scopeMatches(claim: string, requested: string) {
  const base = scopeBase(claim);
  return claim.endsWith("/**") ? requested === base || requested.startsWith(`${base}/`) : requested === base;
}
function scopesOverlap(left: string, right: string) {
  return scopeMatches(left, scopeBase(right)) || scopeMatches(right, scopeBase(left));
}

export async function createAgent(sql: Sql, organizationId: string, userId: string, input: AgentInput) {
  const parsed = agentInputSchema.safeParse(input);
  if (!parsed.success) throw new AgentError("INVALID_REQUEST");
  const normalizedHandle = parsed.data.handle.toLowerCase();
  const agentId = randomUUID();
  return sql.begin(async (tx) => {
    const membership = await tx`SELECT 1 FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR SHARE`;
    if (!membership.length) throw new AgentError("FORBIDDEN");
    const existing = await tx`SELECT handle, scopes FROM agents WHERE organization_id = ${organizationId} AND revoked_at IS NULL`;
    const overlapWarnings = existing.flatMap((agent) =>
      parsed.data.scopes.flatMap((scope) => (agent.scopes as string[]).some((owned) => scopesOverlap(scope, owned)) ? [String(agent.handle)] : []));
    await tx`
      INSERT INTO agents (id, organization_id, created_by_user_id, handle, normalized_handle, host_type, role, scopes)
      VALUES (${agentId}, ${organizationId}, ${userId}, ${parsed.data.handle}, ${normalizedHandle}, ${parsed.data.hostType}, ${parsed.data.role}, ${parsed.data.scopes})
    `;
    await tx`INSERT INTO audit_events (organization_id, actor_user_id, action, target_id) VALUES (${organizationId}, ${userId}, 'agent.created', ${agentId})`;
    return { id: agentId, handle: parsed.data.handle, overlapWarnings: [...new Set(overlapWarnings)] };
  });
}

export async function createPairingCode(sql: Sql, organizationId: string, agentId: string, userId: string): Promise<string> {
  const codeBits = base32(randomBytes(5));
  const code = `A2A-PAIR-${codeBits.slice(0, 4)}-${codeBits.slice(4)}`;
  await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT a.organization_id FROM agents a
      JOIN member m ON m.organization_id = a.organization_id
      WHERE a.id = ${agentId} AND a.organization_id = ${organizationId} AND a.revoked_at IS NULL AND m.user_id = ${userId}
        AND (a.created_by_user_id = ${userId} OR m.role = 'owner')
      FOR SHARE OF a, m
    `;
    if (!rows[0]) throw new AgentError("FORBIDDEN");
    await tx`
      INSERT INTO agent_pairing_codes (agent_id, code_hash, expires_at)
      VALUES (${agentId}, ${hash(code)}, now() + interval '10 minutes')
    `;
    await tx`INSERT INTO audit_events (organization_id, actor_user_id, action, target_id) VALUES (${rows[0].organization_id}, ${userId}, 'pairing.created', ${agentId})`;
  });
  return code;
}

export async function exchangePairingCode(sql: Sql, input: string) {
  const code = input.trim().toUpperCase();
  if (!/^A2A-PAIR-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)) throw new AgentError("INVALID_PAIRING_CODE");
  const codeHash = hash(code);
  return sql.begin(async (tx) => {
    const rows = await tx`
      SELECT p.id, p.code_hash, p.agent_id, p.expires_at, p.used_at, a.organization_id, a.revoked_at
      FROM agent_pairing_codes p JOIN agents a ON a.id = p.agent_id
      WHERE p.code_hash = ${codeHash} FOR UPDATE OF p
    `;
    const row = rows[0];
    if (!row || !timingSafeEqual(Buffer.from(String(row.code_hash), "hex"), Buffer.from(codeHash, "hex")) ||
        row.used_at || row.revoked_at || new Date(String(row.expires_at)).getTime() <= Date.now()) {
      throw new AgentError("INVALID_PAIRING_CODE");
    }
    await tx`UPDATE agent_pairing_codes SET used_at = now() WHERE id = ${row.id} AND used_at IS NULL`;
    const token = `a2a_${randomBytes(32).toString("base64url")}`;
    const tokenId = randomUUID();
    await tx`
      INSERT INTO agent_tokens (id, agent_id, token_hash, display_prefix)
      VALUES (${tokenId}, ${row.agent_id}, ${hash(token)}, ${token.slice(0, 12)})
    `;
    await tx`INSERT INTO audit_events (organization_id, actor_agent_id, action, target_id) VALUES (${row.organization_id}, ${row.agent_id}, 'token.issued', ${tokenId})`;
    return { token, agentId: String(row.agent_id), organizationId: String(row.organization_id) };
  });
}

export async function authenticateAgentToken(sql: Sql, token: string): Promise<AgentPrincipal> {
  if (!/^a2a_[A-Za-z0-9_-]{43}$/.test(token)) throw new AgentError("UNAUTHENTICATED");
  const tokenHash = hash(token);
  const rows = await sql`
    UPDATE agent_tokens t SET last_used_at = now()
    FROM agents a WHERE a.id = t.agent_id AND t.token_hash = ${tokenHash} AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > now()) AND a.revoked_at IS NULL
    RETURNING t.id AS token_id, t.token_hash, t.agent_id, a.organization_id
  `;
  const row = rows[0];
  if (!row || !timingSafeEqual(Buffer.from(String(row.token_hash), "hex"), Buffer.from(tokenHash, "hex"))) {
    throw new AgentError("UNAUTHENTICATED");
  }
  return { agentId: String(row.agent_id), organizationId: String(row.organization_id), tokenId: String(row.token_id) };
}

export async function revokeAgentToken(sql: Sql, principal: AgentPrincipal) {
  const tokenId = principal.tokenId;
  if (!tokenId) throw new AgentError("INVALID_REQUEST");
  return sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE agent_tokens t SET revoked_at = now()
      FROM agents a WHERE t.id = ${tokenId} AND t.agent_id = ${principal.agentId}
        AND a.id = t.agent_id AND a.organization_id = ${principal.organizationId} AND t.revoked_at IS NULL
      RETURNING t.id
    `;
    if (!rows.length) throw new AgentError("NOT_FOUND");
    await tx`INSERT INTO audit_events (organization_id, actor_agent_id, action, target_id) VALUES (${principal.organizationId}, ${principal.agentId}, 'token.revoked', ${tokenId})`;
    return { revoked: true };
  });
}

export async function revokeAgent(sql: Sql, organizationId: string, userId: string, agentId: string) {
  return sql.begin(async (tx) => {
    const membership = await tx`SELECT role FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR SHARE`;
    if (!membership[0]) throw new AgentError("FORBIDDEN");
    const revoked = await tx`
      UPDATE agents SET revoked_at = now(), updated_at = now()
      WHERE id = ${agentId} AND organization_id = ${organizationId} AND revoked_at IS NULL
        AND (created_by_user_id = ${userId} OR ${membership[0].role} = 'owner')
      RETURNING id
    `;
    if (!revoked.length) throw new AgentError("NOT_FOUND");
    await tx`UPDATE agent_tokens SET revoked_at = now() WHERE agent_id = ${agentId} AND revoked_at IS NULL`;
    await tx`INSERT INTO audit_events (organization_id, actor_user_id, action, target_id) VALUES (${organizationId}, ${userId}, 'agent.revoked', ${agentId})`;
    return { revoked: true };
  });
}

function resolveRecipients(agents: Array<{ id: string; handle: string; scopes: string[] }>, senderId: string, targets: string[]) {
  const result = new Map<string, { id: string; handle: string }>();
  for (const target of targets) {
    if (target === "*") {
      for (const agent of agents) if (agent.id !== senderId) result.set(agent.id, agent);
    } else if (target.toLowerCase().startsWith("owner:")) {
      const scope = target.slice(6).trim();
      if (!scope) throw new AgentError("INVALID_ROUTE");
      const matches = agents.filter((agent) => agent.id !== senderId).flatMap((agent) =>
        agent.scopes.filter((claim) => scopeMatches(claim, scope)).map((claim) => ({ agent, specificity: scopeBase(claim).length })));
      matches.sort((a, b) => b.specificity - a.specificity);
      const best = matches[0];
      if (!best || matches.some((match) => match.specificity === best.specificity && match.agent.id !== best.agent.id)) {
        throw new AgentError("INVALID_ROUTE");
      }
      result.set(best.agent.id, best.agent);
    } else {
      const found = agents.find((agent) => agent.handle.toLowerCase() === target.toLowerCase() && agent.id !== senderId);
      if (!found) throw new AgentError("INVALID_ROUTE");
      result.set(found.id, found);
    }
  }
  if (!result.size) throw new AgentError("INVALID_ROUTE");
  return [...result.values()];
}

async function previousSend(sql: Sql, senderId: string, clientMessageId: string) {
  const rows = await sql`
    SELECT m.id, m.thread_id, array_agg(a.handle ORDER BY a.handle) AS handles
    FROM messages m JOIN message_recipients r ON r.message_id = m.id JOIN agents a ON a.id = r.agent_id
    WHERE m.sender_agent_id = ${senderId} AND m.client_message_id = ${clientMessageId}
    GROUP BY m.id, m.thread_id
  `;
  if (!rows[0]) return null;
  return { messageId: String(rows[0].id), threadId: String(rows[0].thread_id), recipientHandles: rows[0].handles as string[] };
}

async function senderUnreadCount(sql: Sql, agentId: string) {
  const rows = await sql`SELECT count(*)::int AS count FROM message_recipients WHERE agent_id = ${agentId} AND read_at IS NULL`;
  return Number(rows[0]?.count ?? 0);
}

export async function sendAgentMessage(sql: Sql, principal: AgentPrincipal, input: SendRequest) {
  const parsed = sendRequestSchema.safeParse(input);
  if (!parsed.success) throw new AgentError("INVALID_REQUEST");
  const existing = await previousSend(sql, principal.agentId, parsed.data.clientMessageId);
  if (existing) return { ...existing, senderUnreadCount: await senderUnreadCount(sql, principal.agentId) };
  try {
    const sent = await sql.begin(async (tx) => {
      const sender = await tx`SELECT id FROM agents WHERE id = ${principal.agentId} AND organization_id = ${principal.organizationId} AND revoked_at IS NULL`;
      if (!sender.length) throw new AgentError("UNAUTHENTICATED");
      const active = await tx`SELECT id, handle, scopes FROM agents WHERE organization_id = ${principal.organizationId} AND revoked_at IS NULL`;
      const recipients = resolveRecipients(active.map((row) => ({ id: String(row.id), handle: String(row.handle), scopes: row.scopes as string[] })), principal.agentId,
        Array.isArray(parsed.data.to) ? parsed.data.to : [parsed.data.to]);
      let threadId = parsed.data.threadId;
      if (threadId) {
        const thread = await tx`
          SELECT t.id FROM threads t JOIN thread_agent_members tm ON tm.thread_id = t.id
          WHERE t.id = ${threadId} AND t.organization_id = ${principal.organizationId} AND tm.agent_id = ${principal.agentId}
        `;
        if (!thread.length) throw new AgentError("NOT_FOUND");
        const members = await tx`SELECT agent_id FROM thread_agent_members WHERE thread_id = ${threadId}`;
        if (recipients.some((recipient) => !members.some((member) => member.agent_id === recipient.id))) throw new AgentError("INVALID_ROUTE");
      } else {
        threadId = randomUUID();
        const kind = (Array.isArray(parsed.data.to) ? parsed.data.to : [parsed.data.to]).includes("*") ? "broadcast" : recipients.length === 1 ? "direct" : "group";
        await tx`INSERT INTO threads (id, organization_id, kind) VALUES (${threadId}, ${principal.organizationId}, ${kind})`;
        for (const memberId of [principal.agentId, ...recipients.map((recipient) => recipient.id)]) {
          await tx`INSERT INTO thread_agent_members (thread_id, agent_id) VALUES (${threadId}, ${memberId})`;
        }
      }
      if (parsed.data.replyTo) {
        const reply = await tx`SELECT 1 FROM messages WHERE id = ${parsed.data.replyTo} AND thread_id = ${threadId} AND organization_id = ${principal.organizationId}`;
        if (!reply.length) throw new AgentError("NOT_FOUND");
      }
      const messageId = randomUUID();
      const priority = parsed.data.type === "blocker" ? "high" : parsed.data.priority ?? "normal";
      const requiresResponse = parsed.data.type === "blocker" || parsed.data.type === "question";
      const parts = JSON.stringify([{ type: "text", text: parsed.data.body }, ...(parsed.data.refs ?? []).map((ref) => ({ type: "data", data: ref }))]);
      await tx`
        INSERT INTO messages (id, organization_id, thread_id, sender_agent_id, client_message_id, reply_to_message_id,
                              type, priority, subject, body, parts, requires_response, response_state)
        VALUES (${messageId}, ${principal.organizationId}, ${threadId}, ${principal.agentId}, ${parsed.data.clientMessageId}, ${parsed.data.replyTo ?? null},
                ${parsed.data.type}, ${priority}, ${parsed.data.subject}, ${parsed.data.body}, ${parts}::jsonb, ${requiresResponse}, ${requiresResponse ? "open" : "none"})
      `;
      if (parsed.data.type === "decision") {
        await tx`
          INSERT INTO decision_records (organization_id, source_message_id, title, summary, status)
          VALUES (${principal.organizationId}, ${messageId}, ${parsed.data.subject}, ${parsed.data.body.slice(0, 240)}, 'confirmed')
        `;
      }
      for (const recipient of recipients) {
        await tx`INSERT INTO message_recipients (message_id, agent_id) VALUES (${messageId}, ${recipient.id})`;
      }
      await tx`UPDATE threads SET last_message_at = now() WHERE id = ${threadId}`;
      return { messageId, threadId, recipientHandles: recipients.map((recipient) => recipient.handle).sort() };
    });
    return { ...sent, senderUnreadCount: await senderUnreadCount(sql, principal.agentId) };
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      const duplicate = await previousSend(sql, principal.agentId, parsed.data.clientMessageId);
      if (duplicate) return { ...duplicate, senderUnreadCount: await senderUnreadCount(sql, principal.agentId) };
    }
    throw error;
  }
}

export async function listAgentInbox(sql: Sql, principal: AgentPrincipal, input: unknown = {}) {
  const parsed = inboxInputSchema.safeParse(input);
  if (!parsed.success) throw new AgentError("INVALID_REQUEST");
  const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
  const clauses = ["r.agent_id = $1", "m.organization_id = $2"];
  const args: Array<string | number | string[]> = [principal.agentId, principal.organizationId];
  if (parsed.data.unreadOnly) clauses.push("r.read_at IS NULL");
  if (cursor) {
    args.push(cursor.createdAt, cursor.id);
    clauses.push(`(m.created_at, m.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
  }
  if (parsed.data.types) {
    args.push(parsed.data.types);
    clauses.push(`m.type = ANY($${args.length}::text[])`);
  }
  if (parsed.data.query) {
    args.push(parsed.data.query);
    clauses.push(`m.search_vector @@ plainto_tsquery('english', $${args.length})`);
  }
  args.push(parsed.data.limit + 1);
  const rows = await sql.unsafe(`
    SELECT m.id, m.thread_id, m.type, m.priority, m.subject, m.created_at,
           a.handle AS sender_handle, r.read_at
    FROM message_recipients r JOIN messages m ON m.id = r.message_id
    JOIN agents a ON a.id = m.sender_agent_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.created_at DESC, m.id DESC LIMIT $${args.length}
  `, args);
  const items = rows.slice(0, parsed.data.limit).map((row) => ({
    id: String(row.id), threadId: String(row.thread_id), type: String(row.type), priority: String(row.priority),
    subject: String(row.subject), senderHandle: String(row.sender_handle),
    createdAt: new Date(String(row.created_at)).toISOString(), unread: row.read_at === null,
  }));
  const deliveredIds = items.map((item) => item.id);
  if (deliveredIds.length) await sql`
    UPDATE message_recipients SET delivered_at = coalesce(delivered_at, now())
    WHERE agent_id = ${principal.agentId} AND message_id = ANY(${deliveredIds}::uuid[])
  `;
  const last = items.at(-1);
  return { items, nextCursor: rows.length > parsed.data.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    briefing: parsed.data.includeBriefing ? await getAgentBriefing(sql, principal) : undefined };
}

export async function getAgentBriefing(sql: Sql, principal: AgentPrincipal) {
  const [settings, agent, others, decisions, openItems] = await Promise.all([
    sql`SELECT brief, brief_version FROM workspace_settings WHERE organization_id = ${principal.organizationId}`,
    sql`SELECT handle, role, scopes FROM agents WHERE id = ${principal.agentId} AND organization_id = ${principal.organizationId} AND revoked_at IS NULL`,
    sql`SELECT handle, role, scopes FROM agents WHERE organization_id = ${principal.organizationId} AND id <> ${principal.agentId} AND revoked_at IS NULL ORDER BY normalized_handle LIMIT 12`,
    sql`SELECT title, summary FROM decision_records WHERE organization_id = ${principal.organizationId} AND status = 'confirmed' ORDER BY created_at DESC LIMIT 3`,
    sql`
      SELECT m.id, m.type, m.subject FROM messages m
      JOIN message_recipients r ON r.message_id = m.id
      WHERE r.agent_id = ${principal.agentId} AND m.organization_id = ${principal.organizationId}
        AND m.response_state = 'open' ORDER BY m.created_at DESC LIMIT 5
    `,
  ]);
  if (!settings[0] || !agent[0]) throw new AgentError("UNAUTHENTICATED");
  return {
    brief: String(settings[0].brief), briefVersion: Number(settings[0].brief_version),
    self: { handle: String(agent[0].handle), role: String(agent[0].role), scopes: agent[0].scopes as string[] },
    others: others.map((row) => ({ handle: String(row.handle), role: String(row.role), scopes: row.scopes as string[] })),
    decisions: decisions.map((row) => ({ title: String(row.title), summary: String(row.summary) })),
    openItems: openItems.map((row) => ({ id: String(row.id), type: String(row.type), subject: String(row.subject) })),
  };
}

export async function readAgentMessage(sql: Sql, principal: AgentPrincipal, messageId: string) {
  const rows = await sql`
    UPDATE message_recipients r SET read_at = coalesce(r.read_at, now()), delivered_at = coalesce(r.delivered_at, now())
    FROM messages m WHERE r.message_id = m.id AND m.id = ${messageId}
      AND m.organization_id = ${principal.organizationId} AND r.agent_id = ${principal.agentId}
    RETURNING m.id, m.thread_id, m.type, m.priority, m.subject, m.body, m.parts, m.created_at
  `;
  const row = rows[0];
  if (!row) throw new AgentError("NOT_FOUND");
  return { id: String(row.id), threadId: String(row.thread_id), type: String(row.type), priority: String(row.priority),
    subject: String(row.subject), body: String(row.body), parts: row.parts, createdAt: new Date(String(row.created_at)).toISOString() };
}

export async function readAgentThread(sql: Sql, principal: AgentPrincipal, threadId: string) {
  return sql.begin(async (tx) => {
    const threads = await tx`
      SELECT t.rolling_summary, t.summary_version FROM threads t
      JOIN thread_agent_members tm ON tm.thread_id = t.id
      WHERE t.id = ${threadId} AND t.organization_id = ${principal.organizationId} AND tm.agent_id = ${principal.agentId}
    `;
    if (!threads[0]) throw new AgentError("NOT_FOUND");
    const rows = await tx`
      SELECT m.id, m.thread_id, m.type, m.priority, m.subject, m.body, m.parts, m.created_at,
             a.handle AS sender_handle
      FROM messages m LEFT JOIN agents a ON a.id = m.sender_agent_id
      WHERE m.thread_id = ${threadId} AND m.organization_id = ${principal.organizationId}
      ORDER BY m.created_at DESC, m.id DESC LIMIT 4
    `;
    const ids = rows.map((row) => String(row.id));
    if (ids.length) await tx`
      UPDATE message_recipients SET read_at = coalesce(read_at, now()), delivered_at = coalesce(delivered_at, now())
      WHERE agent_id = ${principal.agentId} AND message_id = ANY(${ids}::uuid[])
    `;
    return {
      threadId, summary: threads[0].rolling_summary ? String(threads[0].rolling_summary) : null,
      summaryVersion: Number(threads[0].summary_version),
      messages: rows.reverse().map((row) => ({
        id: String(row.id), type: String(row.type), priority: String(row.priority),
        subject: String(row.subject), body: String(row.body), parts: row.parts,
        senderHandle: row.sender_handle ? String(row.sender_handle) : null,
        createdAt: new Date(String(row.created_at)).toISOString(),
      })),
    };
  });
}

export async function resolveCoordinationItem(sql: Sql, principal: AgentPrincipal, messageId: string, state: "resolved" | "cancelled") {
  return sql.begin(async (tx) => {
    const rows = await tx`
      SELECT sender_agent_id, response_state FROM messages
      WHERE id = ${messageId} AND organization_id = ${principal.organizationId} AND requires_response = true
      FOR UPDATE
    `;
    if (!rows[0]) throw new AgentError("NOT_FOUND");
    if (rows[0].sender_agent_id !== principal.agentId) throw new AgentError("FORBIDDEN");
    if (rows[0].response_state !== "open") throw new AgentError("CONFLICT");
    await tx`
      UPDATE messages SET response_state = ${state}, resolved_by_agent_id = ${principal.agentId}, resolved_at = now()
      WHERE id = ${messageId}
    `;
    await tx`INSERT INTO audit_events (organization_id, actor_agent_id, action, target_id) VALUES (${principal.organizationId}, ${principal.agentId}, ${`coordination.${state}`}, ${messageId})`;
    return { state };
  });
}

export async function heartbeatAgent(sql: Sql, principal: AgentPrincipal) {
  const rows = await sql`
    UPDATE agents SET last_seen_at = now() WHERE id = ${principal.agentId}
      AND organization_id = ${principal.organizationId} AND revoked_at IS NULL RETURNING id
  `;
  if (!rows.length) throw new AgentError("UNAUTHENTICATED");
  return { online: true };
}

export async function listAgents(sql: Sql, principal: AgentPrincipal, input: unknown = {}) {
  const parsed = agentsInputSchema.safeParse(input);
  if (!parsed.success) throw new AgentError("INVALID_REQUEST");
  const rows = await sql`
    SELECT id, handle, host_type, role, scopes, last_seen_at
    FROM agents WHERE organization_id = ${principal.organizationId} AND revoked_at IS NULL
    ORDER BY normalized_handle
  `;
  const now = Date.now();
  return rows.map((row) => {
    const last = row.last_seen_at ? new Date(String(row.last_seen_at)).getTime() : 0;
    const elapsed = now - last;
    return {
      id: String(row.id), handle: String(row.handle), hostType: String(row.host_type), role: String(row.role),
      scopes: row.scopes as string[], lastSeenAt: last ? new Date(last).toISOString() : null,
      presence: last && elapsed < 90_000 ? "online" : last && elapsed < 600_000 ? "idle" : "offline",
    };
  }).filter((agent) => (!parsed.data.onlineOnly || agent.presence === "online") &&
    (!parsed.data.scope || agent.scopes.some((scope) => scopeMatches(scope, parsed.data.scope!))));
}
