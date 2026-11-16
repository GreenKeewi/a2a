import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { createAgent, createPairingCode, exchangePairingCode, sendAgentMessage } from "../src/lib/agents";

const maintenanceUrl = process.env.TEST_DATABASE_URL;
const tckDir = process.env.A2A_TCK_DIR;
if (!maintenanceUrl || !["localhost", "127.0.0.1"].includes(new URL(maintenanceUrl).hostname) || !tckDir) {
  throw new Error("Set local TEST_DATABASE_URL and A2A_TCK_DIR");
}
const python = process.env.A2A_TCK_PYTHON ?? (process.platform === "win32" ?
  join(tckDir, ".venv", "Scripts", "python.exe") : join(tckDir, ".venv", "bin", "python"));
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrations = resolve(appRoot, "..", "..", "supabase", "migrations");
const databaseName = `a2a_tck_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(maintenanceUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = postgres(maintenanceUrl, { prepare: false });
const sql = postgres(databaseUrl.toString(), { prepare: false });
const ownerId = randomUUID();
const organizationId = randomUUID();
let web: ReturnType<typeof spawn> | undefined;
let server: ReturnType<typeof createServer> | undefined;
let timer: NodeJS.Timeout | undefined;
let pollActive = false;
let webLog = "";

function delay(ms: number) { return new Promise((done) => setTimeout(done, ms)); }
async function availablePort() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise<void>((done) => probe.close(() => done()));
  return address.port;
}

async function main() {
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
  for (const name of (await readdir(migrations)).filter((item) => item.endsWith(".sql")).sort()) {
    await sql.unsafe(await readFile(join(migrations, name), "utf8"));
  }
  await sql`INSERT INTO "user" (id, name, email) VALUES (${ownerId}, 'TCK Owner', 'tck-owner@example.test')`;
  await sql`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'A2A TCK', ${`tck-${organizationId.slice(0, 8)}`}, now())`;
  await sql`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${organizationId}, ${ownerId}, 'owner', now())`;
  const client = await createAgent(sql, organizationId, ownerId,
    { handle: "tck-client", hostType: "codex", role: "TCK client", scopes: [] });
  const target = await createAgent(sql, organizationId, ownerId,
    { handle: "tck-target", hostType: "claude-code", role: "TCK target", scopes: [] });
  const token = (await exchangePairingCode(sql, await createPairingCode(sql, organizationId, client.id, ownerId))).token;
  const appPort = await availablePort();
  const proxyPort = await availablePort();
  const appBase = `http://127.0.0.1:${appPort}`;
  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  const webEnv = { ...process.env, DATABASE_URL: databaseUrl.toString(), BETTER_AUTH_URL: appBase,
    BETTER_AUTH_SECRET: "local-testing-secret-with-32-plus-characters", GOOGLE_CLIENT_ID: "local-placeholder",
    GOOGLE_CLIENT_SECRET: "local-placeholder" };
  web = spawn(process.execPath, [resolve(appRoot, "node_modules", "next", "dist", "bin", "next"),
    "dev", "--hostname", "127.0.0.1", "--port", String(appPort)],
    { cwd: appRoot, env: webEnv, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [web.stdout, web.stderr]) stream?.on("data", (chunk) => {
    webLog = (webLog + String(chunk)).slice(-8_000);
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (web.exitCode !== null) throw new Error("Next server exited before the TCK started");
    try {
      const response = await fetch(`${appBase}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local test server. */ }
    await delay(500);
  }
  if (!ready) throw new Error("Next server did not become ready");
  const cardWarmup = await fetch(`${appBase}/api/a2a/agents/${target.handle}/card`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!cardWarmup.ok) throw new Error(`Agent Card warmup failed (${cardWarmup.status})`);
  const rpcWarmup = await fetch(`${appBase}/api/a2a/agents/${target.handle}/rpc`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "a2a-version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "warmup", method: "GetTask", params: { id: randomUUID() } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!rpcWarmup.ok) throw new Error(`A2A RPC warmup failed (${rpcWarmup.status})`);
  server = createServer(async (request, response) => {
    try {
      const path = request.url ?? "/";
      if (path === "/.well-known/agent-card.json") {
        const cardResponse = await fetch(`${appBase}/api/a2a/agents/${target.handle}/card`,
          { headers: { authorization: `Bearer ${token}` } });
        const card = await cardResponse.json() as { supportedInterfaces: { url: string }[] };
        card.supportedInterfaces[0]!.url = `${proxyBase}/api/a2a/agents/${target.handle}/rpc`;
        response.writeHead(cardResponse.status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(card));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const forwarded = await fetch(new URL(path, appBase), {
        method: request.method, headers: { authorization: `Bearer ${token}`,
          "content-type": String(request.headers["content-type"] ?? "application/json"),
          "a2a-version": String(request.headers["a2a-version"] ?? "1.0") },
        ...(request.method === "GET" ? {} : { body: Buffer.concat(chunks).toString("utf8") }),
      });
      response.writeHead(forwarded.status, { "content-type": forwarded.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store" });
      response.end(await forwarded.text());
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      const detail = error instanceof Error ? `${error.message} ${cause}`.replaceAll(token, "[redacted]") : "unknown";
      process.stderr.write(`TCK proxy failed: ${detail}\n`);
      process.stderr.write(`Recent web output: ${webLog.slice(-2_000).replaceAll(token, "[redacted]")}\n`);
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"TEST_PROXY_FAILED"}');
    }
  });
  await new Promise<void>((done) => server!.listen(proxyPort, "127.0.0.1", done));
  timer = setInterval(() => {
    if (pollActive) return;
    pollActive = true;
    void (async () => {
      const pending = await sql`SELECT m.id, m.thread_id FROM messages m JOIN message_recipients r ON r.message_id = m.id
        WHERE r.agent_id = ${target.id} AND m.sender_agent_id = ${client.id}
          AND NOT EXISTS (SELECT 1 FROM messages reply WHERE reply.reply_to_message_id = m.id
            AND reply.sender_agent_id = ${target.id})
        ORDER BY m.created_at ASC LIMIT 10`;
      for (const message of pending) await sendAgentMessage(sql, { agentId: target.id, organizationId }, {
        to: client.handle, type: "fyi", subject: "TCK fixture response", body: "Generated text content",
        threadId: String(message.thread_id), replyTo: String(message.id), clientMessageId: randomUUID(),
      });
    })().catch(() => {}).finally(() => { pollActive = false; });
  }, 300);
  const focus = process.env.A2A_TCK_FILTER;
  const suite = spawn(python, [join(tckDir, "run_tck.py"), "--sut-host", proxyBase,
    "--transport", "jsonrpc", "--level", "must", "-v", ...(focus ? ["--", "-k", focus] : [])],
    { cwd: tckDir, stdio: "inherit" });
  const exitCode = await new Promise<number>((done, reject) => {
    suite.on("error", reject);
    suite.on("exit", (code) => done(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`Official A2A TCK exited ${exitCode}`);
}

try { await main(); }
finally {
  if (timer) clearInterval(timer);
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  if (web?.pid && process.platform === "win32") {
    await new Promise<void>((done) => spawn("taskkill", ["/PID", String(web!.pid), "/T", "/F"],
      { stdio: "ignore" }).on("exit", () => done()));
  } else web?.kill();
  await delay(300);
  await sql.end({ timeout: 5 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
