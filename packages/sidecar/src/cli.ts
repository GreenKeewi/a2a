#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { AgentApi, ApiError, pairAgent } from "./api.js";
import { findConfig, findHostIdentity, OsCredentialStore, saveConfig, saveHostIdentity, userCachePath,
  type AgentConnection, type HostIdentity, type SidecarConfig } from "./config.js";
import { RealtimeSession } from "./realtime.js";
import { createMcpServer } from "./mcp.js";
import { SyncEngine } from "./sync.js";
import { evaluateHook, hookEvents } from "./hook.js";
import { hostInstallStatus, installHost, uninstallHost } from "./install.js";

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
  const installed = await installHost(process.cwd(), hostType, fileURLToPath(import.meta.url));
  process.stdout.write(`Paired ${hostType} agent ${paired.agentId}. Public project config saved in .a2a/config.json.\n`);
  process.stdout.write(`Installed ${installed.files.join(", ")}.\n`);
}

async function install() {
  const { path } = await findConfig();
  await findHostIdentity(dirname(dirname(path)), hostArgument());
  const installed = await installHost(dirname(dirname(path)), hostArgument(), fileURLToPath(import.meta.url));
  process.stdout.write(`Installed ${installed.files.join(", ")}.\n`);
}

async function hook() {
  const event = argument("--event");
  if (!hookEvents.some((candidate) => candidate === event)) throw new Error("Unknown hook event");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (raw.length > 65536) throw new Error("Hook input too large");
  }
  const config = await currentConnection();
  const output = await evaluateHook(event as (typeof hookEvents)[number], JSON.parse(raw || "{}"), userCachePath(config.agentId));
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function status() {
  const config = await currentConnection();
  const { path } = await findConfig();
  const installed = await hostInstallStatus(dirname(dirname(path)), config.hostType);
  const credentials = new OsCredentialStore();
  const token = await credentials.get(config);
  const api = new AgentApi(config, token);
  const cache = await new SyncEngine(api, userCachePath(config.agentId)).cache();
  let remote = "unreachable";
  try { await api.heartbeat(); remote = "authenticated"; }
  catch (error) { if (error instanceof ApiError && error.code === "UNAUTHENTICATED") remote = "revoked"; }
  process.stdout.write(`Agent ${config.agentId}: ${remote}; ${cache.connection}; ${cache.headers.length} cached headers; MCP ${installed.mcpInstalled ? "installed" : "missing"}; hooks ${installed.hooksInstalled ? "installed" : "missing"}.\n`);
  if (config.hostType === "codex") process.stdout.write(installed.hooksExplicitlyDisabled
    ? "Codex hooks are disabled in project config.\n" : "Review and trust project hooks in Codex /hooks before use.\n");
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
  const { path } = await findConfig();
  await uninstallHost(dirname(dirname(path)), config.hostType, fileURLToPath(import.meta.url));
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

async function mcp() {
  let config: AgentConnection | null = null;
  let token: string | null = null;
  try { config = await currentConnection(); token = await new OsCredentialStore().get(config); }
  catch { /* Keep the MCP interface available with a safe authentication error. */ }
  const unavailable = async (): Promise<never> => { throw new ApiError("UNAUTHENTICATED", 401); };
  const api = config && token ? new AgentApi(config, token) :
    { send: unavailable, inbox: unavailable, read: unavailable, agents: unavailable };
  // The protocol server must be ready even while the network is unavailable.
  const handle = serveStdio(() => createMcpServer(api));
  const sync = config && token ? new SyncEngine(new AgentApi(config, token), userCachePath(config.agentId), () => {}, false) : null;
  const session = config && token && sync ? new RealtimeSession(config, new AgentApi(config, token), sync) : null;
  if (session) void session.start().catch(() => {});
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const fallback = setTimeout(() => process.exit(0), 2_000);
    void Promise.allSettled([handle.close(), session?.stop() ?? Promise.resolve()]).then(() => {
      clearTimeout(fallback);
      process.exit(0);
    });
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (process.stdin.readableEnded || process.stdin.destroyed) stop();
}

async function main() {
  const command = process.argv[2];
  if (command === "init") await init();
  else if (command === "status") await status();
  else if (command === "logout") await logout();
  else if (command === "daemon") await daemon();
  else if (command === "mcp") await mcp();
  else if (command === "install") await install();
  else if (command === "hook") await hook();
  else process.stdout.write("Usage: a2a <init --host HOST --url URL | install --host HOST | status --host HOST | logout --host HOST | daemon --host HOST | mcp --host HOST | hook --host HOST --event EVENT>\n");
}

main().catch((error: unknown) => {
  // Never print HTTP bodies, headers, pairing codes, tokens, or stack traces.
  const code = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`a2a: ${code}\n`);
  process.exitCode = 1;
});
