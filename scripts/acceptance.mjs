import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [mode, argument] = process.argv.slice(2);
const origin = process.env.A2A_ACCEPTANCE_URL;
const token = process.env.A2A_ACCEPTANCE_TOKEN;
if (!origin || !token) throw new Error("Set A2A_ACCEPTANCE_URL and A2A_ACCEPTANCE_TOKEN in this process environment.");
const base = new URL(origin);
if (base.username || base.password || (base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))) {
  throw new Error("Acceptance URL must be HTTPS or local loopback HTTP.");
}
if (base.pathname !== "/" || base.search || base.hash) throw new Error("Acceptance URL must be an origin.");

async function api(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options, signal: AbortSignal.timeout(15_000), headers: {
      authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`API ${path}: ${result.error?.code ?? response.status}`);
  return result.data;
}

function ensureUuid(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Expected a message UUID.");
  }
  return value;
}

if (mode === "start") {
  if (!argument) throw new Error("Usage: node scripts/acceptance.mjs start <state.json>");
  const peer = process.env.A2A_ACCEPTANCE_PEER;
  if (!peer || !/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(peer)) throw new Error("Set A2A_ACCEPTANCE_PEER to the other agent's handle.");
  const briefing = await api("/api/agents/briefing");
  const runId = randomUUID();
  const payload = { to: peer, type: "question", subject: `Acceptance ${runId.slice(0, 8)}`,
    body: `Cross-machine acceptance request ${runId}. Reply to this message with replyTo and threadId.`,
    clientMessageId: randomUUID() };
  const sent = await api("/api/agents/messages", { method: "POST", body: JSON.stringify(payload) });
  const state = { origin: base.origin, sender: briefing.self.handle, peer, runId, payload,
    messageId: sent.messageId, threadId: sent.threadId };
  await writeFile(argument, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ stage: "sent", stateFile: argument, messageId: sent.messageId,
    threadId: sent.threadId, sender: state.sender, peer }, null, 2));
} else if (mode === "reply") {
  const messageId = ensureUuid(argument);
  const notices = await api("/api/agents/notifications");
  const inbox = await api("/api/agents/inbox?unreadOnly=true&limit=25");
  const noticed = notices.some((item) => item.id === messageId);
  const inInbox = inbox.items.some((item) => item.id === messageId);
  if (!noticed && !inInbox) throw new Error("Message was not present in catch-up notices or unread inbox.");
  const received = await api(`/api/agents/messages/${messageId}`);
  if (!received.senderHandle || received.senderHandle === "human") throw new Error("Expected an agent sender.");
  const runId = /Cross-machine acceptance request ([0-9a-f-]{36})\./.exec(received.body)?.[1];
  if (!runId) throw new Error("Message is not an acceptance request.");
  const sent = await api("/api/agents/messages", { method: "POST", body: JSON.stringify({
    to: received.senderHandle, type: "fyi", subject: `Acceptance reply ${runId.slice(0, 8)}`,
    body: `Cross-machine acceptance reply ${runId}.`, threadId: received.threadId,
    replyTo: messageId, clientMessageId: randomUUID(),
  }) });
  console.log(JSON.stringify({ stage: "replied", messageId, replyId: sent.messageId,
    threadId: sent.threadId, catchUp: noticed ? "notice" : "inbox", read: true }, null, 2));
} else if (mode === "verify") {
  if (!argument) throw new Error("Usage: node scripts/acceptance.mjs verify <state.json>");
  const state = JSON.parse(await readFile(argument, "utf8"));
  if (state.origin !== base.origin) throw new Error("State file belongs to a different origin.");
  ensureUuid(state.messageId);
  ensureUuid(state.threadId);
  const replay = await api("/api/agents/messages", { method: "POST", body: JSON.stringify(state.payload) });
  if (replay.messageId !== state.messageId || replay.threadId !== state.threadId) {
    throw new Error("Idempotent retry created a different message or thread.");
  }
  const thread = await api(`/api/agents/threads/${state.threadId}`);
  const reply = thread.messages.find((item) => item.senderHandle === state.peer &&
    item.body === `Cross-machine acceptance reply ${state.runId}.`);
  if (!reply) throw new Error("Reply has not reached the sender's thread yet.");
  console.log(JSON.stringify({ stage: "verified", messageId: state.messageId, replyId: reply.id,
    retryIdempotent: true, replyReceived: true }, null, 2));
} else if (mode === "revoked") {
  const response = await fetch(new URL("/api/agents/briefing", base), {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 401) throw new Error(`Revoked token still returned HTTP ${response.status}.`);
  console.log(JSON.stringify({ stage: "revoked", apiDenied: true }));
} else {
  throw new Error("Usage: node scripts/acceptance.mjs start <state.json> | reply <messageId> | verify <state.json> | revoked");
}
