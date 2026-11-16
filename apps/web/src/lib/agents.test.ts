import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { decodeJwt, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  acknowledgeAgentNotices, authenticateAgentToken, createAgent, createPairingCode, exchangePairingCode,
  getAgentBriefing, heartbeatAgent, listAgentInbox, listAgentTokensForHuman, listAgents, readAgentMessage, readAgentThread,
  pendingAgentNotices, resolveCoordinationItem, revokeAgent, revokeAgentToken, revokeAgentTokenForHuman, sendAgentMessage, updateAgentScopes,
} from "./agents";
import { mintRealtimeToken } from "./realtime";
import { getDashboardStats, getHumanInbox, getHumanThread, getWorkspaceContext, sendHumanMessage } from "./human-dashboard";
import { redactCredentials, runSmartJobs } from "./smart-worker";

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
  const keys = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(keys.privateKey);
  process.env.SUPABASE_JWT_PRIVATE_JWK = JSON.stringify({ ...privateJwk, kid: "a2a-local-test" });
  process.env.SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_local_test";
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$`);
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await sql.unsafe(`CREATE SCHEMA realtime;
    CREATE TABLE realtime.messages (id bigserial PRIMARY KEY);
    ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic', true) $$;
    GRANT USAGE ON SCHEMA realtime TO authenticated;
    GRANT SELECT ON realtime.messages TO authenticated;`);
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

it("shows a human-agent exchange and buckets messages on workspace-local days", async () => {
  const workspaceId = randomUUID();
  const slug = `dashboard-${workspaceId.slice(0, 8)}`;
  await sql`INSERT INTO organization (id, name, slug, created_at) VALUES (${workspaceId}, 'Dashboard', ${slug}, now())`;
  await sql`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${randomUUID()}, ${workspaceId}, ${ownerId}, 'owner', now())`;
  await sql`UPDATE workspace_settings SET timezone = 'America/Toronto' WHERE organization_id = ${workspaceId}`;
  const created = await createAgent(sql, workspaceId, ownerId, { handle: "dashboard-agent", hostType: "codex", role: "API", scopes: [] });
  await sql`UPDATE agents SET last_seen_at = now() WHERE id = ${created.id}`;
  const human = await sendHumanMessage(sql, workspaceId, ownerId, { to: "dashboard-agent", type: "question", subject: "Schema handoff", body: "Please review the schema." });
  const principal = { agentId: created.id, organizationId: workspaceId };
  const agentInbox = await listAgentInbox(sql, principal);
  expect(agentInbox.items[0]?.senderHandle).toBe("human");
  expect((await readAgentThread(sql, principal, human.threadId)).messages[0]?.senderHandle).toBe("human");
  const agentReply = await sendAgentMessage(sql, { agentId: created.id, organizationId: workspaceId }, {
    to: agentInbox.items[0]!.senderHandle, type: "fyi", subject: "Schema reviewed", body: "The schema is ready.",
    threadId: human.threadId, replyTo: human.messageId, clientMessageId: randomUUID(),
  });
  expect(agentReply.recipientHandles).toEqual(["human"]);
  expect((await getHumanInbox(sql, workspaceId))[0]?.threadId).toBe(human.threadId);
  expect((await getHumanThread(sql, workspaceId, human.threadId)).messages.map((message) => message.senderType)).toEqual(["human", "agent"]);
  await sql`UPDATE messages SET created_at = ((date_trunc('day', now() AT TIME ZONE 'America/Toronto') - interval '30 minutes') AT TIME ZONE 'America/Toronto') WHERE id = ${human.messageId}`;
  await sql`UPDATE messages SET created_at = ((date_trunc('day', now() AT TIME ZONE 'America/Toronto') + interval '30 minutes') AT TIME ZONE 'America/Toronto') WHERE id = ${agentReply.messageId}`;
  const stats = await getDashboardStats(sql, workspaceId, "America/Toronto");
  expect(stats.cards.agentsOnline).toBe(1);
  expect(stats.cards.unreadDeliveries).toBe(0);
  expect(stats.cards.openItems).toBe(1);
  expect(stats.days.slice(-2).map((day) => day.count)).toEqual([1, 1]);
  expect(stats.activity[0]?.medianResponseSeconds).toBe(3600);
  const laterReply = await sendAgentMessage(sql, principal, {
    to: "human", type: "fyi", subject: "One more detail", body: "The schema is still ready.",
    threadId: human.threadId, replyTo: human.messageId, clientMessageId: randomUUID(),
  });
  await sql`UPDATE messages SET created_at = (SELECT created_at + interval '2 hours' FROM messages WHERE id = ${human.messageId}) WHERE id = ${laterReply.messageId}`;
  expect((await getDashboardStats(sql, workspaceId, "America/Toronto")).activity[0]?.medianResponseSeconds).toBe(3600);
  const scopes = await updateAgentScopes(sql, workspaceId, ownerId, created.id, ["apps/api/**"]);
  expect(scopes.scopes).toEqual(["apps/api/**"]);
  const overlapping = await createAgent(sql, workspaceId, ownerId, { handle: "dashboard-reviewer", hostType: "claude-code", role: "Reviewer", scopes: ["apps/api/routes/**"] });
  expect(overlapping.overlapWarnings).toEqual(["dashboard-agent"]);
  const updatedOverlap = await updateAgentScopes(sql, workspaceId, ownerId, overlapping.id, ["apps/api/**"]);
  expect(updatedOverlap.overlapWarnings).toEqual(["dashboard-agent"]);
  await expect(updateAgentScopes(sql, alphaId, ownerId, created.id, ["apps/web/**"])).rejects.toThrow("NOT_FOUND");
  const humanDecision = await sendHumanMessage(sql, workspaceId, ownerId, { to: "dashboard-agent", type: "decision", subject: "Use SQL", body: "Apply reviewed migrations." });
  const decisions = await sql`SELECT status FROM decision_records WHERE source_message_id = ${humanDecision.messageId}`;
  expect(decisions[0]?.status).toBe("confirmed");
}, 30_000);

it("reserves the human reply address as an agent handle", async () => {
  await expect(createAgent(sql, alphaId, ownerId, { handle: "human", hostType: "codex", role: "Conflict", scopes: [] }))
    .rejects.toThrow("INVALID_REQUEST");
});

it("runs optional smart work after sends with provenance and no delivery changes", async () => {
  const workspaceId = randomUUID();
  await sql`INSERT INTO organization (id, name, slug, created_at) VALUES (${workspaceId}, 'Smart', ${`smart-${workspaceId.slice(0, 8)}`}, now())`;
  await sql`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${randomUUID()}, ${workspaceId}, ${ownerId}, 'owner', now())`;
  const agent = await createAgent(sql, workspaceId, ownerId, { handle: "smart-agent", hostType: "codex", role: "Reviewer", scopes: ["apps/api/**"] });
  const other = await createAgent(sql, workspaceId, ownerId, { handle: "other-agent", hostType: "claude-code", role: "Observer", scopes: [] });
  const disabled = await sendHumanMessage(sql, workspaceId, ownerId, { to: agent.handle, type: "fyi", subject: "Disabled", body: "No smart work." });
  expect(await sql`SELECT id FROM smart_jobs WHERE message_id = ${disabled.messageId}`).toHaveLength(0);
  await sql`UPDATE workspace_settings SET smart_features_enabled = true, smart_enabled_at = now() WHERE organization_id = ${workspaceId}`;
  let threadId: string | undefined;
  let lastMessageId = "";
  const messageIds: string[] = [];
  for (let index = 0; index < 6; index++) {
    const sent = await sendHumanMessage(sql, workspaceId, ownerId, {
      to: index === 0 ? [agent.handle, other.handle] : agent.handle, type: "question", subject: `Review ${index + 1}`,
      body: index === 0 ? "Credential a2a_abcdefghijklmnop should be masked." : `Please review part ${index + 1}.`,
      ...(threadId ? { threadId } : {}),
    });
    threadId = sent.threadId;
    lastMessageId = sent.messageId;
    messageIds.push(sent.messageId);
  }
  const before = await sql`SELECT count(*)::int AS messages, (SELECT count(*)::int FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE m.organization_id = ${workspaceId}) AS recipients FROM messages WHERE organization_id = ${workspaceId}`;
  await sql`DELETE FROM smart_jobs WHERE message_id = ${messageIds[0]!}`;
  const prompts: string[] = [];
  const summaryFlags: boolean[] = [];
  const generated = await runSmartJobs(sql, { modelId: "test/model", limit: 10, model: async (input) => {
    prompts.push(JSON.stringify(input.messages));
    summaryFlags.push(input.allowSummary);
    return { summary: input.allowSummary ? "Six review notes need attention." : null,
      proposedDecision: input.allowSummary ? "Use the reviewed API plan." : null,
      prioritySuggestion: "high", likelyScopeOwners: ["smart-agent", "made-up-agent"],
      likelySecret: false, confidence: 0.8 };
  } });
  expect(generated).toMatchObject({ processed: 6, completed: 6, failed: 0 });
  expect(summaryFlags).toContain(true);
  expect(prompts.some((prompt) => prompt.includes("[redacted credential]"))).toBe(true);
  expect(prompts.every((prompt) => !prompt.includes("a2a_abcdefghijklmnop"))).toBe(true);
  expect(redactCredentials("sk-abcdefghijklmnop")).toBe("[redacted credential]");
  expect(redactCredentials("A2A-PAIR-ABCD-EFGH")).toBe("[redacted pairing code]");
  expect(redactCredentials("A2A-ABCDE-FGHJK-KLMNP")).toBe("[redacted invite code]");
  const outputs = await sql`SELECT kind, model, prompt_version, source_version, confidence, generated_at, value
    FROM smart_outputs WHERE organization_id = ${workspaceId}`;
  expect(outputs.filter((row) => row.kind === "summary")).toHaveLength(1);
  expect(outputs.find((row) => row.kind === "summary")?.source_version).toBe(lastMessageId);
  expect(outputs.filter((row) => row.kind !== "secret_warning").every((row) => row.model === "test/model" && row.prompt_version === "a2a-triage-v1" && row.generated_at && Number(row.confidence) === 0.8)).toBe(true);
  expect(outputs.find((row) => row.kind === "secret_warning")).toMatchObject({ model: "deterministic", prompt_version: "credential-pattern-v1" });
  for (const row of outputs.filter((item) => item.kind === "scope_owner")) expect(row.value).toEqual(["smart-agent"]);
  expect((await sql`SELECT rolling_summary FROM threads WHERE id = ${threadId!}`)[0]?.rolling_summary).toBeNull();
  const otherView = await readAgentThread(sql, { agentId: other.id, organizationId: workspaceId }, threadId!);
  expect(otherView.messages.map((message) => message.id)).toEqual([messageIds[0]]);
  expect(otherView.summary).toBeNull();
  expect((await getHumanThread(sql, workspaceId, threadId!)).suggestions.length).toBeGreaterThan(0);
  expect(outputs.find((row) => row.kind === "proposed_decision")?.value).toBe("Use the reviewed API plan.");
  const decision = await sql`SELECT status FROM decision_records WHERE source_message_id = ${lastMessageId}`;
  expect(decision).toHaveLength(0);
  await sql`UPDATE workspace_settings SET reminder_after_minutes = 5, escalate_after_minutes = 10 WHERE organization_id = ${workspaceId}`;
  await sql`UPDATE messages SET created_at = now() - interval '12 minutes' WHERE id = ${messageIds[0]!}`;
  await sql`UPDATE messages SET created_at = now() - interval '7 minutes' WHERE id = ${messageIds[1]!}`;
  const context = await getWorkspaceContext(sql, workspaceId);
  expect(context.openItems.find((item) => item.id === messageIds[0])?.reminder_level).toBe("escalated");
  expect(context.openItems.find((item) => item.id === messageIds[1])?.reminder_level).toBe("due");
  expect(context.openItems.find((item) => item.id === lastMessageId)?.reminder_level).toBe("pending");
  const after = await sql`SELECT count(*)::int AS messages, (SELECT count(*)::int FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE m.organization_id = ${workspaceId}) AS recipients FROM messages WHERE organization_id = ${workspaceId}`;
  expect(after[0]).toMatchObject(before[0]!);
  await sql`INSERT INTO messages (organization_id, thread_id, sender_user_id, type, priority, subject, body, requires_response, response_state, created_at)
    SELECT ${workspaceId}, ${threadId!}, ${ownerId}, 'question', 'normal', 'Newer question', 'Pending', true, 'open', now() - interval '1 minute'
    FROM generate_series(1, 51)`;
  const crowded = await getWorkspaceContext(sql, workspaceId);
  expect(crowded.openItems).toHaveLength(50);
  expect(crowded.openItems[0]?.id).toBe(messageIds[0]);
  expect(crowded.openItems.some((item) => item.id === messageIds[1])).toBe(true);
  const malformed = await sendHumanMessage(sql, workspaceId, ownerId, { to: agent.handle, type: "fyi", subject: "Malformed", body: "Keep delivery." });
  const timeout = await sendHumanMessage(sql, workspaceId, ownerId, { to: agent.handle, type: "fyi", subject: "Timeout", body: "Keep delivery too." });
  expect((await runSmartJobs(sql, { modelId: "test/model", limit: 1, model: async () => ({ invalid: true }) })).failed).toBe(1);
  expect((await runSmartJobs(sql, { modelId: "test/model", limit: 1, deadlineMs: 15, model: async () => new Promise(() => {}) })).failed).toBe(1);
  expect((await sql`SELECT body FROM messages WHERE id IN (${malformed.messageId}, ${timeout.messageId}) ORDER BY subject`).map((row) => row.body)).toEqual(["Keep delivery.", "Keep delivery too."]);
  await sql`UPDATE workspace_settings SET smart_features_enabled = false WHERE organization_id = ${workspaceId}`;
  expect((await getHumanThread(sql, workspaceId, threadId!)).suggestions).toHaveLength(0);
  const again = await sendHumanMessage(sql, workspaceId, ownerId, { to: agent.handle, type: "fyi", subject: "Disabled again", body: "No smart work." });
  expect(await sql`SELECT id FROM smart_jobs WHERE message_id = ${again.messageId}`).toHaveLength(0);
}, 60_000);

it("bridges authenticated A2A 1.0 messages to durable tasks and exact agent replies", async () => {
  const workspaceId = randomUUID();
  await sql`INSERT INTO organization (id, name, slug, created_at) VALUES (${workspaceId}, 'A2A bridge', ${`bridge-${workspaceId.slice(0, 8)}`}, now())`;
  await sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${workspaceId}, ${ownerId}, 'owner', now())`;
  const sender = await createAgent(sql, workspaceId, ownerId, { handle: "a2a-client", hostType: "codex", role: "Client", scopes: [] });
  const target = await createAgent(sql, workspaceId, ownerId, { handle: "a2a-target", hostType: "claude-code", role: "Target", scopes: [] });
  const token = (await exchangePairingCode(sql, await createPairingCode(sql, workspaceId, sender.id, ownerId))).token;
  const cardRoute = await import("../app/api/a2a/agents/[handle]/card/route");
  const rpcRoute = await import("../app/api/a2a/agents/[handle]/rpc/route");
  const gatewayRoute = await import("../app/api/a2a/rpc/route");
  const genericRoute = await import("../app/.well-known/agent-card.json/route");
  const card = await cardRoute.GET(new Request("http://127.0.0.1:4300/api/a2a/agents/a2a-target/card",
    { headers: { authorization: `Bearer ${token}` } }), { params: Promise.resolve({ handle: target.handle }) });
  expect(card.status).toBe(200);
  const cardBody = await card.json();
  expect(cardBody.supportedInterfaces[0]).toMatchObject({ protocolBinding: "JSONRPC", protocolVersion: "1.0" });
  expect(cardBody.capabilities).toMatchObject({ streaming: false, pushNotifications: false });
  expect(cardBody.securityRequirements[0].schemes.bearer).toBeDefined();
  expect((await genericRoute.GET()).status).toBe(200);
  expect((await cardRoute.GET(new Request("http://127.0.0.1:4300/api/a2a/agents/a2a-target/card"),
    { params: Promise.resolve({ handle: target.handle }) })).status).toBe(401);
  const endpoint = `http://127.0.0.1:4300/api/a2a/agents/${target.handle}/rpc`;
  async function rpc(method: string, params: unknown, bearer = token, version = "1.0") {
    const response = await rpcRoute.POST(new Request(endpoint, { method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "a2a-version": version },
      body: JSON.stringify({ jsonrpc: "2.0", id: "test-1", method, params }),
    }), { params: Promise.resolve({ handle: target.handle }) });
    return { status: response.status, body: await response.json() };
  }
  const request = { message: { messageId: "external-message-1", role: "ROLE_USER", parts: [{ text: "Review the schema." }],
    metadata: { subject: "Schema review", type: "question" } } };
  const first = await rpc("SendMessage", request);
  expect(first.status).toBe(200);
  expect(first.body.error).toBeUndefined();
  const task = first.body.result.task;
  expect(task.status.state).toBe("TASK_STATE_SUBMITTED");
  expect(task.contextId).toBeTruthy();
  const duplicate = await rpc("SendMessage", request);
  expect(duplicate.body.result.task.id).toBe(task.id);
  const source = await sql`SELECT id, thread_id, body FROM messages WHERE organization_id = ${workspaceId}
    AND sender_agent_id = ${sender.id} AND subject = 'Schema review'`;
  expect(source).toHaveLength(1);
  expect(source[0]?.body).toBe("Review the schema.");
  await readAgentMessage(sql, { agentId: target.id, organizationId: workspaceId }, String(source[0]!.id));
  expect((await rpc("GetTask", { id: task.id })).body.result.status.state).toBe("TASK_STATE_WORKING");
  const hidden = await rpc("GetTask", { id: randomUUID() });
  expect(hidden.body.error.code).toBe(-32001);
  const wrongVersion = await rpc("GetTask", { id: task.id }, token, "0.3");
  expect(wrongVersion.body.error.code).toBe(-32009);
  const foreignToken = (await exchangePairingCode(sql, await createPairingCode(sql, alphaId,
    (await createAgent(sql, alphaId, ownerId, { handle: `foreign-${randomUUID().slice(0, 8)}`, hostType: "codex", role: "Foreign", scopes: [] })).id, ownerId))).token;
  expect((await rpc("GetTask", { id: task.id }, foreignToken)).body.error.code).toBe(-32001);
  await sendAgentMessage(sql, { agentId: target.id, organizationId: workspaceId }, {
    to: sender.handle, type: "fyi", subject: "Schema reviewed", body: "The schema is ready.",
    threadId: String(source[0]!.thread_id), replyTo: String(source[0]!.id), clientMessageId: randomUUID(),
  });
  const completed = await rpc("GetTask", { id: task.id, historyLength: 0 });
  expect(completed.body.result.status.state).toBe("TASK_STATE_COMPLETED");
  expect(completed.body.result.history ?? []).toEqual([]);
  expect(completed.body.result.artifacts[0].parts[0].text).toBe("The schema is ready.");
  expect((await rpc("SendMessage", { message: { ...request.message, messageId: "external-followup",
    taskId: task.id, contextId: task.contextId } })).body.error.code).toBe(-32004);
  const pending = await rpc("SendMessage", { message: { ...request.message, messageId: "external-message-2",
    contextId: task.contextId, metadata: { subject: "Another review" } } });
  const pendingTask = pending.body.result.task;
  expect(pendingTask.contextId).toBe(task.contextId);
  const followup = await rpc("SendMessage", { message: { ...request.message,
    messageId: "external-message-3", taskId: pendingTask.id, metadata: { subject: "More detail" } } });
  expect(followup.body.result.task.id).toBe(pendingTask.id);
  const listed = await rpc("ListTasks", { contextId: task.contextId, pageSize: 1 });
  expect(listed.body.result.totalSize).toBe(2);
  expect(listed.body.result.tasks).toHaveLength(1);
  expect(listed.body.result.nextPageToken).toBeTruthy();
  const nextPage = await rpc("ListTasks", { contextId: task.contextId, pageSize: 1,
    pageToken: listed.body.result.nextPageToken });
  expect(nextPage.body.result.tasks).toHaveLength(1);
  expect(nextPage.body.result.nextPageToken).toBe("");
  const canceled = await rpc("CancelTask", { id: pending.body.result.task.id });
  expect(canceled.body.result.status.state).toBe("TASK_STATE_CANCELED");
  const canceledMessages = await sql`SELECT m.response_state FROM a2a_task_messages tm JOIN messages m ON m.id = tm.message_id
    WHERE tm.task_id = ${pendingTask.id}`;
  expect(canceledMessages.map((row) => row.response_state)).toEqual(["cancelled", "cancelled"]);
  const longBody = "Please inspect the migration and verify the workspace isolation rules in detail. ".repeat(2);
  const genericPayload = JSON.stringify({ jsonrpc: "2.0", id: "generic", method: "SendMessage", params: {
      message: { messageId: "long-plain-text", role: "ROLE_USER", parts: [{ text: longBody }],
        metadata: { to: target.handle } }, configuration: { returnImmediately: true },
    } });
  const genericRequest = () => new Request("http://127.0.0.1:4300/api/a2a/rpc", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "a2a-version": "1.0" },
    body: genericPayload,
  });
  const genericResponse = await gatewayRoute.POST(genericRequest());
  const genericTask = (await genericResponse.json()).result.task;
  expect(genericTask.status.state).toBe("TASK_STATE_SUBMITTED");
  const longSubject = await sql`SELECT id, thread_id, subject FROM messages WHERE organization_id = ${workspaceId} AND body = ${longBody.trim()}`;
  expect(String(longSubject[0]?.subject).length).toBeLessThanOrEqual(80);
  expect(longSubject[0]?.subject).toBe(`${longBody.slice(0, 79).trimEnd()}…`);
  const collision = await rpc("SendMessage", { message: { ...request.message,
    messageId: "long-plain-text", taskId: pendingTask.id, metadata: { subject: "Other", to: target.handle } } });
  expect(collision.body.error.code).toBe(-32602);
  await sendAgentMessage(sql, { agentId: target.id, organizationId: workspaceId }, {
    to: sender.handle, type: "fyi", subject: "Long request answered", body: "Completed once.",
    threadId: String(longSubject[0]!.thread_id), replyTo: String(longSubject[0]!.id), clientMessageId: randomUUID(),
  });
  const replayed = await gatewayRoute.POST(genericRequest());
  expect((await replayed.json()).result.task).toMatchObject({ id: genericTask.id,
    status: { state: "TASK_STATE_COMPLETED" } });
  const denied = await rpc("GetTask", { id: task.id }, "invalid-token");
  expect(denied.status).toBe(401);
}, 90_000);

it("exchanges a pairing code once and revokes its token immediately", async () => {
  const created = await createAgent(sql, alphaId, ownerId, { handle: "codex-api", hostType: "codex", role: "API", scopes: ["apps/api/**"] });
  const code = await createPairingCode(sql, alphaId, created.id, ownerId);
  await expect(createPairingCode(sql, betaId, created.id, ownerId)).rejects.toThrow("FORBIDDEN");
  const replacementCode = await createPairingCode(sql, alphaId, created.id, ownerId);
  await expect(exchangePairingCode(sql, code)).rejects.toThrow("INVALID_PAIRING_CODE");
  await expect(exchangePairingCode(sql, replacementCode, "claude-code")).rejects.toThrow("INVALID_PAIRING_CODE");
  const paired = await exchangePairingCode(sql, replacementCode, "codex");
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

it("mints short-lived Realtime JWTs and isolates private topics", async () => {
  const first = await createAgent(sql, alphaId, ownerId, { handle: "rt-first", hostType: "codex", role: "Realtime", scopes: [] });
  const second = await createAgent(sql, alphaId, ownerId, { handle: "rt-second", hostType: "claude-code", role: "Realtime", scopes: [] });
  const { token } = await exchangePairingCode(sql, await createPairingCode(sql, alphaId, first.id, ownerId));
  const principal = await authenticateAgentToken(sql, token);
  const signed = await mintRealtimeToken(sql, { kind: "agent", agent: principal });
  const claims = decodeJwt(signed.token);
  const publicJwk = JSON.parse(process.env.SUPABASE_JWT_PRIVATE_JWK!) as Record<string, unknown>;
  delete publicJwk.d;
  const { importJWK } = await import("jose");
  await jwtVerify(signed.token, await importJWK(publicJwk, "ES256"), { audience: "authenticated" });
  expect(signed.expiresIn).toBe(900);
  expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    const allowed = await tx`SELECT a2a_private.a2a_can_receive_realtime(${`agent:${first.id}`}) AS allowed`;
    const peer = await tx`SELECT a2a_private.a2a_can_receive_realtime(${`agent:${second.id}`}) AS allowed`;
    const foreign = await tx`SELECT a2a_private.a2a_can_receive_realtime(${`workspace:${betaId}`}) AS allowed`;
    expect(allowed[0]?.allowed).toBe(true);
    expect(peer[0]?.allowed).toBe(false);
    expect(foreign[0]?.allowed).toBe(false);
  });
  await sql`INSERT INTO realtime.messages DEFAULT VALUES`;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx`SELECT set_config('realtime.topic', ${`agent:${first.id}`}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    expect((await tx`SELECT count(*)::int AS n FROM realtime.messages`)[0]?.n).toBe(1);
    await tx`SELECT set_config('realtime.topic', ${`agent:${second.id}`}, true)`;
    expect((await tx`SELECT count(*)::int AS n FROM realtime.messages`)[0]?.n).toBe(0);
  });
  const human = await mintRealtimeToken(sql, { kind: "user", userId: ownerId, organizationId: alphaId });
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(decodeJwt(human.token))}, true)`;
    expect((await tx`SELECT a2a_private.a2a_can_receive_realtime(${`workspace:${alphaId}`}) AS allowed`)[0]?.allowed).toBe(true);
    expect((await tx`SELECT a2a_private.a2a_can_receive_realtime(${`agent:${first.id}`}) AS allowed`)[0]?.allowed).toBe(false);
  });
  await revokeAgentTokenForHuman(sql, alphaId, ownerId, first.id, principal.tokenId!);
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    expect((await tx`SELECT a2a_private.a2a_can_receive_realtime(${`agent:${first.id}`}) AS allowed`)[0]?.allowed).toBe(false);
  });
  await expect(mintRealtimeToken(sql, { kind: "agent", agent: principal })).rejects.toThrow("UNAUTHENTICATED");
  const privileges = await sql`SELECT
    has_function_privilege('anon', 'a2a_private.a2a_emit_realtime(text,text,uuid,uuid,uuid,uuid)', 'EXECUTE') AS anon_emit,
    has_function_privilege('authenticated', 'a2a_private.a2a_emit_realtime(text,text,uuid,uuid,uuid,uuid)', 'EXECUTE') AS agent_emit,
    has_function_privilege('anon', 'a2a_private.a2a_can_receive_realtime(text)', 'EXECUTE') AS anon_check,
    has_schema_privilege('anon', 'a2a_private', 'USAGE') AS anon_schema`;
  expect(privileges[0]?.anon_emit).toBe(false);
  expect(privileges[0]?.agent_emit).toBe(false);
  expect(privileges[0]?.anon_check).toBe(false);
  expect(privileges[0]?.anon_schema).toBe(false);
  expect((await sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'realtime' AND tablename = 'messages' AND policyname = 'a2a_receive_private_topics'`)[0]?.n).toBe(1);
});

it("broadcasts identifiers only and keeps messages durable if Realtime fails", async () => {
  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS realtime");
  await sql.unsafe("CREATE TABLE IF NOT EXISTS public.a2a_test_broadcasts (payload jsonb NOT NULL, event text NOT NULL, topic text NOT NULL, private boolean NOT NULL)");
  await sql.unsafe(`CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) RETURNS void
    LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.a2a_test_broadcasts VALUES (payload, event, topic, private); END $$`);
  const sender = await createAgent(sql, alphaId, ownerId, { handle: "broadcast-sender", hostType: "codex", role: "Sender", scopes: [] });
  const reader = await createAgent(sql, alphaId, ownerId, { handle: "broadcast-reader", hostType: "claude-code", role: "Reader", scopes: [] });
  const sent = await sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, {
    to: reader.handle, type: "fyi", subject: "Secret subject", body: "Sensitive body never in events", clientMessageId: randomUUID(),
  });
  const events = await sql`SELECT payload, event, topic, private FROM public.a2a_test_broadcasts WHERE payload->>'messageId' = ${sent.messageId}`;
  expect(events).toHaveLength(2);
  expect(events.every((event) => event.private === true)).toBe(true);
  expect(events.some((event) => event.topic === `agent:${reader.id}`)).toBe(true);
  expect(JSON.stringify(events)).not.toContain("Sensitive body");
  expect(JSON.stringify(events)).not.toContain("Secret subject");
  await sql.unsafe(`CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) RETURNS void
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'partition unavailable'; END $$`);
  const durable = await sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, {
    to: reader.handle, type: "fyi", subject: "Offline send", body: "Still durable", clientMessageId: randomUUID(),
  });
  expect((await sql`SELECT body FROM messages WHERE id = ${durable.messageId}`)[0]?.body).toBe("Still durable");
  await sql.unsafe("DROP FUNCTION realtime.send(jsonb,text,text,boolean)");
  await sql.unsafe("DROP TABLE public.a2a_test_broadcasts");
});

it("finds a notice whose transaction commits after a newer message", async () => {
  const sender = await createAgent(sql, alphaId, ownerId, { handle: "commit-sender", hostType: "codex", role: "Sender", scopes: [] });
  const reader = await createAgent(sql, alphaId, ownerId, { handle: "commit-reader", hostType: "claude-code", role: "Reader", scopes: [] });
  const threadId = randomUUID();
  const delayedId = randomUUID();
  await sql`INSERT INTO threads (id, organization_id, kind) VALUES (${threadId}, ${alphaId}, 'direct')`;
  let notifyInserted!: () => void;
  let releaseDelayed!: () => void;
  const inserted = new Promise<void>((resolve) => { notifyInserted = resolve; });
  const release = new Promise<void>((resolve) => { releaseDelayed = resolve; });
  const delayed = sql.begin(async (tx) => {
    await tx`INSERT INTO messages (id, organization_id, thread_id, sender_agent_id, client_message_id, type, priority, subject, body)
      VALUES (${delayedId}, ${alphaId}, ${threadId}, ${sender.id}, ${randomUUID()}, 'blocker', 'high', 'Delayed commit', 'Must still notify')`;
    await tx`INSERT INTO message_recipients (message_id, agent_id) VALUES (${delayedId}, ${reader.id})`;
    notifyInserted();
    await release;
  });
  await inserted;
  const newer = await sendAgentMessage(sql, { agentId: sender.id, organizationId: alphaId }, {
    to: reader.handle, type: "fyi", subject: "Newer commit", body: "Committed first", clientMessageId: randomUUID(),
  });
  expect((await pendingAgentNotices(sql, { agentId: reader.id, organizationId: alphaId })).map((item) => item.id)).toContain(newer.messageId);
  await acknowledgeAgentNotices(sql, { agentId: reader.id, organizationId: alphaId }, [newer.messageId]);
  releaseDelayed();
  await delayed;
  const pending = await pendingAgentNotices(sql, { agentId: reader.id, organizationId: alphaId });
  expect(pending.map((item) => item.id)).toEqual([delayedId]);
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
  expect((await readAgentMessage(sql, { agentId: a.id, organizationId: alphaId }, first.messageId)).senderHandle).toBe(sender.handle);
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
