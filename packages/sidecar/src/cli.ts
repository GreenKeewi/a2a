#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import { AgentApi, ApiError, pairAgent } from "./api.js";
import { findConfig, findHostIdentity, OsCredentialStore, saveConfig, saveHostIdentity, userCachePath,
  type AgentConnection, type HostIdentity, type SidecarConfig } from "./config.js";
import { RealtimeSession } from "./realtime.js";
import { SyncEngine } from "./sync.js";

async function readPairingCode(): Promise<string> {
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk.toString();
    return input.trim().split(/\s+/)[0] ?? "";
  }
  process.stdout.write("Pairing code: ");
  const input = process.stdin;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let code = "";
      function onData(chunk: Buffer) {
        for (const character of chunk.toString()) {
          if (character === "\r" || character === "\n") { input.off("data", onData); process.stdout.write("\n"); resolve(code.trim()); return; }
          if (character === "\u0003") { input.off("data", onData); reject(new Error("Cancelled")); return; }
          if (character === "\b" || character === "\u007f") { code = code.slice(0, -1); continue; }
          if (code.length < 100 && character >= " ") code += character;
        }
      }
      input.on("data", onData);
    });
  } finally { input.setRawMode(false); input.pause(); }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hostArgument(): HostIdentity["hostType"] {
  const host = argument("--host");
  if (host !== "claude-code" && host !== "codex") throw new Error("Specify --host claude-code or --host codex.");
  return host;
}

async function currentConnection(): Promise<AgentConnection> {
  const { path, config } = await findConfig();
  return { ...config, ...await findHostIdentity(dirname(dirname(path)), hostArgument()) };
}

async function init() {
  if (process.argv.some((arg) => arg === "--code" || arg.startsWith("--code="))) throw new Error("Enter the pairing code at the private prompt; command arguments are visible to other processes.");
  const apiUrl = argument("--url");
  const hostType = hostArgument();
  if (!apiUrl) throw new Error("Usage: a2a init --host codex|claude-code --url https://your-a2a-app.example");
  const code = await readPairingCode();
  if (!code) throw new Error("A pairing code is required");
  const paired = await pairAgent(apiUrl, code, hostType);
  const config: SidecarConfig = {
    apiUrl: new URL(apiUrl).origin, realtimeUrl: paired.realtime.url, publishableKey: paired.realtime.publishableKey,
    organizationId: paired.organizationId,
  };
  const connection = { ...config, hostType, agentId: paired.agentId };
  if (paired.hostType !== hostType) {
    await new AgentApi(connection, paired.token).revoke();
    throw new Error("Pairing code belongs to a different host type. Use the matching agent.");
  }
  const credentials = new OsCredentialStore();
  try { await saveConfig(process.cwd(), config); }
  catch (error) { await new AgentApi(connection, paired.token).revoke(); throw error; }
  await credentials.set(connection, paired.token);
  await saveHostIdentity(process.cwd(), { hostType, agentId: paired.agentId });
  process.stdout.write(`Paired ${hostType} agent ${paired.agentId}. Public project config saved in .a2a/config.json.\n`);
}

async function status() {
  const config = await currentConnection();
  const credentials = new OsCredentialStore();
  const token = await credentials.get(config);
  const api = new AgentApi(config, token);
  await api.heartbeat();
  const cache = await new SyncEngine(api, userCachePath(config.agentId)).cache();
  process.stdout.write(`Agent ${config.agentId}: authenticated; ${cache.connection}; ${cache.headers.length} cached headers.\n`);
}

async function logout() {
  const config = await currentConnection();
  const credentials = new OsCredentialStore();
  const token = await credentials.get(config);
  let remoteError: unknown;
  try { await new AgentApi(config, token).revoke(); }
  catch (error) { remoteError = error; }
  await credentials.delete(config);
  await rm(userCachePath(config.agentId), { force: true });
  if (remoteError && !(remoteError instanceof ApiError && remoteError.code === "UNAUTHENTICATED")) throw remoteError;
  process.stdout.write("Agent token revoked and local credential removed.\n");
}

async function daemon() {
  const config = await currentConnection();
  const token = await new OsCredentialStore().get(config);
  const api = new AgentApi(config, token);
  const sync = new SyncEngine(api, userCachePath(config.agentId), (header) => {
    process.stdout.write(`[a2a] ${header.priority}: ${header.subject}\n`);
  });
  const session = new RealtimeSession(config, api, sync, undefined, () => {
    process.stderr.write("a2a: agent credential revoked; run a2a init again.\n");
    process.exitCode = 1;
  });
  await session.start();
  const stop = () => void session.stop().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main() {
  const command = process.argv[2];
  if (command === "init") await init();
  else if (command === "status") await status();
  else if (command === "logout") await logout();
  else if (command === "daemon") await daemon();
  else process.stdout.write("Usage: a2a <init --host HOST --url URL | status --host HOST | logout --host HOST | daemon --host HOST>\n");
}

main().catch((error: unknown) => {
  // Never print HTTP bodies, headers, pairing codes, tokens, or stack traces.
  const code = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`a2a: ${code}\n`);
  process.exitCode = 1;
});
