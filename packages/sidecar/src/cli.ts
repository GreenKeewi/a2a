#!/usr/bin/env node
import { rm } from "node:fs/promises";

import { AgentApi, pairAgent } from "./api.js";
import { findConfig, OsCredentialStore, saveConfig, userCachePath, type SidecarConfig } from "./config.js";
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

async function init() {
  if (process.argv.includes("--code")) throw new Error("Enter the pairing code at the private prompt; command arguments are visible to other processes.");
  const apiUrl = argument("--url");
  if (!apiUrl) throw new Error("Usage: a2a init --url https://your-a2a-app.example");
  const code = await readPairingCode();
  if (!code) throw new Error("A pairing code is required");
  const paired = await pairAgent(apiUrl, code);
  const config: SidecarConfig = {
    apiUrl: new URL(apiUrl).origin, realtimeUrl: paired.realtime.url, publishableKey: paired.realtime.publishableKey,
    organizationId: paired.organizationId, agentId: paired.agentId,
  };
  const credentials = new OsCredentialStore();
  await credentials.set(config, paired.token);
  await saveConfig(process.cwd(), config);
  process.stdout.write(`Paired agent ${config.agentId}. Public project config saved in .a2a/config.json.\n`);
}

async function status() {
  const { config } = await findConfig();
  const credentials = new OsCredentialStore();
  const token = await credentials.get(config);
  const api = new AgentApi(config, token);
  await api.heartbeat();
  const cache = await new SyncEngine(api, userCachePath(config.agentId)).cache();
  process.stdout.write(`Agent ${config.agentId}: authenticated; ${cache.connection}; ${cache.headers.length} cached headers.\n`);
}

async function logout() {
  const { config } = await findConfig();
  const credentials = new OsCredentialStore();
  const token = await credentials.get(config);
  await new AgentApi(config, token).revoke();
  await credentials.delete(config);
  await rm(userCachePath(config.agentId), { force: true });
  process.stdout.write("Agent token revoked and local credential removed.\n");
}

async function daemon() {
  const { config } = await findConfig();
  const token = await new OsCredentialStore().get(config);
  const api = new AgentApi(config, token);
  const sync = new SyncEngine(api, userCachePath(config.agentId), (header) => {
    process.stdout.write(`[a2a] ${header.priority}: ${header.subject}\n`);
  });
  const session = new RealtimeSession(config, api, sync);
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
  else process.stdout.write("Usage: a2a <init --url URL | status | logout | daemon>\n");
}

main().catch((error: unknown) => {
  // Never print HTTP bodies, headers, pairing codes, tokens, or stack traces.
  const code = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`a2a: ${code}\n`);
  process.exitCode = 1;
});
