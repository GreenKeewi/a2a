import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  authenticateAgentToken, createAgent, createPairingCode, exchangePairingCode,
  getAgentBriefing, heartbeatAgent, listAgentInbox, listAgentTokensForHuman, listAgents, readAgentMessage, readAgentThread,
  resolveCoordinationItem, revokeAgent, revokeAgentToken, revokeAgentTokenForHuman, sendAgentMessage,
} from "./agents";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname)) {
  throw new Error("TEST_DATABASE_URL must point to local PostgreSQL");
}
const databaseName = `a2a_phase2_${randomUUID().replaceAll("-", "")}`;
const url = new URL(adminUrl);
url.pathname = `/${databaseName}`;
const admin = postgres(adminUrl, { prepare: false });
const sql = postgres(url.toString(), { max: 10, prepare: false });
const ownerId = randomUUID();
const alphaId = randomUUID();
const betaId = randomUUID();
const migrations = resolve(import.meta.dirname, "../../../../supabase/migrations");

beforeAll(async () => {
  process.env.DATABASE_URL = url.toString();
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:4300";
  process.env.BETTER_AUTH_SECRET = "local-testing-secret-with-32-plus-characters";
  process.env.GOOGLE_CLIENT_ID = "local-placeholder";
  process.env.GOOGLE_CLIENT_SECRET = "local-placeholder";
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
    await sql.unsafe(await readFile(resolve(migrations, name), "utf8"));
  }
  await sql`INSERT INTO "user" (id, name, email) VALUES (${ownerId}, 'Owner', 'agent-owner@example.test')`;
  await sql`INSERT INTO organization (id, name, slug, created_at) VALUES (${alphaId}, 'Alpha', 'alpha-agents', now()), (${betaId}, 'Beta', 'beta-agents', now())`;
  await sql`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${randomUUID()}, ${alphaId}, ${ownerId}, 'owner', now()), (${randomUUID()}, ${betaId}, ${ownerId}, 'owner', now())`;
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
}, 60_000);

it("exchanges a pairing code once and revokes its token immediately", async () => {
  const created = await createAgent(sql, alphaId, ownerId, { handle: "codex-api", hostType: "codex", role: "API", scopes: ["apps/api/**"] });
  const code = await createPairingCode(sql, alphaId, created.id, ownerId);
  await expect(createPairingCode(sql, betaId, created.id, ownerId)).rejects.toThrow("FORBIDDEN");
  const replacementCode = await createPairingCode(sql, alphaId, created.id, ownerId);
  await expect(exchangePairingCode(sql, code)).rejects.toThrow("INVALID_PAIRING_CODE");
  const paired = await exchangePairingCode(sql, replacementCode);
  expect(paired.token).toMatch(/^a2a_[A-Za-z0-9_-]{43}$/);
  await expect(exchangePairingCode(sql, replacementCode)).rejects.toThrow("INVALID_PAIRING_CODE");
  const principal = await authenticateAgentToken(sql, paired.token);
  expect(principal.agentId).toBe(created.id);
  const listed = await listAgentTokensForHuman(sql, alphaId, ownerId, created.id);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.displayPrefix).toBe(paired.token.slice(0, 12));
  await revokeAgentTokenForHuman(sql, alphaId, ownerId, created.id, listed[0]!.id);
  await expect(authenticateAgentToken(sql, paired.token)).rejects.toThrow("UNAUTHENTICATED");
  const nextCode = await createPairingCode(sql, alphaId, created.id, ownerId);
  const nextPair = await exchangePairingCode(sql, nextCode);
  const nextPrincipal = await authenticateAgentToken(sql, nextPair.token);
  await revokeAgentToken(sql, nextPrincipal);
  await expect(authenticateAgentToken(sql, nextPair.token)).rejects.toThrow("UNAUTHENTICATED");
});

it("deduplicates a send and leaves group receipts independent", async () => {
  const sender = await createAgent(sql, alphaId, ownerId, { handle: "claude-web", hostType: "claude-code", role: "Web", scopes: ["apps/web/**"] });
  const a = await createAgent(sql, alphaId, ownerId, { handle: "codex-db", hostType: "codex", role: "DB", scopes: ["database-schema"] });
  const b = await createAgent(sql, alphaId, ownerId, { handle: "claude-qa", hostType: "claude-code", role: "QA", scopes: ["tests/**"] });
  expect((await createAgent(sql, alphaId, ownerId, { handle: "codex-overlap", hostType: "codex", role: "API", scopes: ["apps/web/src/**"] })).overlapWarnings.length).toBeGreaterThan(0);
  const request = { to: ["codex-db", "claude-qa"], type: "blocker" as const, subject: "Schema changed", body: "Update the dependent views", clientMessageId: randomUUID() };
  const first = await sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, request);
  const replay = await sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, request);
  expect(replay.messageId).toBe(first.messageId);
  expect(first.senderUnreadCount).toBeGreaterThanOrEqual(0);
  const concurrentRequest = { ...request, clientMessageId: randomUUID() };
  const [raceA, raceB] = await Promise.all([
    sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, concurrentRequest),
    sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, concurrentRequest),
  ]);
  expect(raceA.messageId).toBe(raceB.messageId);
  const count = await sql`SELECT count(*)::int AS n FROM messages WHERE id = ${first.messageId}`;
  expect(count[0]?.n).toBe(1);
  const queued = await sql`SELECT delivered_at FROM message_recipients WHERE message_id = ${first.messageId}`;
  expect(queued.every((row) => row.delivered_at === null)).toBe(true);
  expect((await listAgentInbox(sql, { agentId: a.id, organizationId: alphaId })).items[0]?.subject).toBe("Schema changed");
  const delivered = await sql`SELECT agent_id, delivered_at FROM message_recipients WHERE message_id = ${first.messageId}`;
  expect(delivered.find((row) => row.agent_id === a.id)?.delivered_at).not.toBeNull();
  expect(delivered.find((row) => row.agent_id === b.id)?.delivered_at).toBeNull();
  expect((await listAgentInbox(sql, { agentId: a.id, organizationId: alphaId })).items[0]).not.toHaveProperty("body");
  const firstPage = await listAgentInbox(sql, { agentId: a.id, organizationId: alphaId }, { unreadOnly: false, limit: 1 });
  expect(firstPage.nextCursor).not.toBeNull();
  const secondPage = await listAgentInbox(sql, { agentId: a.id, organizationId: alphaId }, { unreadOnly: false, limit: 1, cursor: firstPage.nextCursor });
  expect(secondPage.items).toHaveLength(1);
  expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  await readAgentMessage(sql, { agentId: a.id, organizationId: alphaId }, first.messageId);
  const receipts = await sql`SELECT agent_id, read_at FROM message_recipients WHERE message_id = ${first.messageId}`;
  expect(receipts.find((row) => row.agent_id === a.id)?.read_at).not.toBeNull();
  expect(receipts.find((row) => row.agent_id === b.id)?.read_at).toBeNull();
  const privateReply = await sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, {
    to: "codex-db", type: "fyi", subject: "Only DB", body: "Private details", replyTo: first.messageId, clientMessageId: randomUUID(),
  });
  expect(privateReply.threadId).toBe(first.threadId);
  expect((await readAgentThread(sql, { agentId: a.id, organizationId: alphaId }, first.threadId)).messages.some((message) => message.id === privateReply.messageId)).toBe(true);
  expect((await readAgentThread(sql, { agentId: b.id, organizationId: alphaId }, first.threadId)).messages.some((message) => message.id === privateReply.messageId)).toBe(false);
  await expect(readAgentMessage(sql, { agentId: b.id, organizationId: alphaId }, privateReply.messageId)).rejects.toThrow("NOT_FOUND");
});

it("pages all messages created within the same second without gaps", async () => {
  const sender = await createAgent(sql, alphaId, ownerId, { handle: "cursor-sender", hostType: "codex", role: "Cursor", scopes: [] });
  const reader = await createAgent(sql, alphaId, ownerId, { handle: "cursor-reader", hostType: "claude-code", role: "Reader", scopes: [] });
  const sent = [];
  for (let index = 0; index < 3; index++) {
    sent.push(await sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, {
      to: reader.handle, type: "fyi", subject: `Cursor ${index}`, body: "Paging", clientMessageId: randomUUID(),
    }));
  }
  for (let index = 0; index < sent.length; index++) {
    await sql`UPDATE messages SET created_at = ${`2026-11-15T12:00:00.${(index + 1).toString().padStart(6, "0")}Z`}::timestamptz WHERE id = ${sent[index]!.messageId}`;
  }
  let cursor: string | null = null;
  const seen: string[] = [];
  do {
    const page = await listAgentInbox(sql, { agentId: reader.id, organizationId: alphaId }, { unreadOnly: false, limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual(sent.map((item) => item.messageId).reverse());
});

it("returns safe HTTP envelopes for foreign IDs and revoked tokens", async () => {
  const created = await createAgent(sql, betaId, ownerId, { handle: "http-beta", hostType: "codex", role: "HTTP", scopes: [] });
  await createAgent(sql, betaId, ownerId, { handle: "http-target", hostType: "claude-code", role: "Target", scopes: [] });
  const code = await createPairingCode(sql, betaId, created.id, ownerId);
  const { token } = await exchangePairingCode(sql, code);
  const sendRoute = await import("../app/api/agents/messages/route");
  const sent = await sendRoute.POST(new Request("http://127.0.0.1:4300/api/agents/messages", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "http-target", type: "fyi", subject: "HTTP message", body: "private body", clientMessageId: randomUUID() }),
  }));
  expect(sent.status).toBe(200);
  expect(JSON.stringify(await sent.json())).not.toContain("private body");
  const foreign = await sql`SELECT id FROM messages WHERE organization_id = ${alphaId} LIMIT 1`;
  const messageId = String(foreign[0]?.id);
  const route = await import("../app/api/agents/messages/[messageId]/route");
  const request = new Request(`http://127.0.0.1:4300/api/agents/messages/${messageId}`, { headers: { authorization: `Bearer ${token}` } });
  const denied = await route.GET(request, { params: Promise.resolve({ messageId }) });
  expect(denied.status).toBe(404);
  expect((await denied.json()).data).toBeNull();
  const principal = await authenticateAgentToken(sql, token);
  await revokeAgentToken(sql, principal);
  const revoked = await route.GET(request, { params: Promise.resolve({ messageId }) });
  expect(revoked.status).toBe(401);
  const secondCode = await createPairingCode(sql, betaId, created.id, ownerId);
  const secondToken = (await exchangePairingCode(sql, secondCode)).token;
  await revokeAgent(sql, betaId, ownerId, created.id);
  await expect(authenticateAgentToken(sql, secondToken)).rejects.toThrow("UNAUTHENTICATED");
});

it("rejects cross-workspace IDs and routes to the most specific active scope owner", async () => {
  const sender = await createAgent(sql, betaId, ownerId, { handle: "beta-sender", hostType: "codex", role: "Beta", scopes: [] });
  const broad = await createAgent(sql, betaId, ownerId, { handle: "beta-web", hostType: "claude-code", role: "Web", scopes: ["apps/web/**"] });
  const specific = await createAgent(sql, betaId, ownerId, { handle: "beta-page", hostType: "codex", role: "Page", scopes: ["apps/web/src/**"] });
  const alphaMessage = await sql`SELECT id, thread_id FROM messages WHERE organization_id = ${alphaId} LIMIT 1`;
  expect(alphaMessage).toHaveLength(1);
  const foreignMessage = alphaMessage[0];
  if (!foreignMessage) throw new Error("Expected an alpha message");
  await expect(readAgentMessage(sql, { agentId: sender.id, organizationId: betaId }, String(foreignMessage.id))).rejects.toThrow("NOT_FOUND");
  await expect(sendAgentMessage(sql, { agentId: sender.id, organizationId: betaId }, {
    to: "beta-web", type: "fyi", subject: "Cross", body: "No", threadId: String(foreignMessage.thread_id), clientMessageId: randomUUID(),
  })).rejects.toThrow("NOT_FOUND");
  const owned = await sendAgentMessage(sql, { agentId: sender.id, organizationId: betaId }, {
    to: "owner:apps/web/src/page.tsx", type: "question", subject: "Page owner", body: "Who owns this?", clientMessageId: randomUUID(),
  });
  expect(owned.recipientHandles).toEqual(["beta-page"]);
  const routed = await sendAgentMessage(sql, { agentId: sender.id, organizationId: betaId }, {
    to: "*", type: "fyi", subject: "Everyone", body: "Hello", clientMessageId: randomUUID(),
  });
  const activeRecipients = await sql`SELECT handle FROM agents WHERE organization_id = ${betaId} AND id <> ${sender.id} AND revoked_at IS NULL ORDER BY handle`;
  expect(routed.recipientHandles).toEqual(activeRecipients.map((row) => row.handle));
  await readAgentMessage(sql, { agentId: broad.id, organizationId: betaId }, routed.messageId);
  const broadcastReceipts = await sql`SELECT agent_id, read_at FROM message_recipients WHERE message_id = ${routed.messageId}`;
  expect(broadcastReceipts.find((row) => row.agent_id === broad.id)?.read_at).not.toBeNull();
  expect(broadcastReceipts.find((row) => row.agent_id === specific.id)?.read_at).toBeNull();
  const late = await createAgent(sql, betaId, ownerId, { handle: "beta-late", hostType: "codex", role: "Late", scopes: [] });
  const followup = await sendAgentMessage(sql, { agentId: sender.id, organizationId: betaId }, {
    to: "*", type: "fyi", subject: "Original members", body: "Only participants", threadId: routed.threadId, clientMessageId: randomUUID(),
  });
  expect(followup.recipientHandles).not.toContain(late.handle);
  await expect(readAgentMessage(sql, { agentId: late.id, organizationId: betaId }, followup.messageId)).rejects.toThrow("NOT_FOUND");
  const tie = await createAgent(sql, betaId, ownerId, { handle: "beta-page-peer", hostType: "codex", role: "Page peer", scopes: ["apps/web/src/**"] });
  await expect(sendAgentMessage(sql, { agentId: sender.id, organizationId: betaId }, {
    to: "owner:apps/web/src/page.tsx", type: "fyi", subject: "Ambiguous", body: "No route", clientMessageId: randomUUID(),
  })).rejects.toThrow("INVALID_ROUTE");
  expect(tie.overlapWarnings).toContain("beta-page");
  expect(broad.id).not.toBe(specific.id);
});

it("keeps decisions and coordination state visible in a compact thread", async () => {
  const author = await createAgent(sql, alphaId, ownerId, { handle: "decision-author", hostType: "codex", role: "Lead", scopes: [] });
  const reader = await createAgent(sql, alphaId, ownerId, { handle: "decision-reader", hostType: "claude-code", role: "Builder", scopes: [] });
  const sent = await sendAgentMessage(sql, { agentId: author.id, organizationId: alphaId }, {
    to: "decision-reader", type: "decision", subject: "Use SQL migrations", body: "Use reviewed SQL migrations for deployment.", clientMessageId: randomUUID(),
  });
  const decision = await sql`SELECT status, source_message_id FROM decision_records WHERE source_message_id = ${sent.messageId}`;
  expect(decision[0]?.status).toBe("confirmed");
  const question = await sendAgentMessage(sql, { agentId: author.id, organizationId: alphaId }, {
    to: "decision-reader", type: "question", subject: "Migration owner", body: "Who owns the next migration?", threadId: sent.threadId, clientMessageId: randomUUID(),
  });
  const briefing = await getAgentBriefing(sql, { agentId: reader.id, organizationId: alphaId });
  expect(briefing.decisions.some((item) => item.title === "Use SQL migrations")).toBe(true);
  expect(briefing.openItems.some((item) => item.id === question.messageId)).toBe(true);
  const thread = await readAgentThread(sql, { agentId: reader.id, organizationId: alphaId }, sent.threadId);
  expect(thread.messages.map((message) => message.id)).toEqual([sent.messageId, question.messageId]);
  expect(thread.messages[0]?.body).toContain("reviewed SQL");
  await expect(resolveCoordinationItem(sql, { agentId: reader.id, organizationId: alphaId }, question.messageId, "resolved")).rejects.toThrow("FORBIDDEN");
  await resolveCoordinationItem(sql, { agentId: author.id, organizationId: alphaId }, question.messageId, "resolved");
  const state = await sql`SELECT response_state FROM messages WHERE id = ${question.messageId}`;
  expect(state[0]?.response_state).toBe("resolved");
  await heartbeatAgent(sql, { agentId: reader.id, organizationId: alphaId });
  const directory = await listAgents(sql, { agentId: author.id, organizationId: alphaId });
  expect(directory.find((agent) => agent.id === reader.id)?.presence).toBe("online");
  for (let index = 0; index < 5; index++) {
    await sendAgentMessage(sql, { agentId: author.id, organizationId: alphaId }, {
      to: "decision-reader", type: "fyi", subject: `Follow-up ${index}`, body: "Compact history", threadId: sent.threadId, clientMessageId: randomUUID(),
    });
  }
  expect((await readAgentThread(sql, { agentId: reader.id, organizationId: alphaId }, sent.threadId)).messages).toHaveLength(4);
});
