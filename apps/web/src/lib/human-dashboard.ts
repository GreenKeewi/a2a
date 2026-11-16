import { randomUUID } from "node:crypto";

import { sendInputSchema, type SendInput } from "@a2a/protocol";
import type { Sql } from "postgres";

import { WorkspaceError } from "./workspaces";

function iso(value: unknown) { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }

export async function getHumanInbox(sql: Sql, organizationId: string, limit = 40) {
  const bounded = Math.max(1, Math.min(limit, 100));
  const rows = await sql`
    SELECT t.id AS thread_id, t.kind, t.name, t.last_message_at,
      m.id AS message_id, m.type, m.priority, m.subject, m.body, m.created_at,
      coalesce(a.handle, u.name, 'Member') AS sender,
      (SELECT array_agg(ag.handle ORDER BY ag.handle) FROM thread_agent_members tm
       JOIN agents ag ON ag.id = tm.agent_id WHERE tm.thread_id = t.id AND ag.revoked_at IS NULL) AS participants,
      (SELECT count(*)::int FROM messages open_m WHERE open_m.thread_id = t.id AND open_m.response_state = 'open') AS open_count
    FROM threads t
    JOIN LATERAL (SELECT * FROM messages WHERE thread_id = t.id AND organization_id = ${organizationId}
      ORDER BY created_at DESC, id DESC LIMIT 1) m ON true
    LEFT JOIN agents a ON a.id = m.sender_agent_id
    LEFT JOIN "user" u ON u.id = m.sender_user_id
    WHERE t.organization_id = ${organizationId}
    ORDER BY t.last_message_at DESC NULLS LAST, t.id DESC LIMIT ${bounded}
  `;
  return rows.map((row) => ({ threadId: String(row.thread_id), kind: String(row.kind), name: row.name ? String(row.name) : null,
    lastMessageAt: iso(row.last_message_at ?? row.created_at), messageId: String(row.message_id),
    type: String(row.type), priority: String(row.priority), subject: String(row.subject),
    preview: String(row.body).slice(0, 180), sender: String(row.sender), participants: (row.participants ?? []) as string[],
    openCount: Number(row.open_count) }));
}

export async function getHumanThread(sql: Sql, organizationId: string, threadId: string) {
  const threads = await sql`SELECT id, kind, name, rolling_summary FROM threads WHERE id = ${threadId} AND organization_id = ${organizationId}`;
  if (!threads[0]) throw new WorkspaceError("FORBIDDEN");
  const rows = await sql`
    SELECT m.id, m.thread_id, m.sender_user_id, m.sender_agent_id, m.type, m.priority, m.subject, m.body,
      m.parts, m.response_state, m.created_at, coalesce(a.handle, u.name, 'Member') AS sender,
      (SELECT count(*)::int FROM message_recipients r WHERE r.message_id = m.id AND r.read_at IS NOT NULL) AS read_count,
      (SELECT count(*)::int FROM message_recipients r WHERE r.message_id = m.id) AS recipient_count
    FROM (SELECT * FROM messages WHERE organization_id = ${organizationId} AND thread_id = ${threadId}
      ORDER BY created_at DESC, id DESC LIMIT 200) m
    LEFT JOIN agents a ON a.id = m.sender_agent_id LEFT JOIN "user" u ON u.id = m.sender_user_id
    ORDER BY m.created_at ASC, m.id ASC
  `;
  return { threadId, kind: String(threads[0].kind), name: threads[0].name ? String(threads[0].name) : null,
    summary: threads[0].rolling_summary ? String(threads[0].rolling_summary) : null,
    messages: rows.map((row) => ({ id: String(row.id), sender: String(row.sender), senderType: row.sender_agent_id ? "agent" : "human",
      type: String(row.type), priority: String(row.priority), subject: String(row.subject), body: String(row.body),
      parts: row.parts, responseState: String(row.response_state), createdAt: iso(row.created_at),
      readCount: Number(row.read_count), recipientCount: Number(row.recipient_count) })) };
}

export async function sendHumanMessage(sql: Sql, organizationId: string, userId: string, input: SendInput) {
  const parsed = sendInputSchema.safeParse(input);
  if (!parsed.success) throw new WorkspaceError("INVALID_REQUEST");
  return sql.begin(async (tx) => {
    const membership = await tx`SELECT 1 FROM member WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR SHARE`;
    if (!membership.length) throw new WorkspaceError("FORBIDDEN");
    const active = await tx`SELECT id, handle, normalized_handle, scopes FROM agents WHERE organization_id = ${organizationId} AND revoked_at IS NULL`;
    const targets = Array.isArray(parsed.data.to) ? parsed.data.to : [parsed.data.to];
    const selected = new Map<string, { id: string; handle: string }>();
    for (const target of targets) {
      if (target === "*") for (const agent of active) selected.set(String(agent.id), { id: String(agent.id), handle: String(agent.handle) });
      else {
        const agent = active.find((candidate) => String(candidate.normalized_handle) === target.toLowerCase());
        if (!agent) throw new WorkspaceError("INVALID_REQUEST");
        selected.set(String(agent.id), { id: String(agent.id), handle: String(agent.handle) });
      }
    }
    if (!selected.size) throw new WorkspaceError("INVALID_REQUEST");
    const recipients = [...selected.values()];
    let threadId = parsed.data.threadId;
    if (threadId) {
      const rows = await tx`SELECT id FROM threads WHERE id = ${threadId} AND organization_id = ${organizationId} FOR SHARE`;
      if (!rows.length) throw new WorkspaceError("FORBIDDEN");
      const members = await tx`SELECT agent_id FROM thread_agent_members WHERE thread_id = ${threadId}`;
      const memberIds = new Set(members.map((member) => String(member.agent_id)));
      if (recipients.some((recipient) => !memberIds.has(recipient.id))) throw new WorkspaceError("INVALID_REQUEST");
      if (parsed.data.replyTo) {
        const replies = await tx`SELECT 1 FROM messages WHERE id = ${parsed.data.replyTo} AND thread_id = ${threadId} AND organization_id = ${organizationId}`;
        if (!replies.length) throw new WorkspaceError("INVALID_REQUEST");
      }
    } else {
      if (parsed.data.replyTo) throw new WorkspaceError("INVALID_REQUEST");
      threadId = randomUUID();
      const kind = targets.includes("*") ? "broadcast" : recipients.length === 1 ? "direct" : "group";
      await tx`INSERT INTO threads (id, organization_id, kind) VALUES (${threadId}, ${organizationId}, ${kind})`;
      for (const recipient of recipients) await tx`INSERT INTO thread_agent_members (thread_id, agent_id) VALUES (${threadId}, ${recipient.id})`;
    }
    const messageId = randomUUID();
    const priority = parsed.data.type === "blocker" ? "high" : parsed.data.priority ?? "normal";
    const requiresResponse = parsed.data.type === "blocker" || parsed.data.type === "question";
    const parts = JSON.stringify([{ type: "text", text: parsed.data.body }, ...(parsed.data.refs ?? []).map((ref) => ({ type: "data", data: ref }))]);
    await tx`
      INSERT INTO messages (id, organization_id, thread_id, sender_user_id, reply_to_message_id, type, priority,
        subject, body, parts, requires_response, response_state)
      VALUES (${messageId}, ${organizationId}, ${threadId}, ${userId}, ${parsed.data.replyTo ?? null}, ${parsed.data.type},
        ${priority}, ${parsed.data.subject}, ${parsed.data.body}, ${parts}::jsonb, ${requiresResponse}, ${requiresResponse ? "open" : "none"})
    `;
    if (parsed.data.type === "decision") {
      await tx`INSERT INTO decision_records (organization_id, source_message_id, title, summary, status)
        VALUES (${organizationId}, ${messageId}, ${parsed.data.subject}, ${parsed.data.body.slice(0, 240)}, 'confirmed')`;
    }
    for (const recipient of recipients) await tx`INSERT INTO message_recipients (message_id, agent_id) VALUES (${messageId}, ${recipient.id})`;
    await tx`UPDATE threads SET last_message_at = now() WHERE id = ${threadId}`;
    await tx`INSERT INTO audit_events (organization_id, actor_user_id, action, target_id) VALUES (${organizationId}, ${userId}, 'human.message.sent', ${messageId})`;
    return { messageId, threadId, recipientHandles: recipients.map((recipient) => recipient.handle).sort() };
  });
}

export async function getDashboardStats(sql: Sql, organizationId: string, timezone: string) {
  const [cards, days, activity] = await Promise.all([
    sql`
      SELECT
        (SELECT count(*)::int FROM agents WHERE organization_id = ${organizationId} AND revoked_at IS NULL AND last_seen_at > now() - interval '90 seconds') AS online,
        (SELECT count(*)::int FROM messages WHERE organization_id = ${organizationId} AND created_at >= now() - interval '24 hours') AS messages_24h,
        (SELECT count(*)::int FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE m.organization_id = ${organizationId} AND r.read_at IS NULL) AS unread_deliveries,
        (SELECT count(*)::int FROM messages WHERE organization_id = ${organizationId} AND response_state = 'open' AND type IN ('blocker','question')) AS open_items
    `,
    sql`
      WITH dates AS (SELECT generate_series(
        (now() AT TIME ZONE ${timezone})::date - 6, (now() AT TIME ZONE ${timezone})::date, interval '1 day')::date AS day)
      SELECT d.day, count(m.id)::int AS count FROM dates d
      LEFT JOIN messages m ON m.organization_id = ${organizationId} AND (m.created_at AT TIME ZONE ${timezone})::date = d.day
      GROUP BY d.day ORDER BY d.day
    `,
    sql`
      SELECT a.id, a.handle, a.role, a.last_seen_at,
        (SELECT count(*)::int FROM messages m WHERE m.sender_agent_id = a.id AND m.organization_id = ${organizationId}) AS sent,
        (SELECT count(*)::int FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE r.agent_id = a.id AND m.organization_id = ${organizationId}) AS received,
        (SELECT count(*)::int FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE r.agent_id = a.id AND m.organization_id = ${organizationId} AND r.read_at IS NULL) AS unread,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (reply.created_at - source.created_at)))
         FROM message_recipients r JOIN messages source ON source.id = r.message_id
         JOIN messages reply ON reply.reply_to_message_id = source.id AND reply.sender_agent_id = a.id
         WHERE r.agent_id = a.id AND source.organization_id = ${organizationId}) AS median_response_seconds
      FROM agents a WHERE a.organization_id = ${organizationId} AND a.revoked_at IS NULL ORDER BY a.handle
    `,
  ]);
  return {
    cards: { agentsOnline: Number(cards[0]?.online ?? 0), messages24h: Number(cards[0]?.messages_24h ?? 0),
      unreadDeliveries: Number(cards[0]?.unread_deliveries ?? 0), openItems: Number(cards[0]?.open_items ?? 0) },
    days: days.map((row) => ({ day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10), count: Number(row.count) })),
    activity: activity.map((row) => ({ id: String(row.id), handle: String(row.handle), role: String(row.role),
      lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null, sent: Number(row.sent), received: Number(row.received),
      unread: Number(row.unread), medianResponseSeconds: row.median_response_seconds == null ? null : Number(row.median_response_seconds) })),
  };
}
