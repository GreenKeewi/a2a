#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { AgentApi, ApiError, pairAgent } from "./api.js";
import { deleteHostIdentity, findConfig, findHostIdentity, OsCredentialStore, saveConfig, saveHostIdentity, userCachePath,
  type AgentConnection, type HostIdentity, type SidecarConfig } from "./config.js";
import { RealtimeSession } from "./realtime.js";
import { createMcpServer } from "./mcp.js";
import { SyncEngine } from "./sync.js";
import { evaluateHook, hookEvents } from "./hook.js";
import { hostInstallStatus, installHost, uninstallHost } from "./install.js";
import { HumanApi, HumanCredentialStore, checkedOrigin } from "./human.js";

let pipedLines: AsyncIterator<string> | undefined;

async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    pipedLines ??= createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
    return (await pipedLines.next()).value?.trim() ?? "";
  }
  process.stdout.write(`${label}: `);
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
          if (code.length < 256 && character >= " ") code += character;
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
  const code = await readSecret("Pairing code");
  if (!code) throw new Error("A pairing code is required");
  await pairAndInstall(apiUrl, hostType, code);
}

async function pairAndInstall(apiUrl: string, hostType: HostIdentity["hostType"], code: string) {
  let existingRoot: string | undefined;
  try { existingRoot = dirname(dirname((await findConfig()).path)); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("No .a2a/config.json found.")) throw error;
  }
  if (existingRoot) {
    try {
      await findHostIdentity(existingRoot, hostType);
      throw new Error(`${hostType} is already paired in this project. Disconnect it before pairing a replacement.`);
    }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith(`No ${hostType} identity found`)) throw error;
    }
    if (await hostInstallStatus(existingRoot, hostType).then((value) => value.mcpInstalled).catch(() => false)) {
      throw new Error(`${hostType} is already installed in this project. Disconnect it before pairing a replacement.`);
    }
  }
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

function required(name: string): string {
  const value = argument(name);
  if (!value || value.startsWith("--")) throw new Error(`Specify ${name}.`);
  return value;
}

function uuidArgument(name: string): string {
  const value = required(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value;
}

async function humanUrl(): Promise<string> {
  const explicit = argument("--url");
  return checkedOrigin(explicit ?? (await findConfig()).config.apiUrl);
}

async function login(url: string, signup = process.argv.includes("--signup")): Promise<HumanApi> {
  const origin = checkedOrigin(url);
  const email = required("--email").trim().toLowerCase();
  const password = await readSecret("Password");
  if (!password) throw new Error("A password is required.");
  const cookie = await new HumanApi(origin).authenticate(signup ? "sign-up" : "sign-in", email, password,
    signup ? required("--person") : undefined);
  await new HumanCredentialStore().set(origin, cookie);
  process.stdout.write(`Signed in as ${email}.\n`);
  return new HumanApi(origin, cookie);
}

async function humanApi(): Promise<HumanApi> {
  const origin = await humanUrl();
  return new HumanApi(origin, await new HumanCredentialStore().get(origin));
}

type Workspace = { organizationId: string; slug: string; displayName: string; role: string };
type CreatedAgent = { id: string; handle: string; overlapWarnings: string[] };

async function workspaceSlug(api: HumanApi): Promise<string> {
  const explicit = argument("--workspace");
  if (explicit) return explicit;
  const { config } = await findConfig();
  const workspaces = await api.request<Workspace[]>("/api/workspaces");
  const found = workspaces.find((workspace) => workspace.organizationId === config.organizationId);
  if (!found) throw new Error("Your account is not a member of this project's workspace.");
  return found.slug;
}

function workspacePath(slug: string, suffix = "") {
  return `/api/workspaces/${encodeURIComponent(slug)}${suffix}`;
}

function show(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function createOrJoinWorkspace(api: HumanApi): Promise<string> {
  if (process.argv.includes("--join")) {
    const code = await readSecret("Workspace invite code");
    if (!code) throw new Error("An invite code is required.");
    const joined = await api.request<{ slug: string }>("/api/workspaces/join", "POST", { code });
    return joined.slug;
  }
  const slug = required("--workspace");
  const name = argument("--name") ?? slug;
  await api.request("/api/workspaces", "POST", { slug, name });
  return slug;
}

async function setup() {
  try { await findConfig(); throw new Error("This project is already connected. Use a2a agent create and a2a agent connect for another agent."); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("No .a2a/config.json found.")) throw error;
  }
  const url = required("--url");
  const host = hostArgument();
  const handle = required("--agent");
  let api: HumanApi | undefined;
  try { api = new HumanApi(url, await new HumanCredentialStore().get(url)); }
  catch (error) { if (!(error instanceof Error) || !error.message.startsWith("No account session.")) throw error; }
  if (api) {
    try { await api.request("/api/workspaces"); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("UNAUTHENTICATED")) throw error;
      api = undefined;
    }
  }
  api ??= await login(url);
  const slug = await createOrJoinWorkspace(api);
  const agent = await api.request<CreatedAgent>(workspacePath(slug, "/agents"), "POST", {
    handle, hostType: host, role: argument("--role") ?? "Coding agent", scopes: argument("--scopes")?.split(",").filter(Boolean) ?? [],
  });
  const paired = await api.request<{ code: string }>(workspacePath(slug, `/agents/${agent.id}/pairing`), "POST");
  await pairAndInstall(url, host, paired.code);
  process.stdout.write(`Workspace ${slug} is ready. Agent ${handle} is connected.\n`);
  if (agent.overlapWarnings.length) process.stdout.write(`Shared scopes with: ${agent.overlapWarnings.join(", ")}\n`);
}

async function manageWorkspace() {
  const api = await humanApi();
  const action = process.argv[3];
  if (action === "list") show(await api.request<Workspace[]>("/api/workspaces"));
  else if (action === "create" || action === "join") {
    if (action === "join") process.argv.push("--join");
    const slug = await createOrJoinWorkspace(api);
    process.stdout.write(`Workspace ${slug} is ready.\n`);
  } else if (action === "show") show(await api.request(workspacePath(await workspaceSlug(api))));
  else if (action === "settings") {
    const slug = await workspaceSlug(api);
    const values: Record<string, unknown> = {};
    if (argument("--name")) values.displayName = argument("--name");
    if (argument("--timezone")) values.timezone = argument("--timezone");
    if (argument("--remind")) values.reminderAfterMinutes = Number(argument("--remind"));
    if (argument("--escalate")) values.escalateAfterMinutes = Number(argument("--escalate"));
    if (process.argv.includes("--smart")) values.smartFeaturesEnabled = true;
    if (process.argv.includes("--no-smart")) values.smartFeaturesEnabled = false;
    show(await api.request(workspacePath(slug, "/settings"), Object.keys(values).length ? "PATCH" : "GET", Object.keys(values).length ? values : undefined));
  } else throw new Error("Usage: a2a workspace list|create|join|show|settings");
}

async function manageInvite() {
  const api = await humanApi();
  const slug = await workspaceSlug(api);
  const action = process.argv[3];
  if (action === "create") {
    const invite = await api.request<{ code: string }>(workspacePath(slug, "/invites"), "POST", {
      maxUses: Number(argument("--uses") ?? 5), expiresInHours: Number(argument("--hours") ?? 24),
    });
    process.stdout.write(`Share this one-time workspace invite privately: ${invite.code}\n`);
  } else if (action === "list") show(await api.request(workspacePath(slug, "/invites")));
  else if (action === "revoke") show(await api.request(workspacePath(slug, "/invites"), "DELETE", { inviteId: uuidArgument("--id") }));
  else throw new Error("Usage: a2a invite create|list|revoke");
}

async function manageAgent() {
  const api = await humanApi();
  const slug = await workspaceSlug(api);
  const action = process.argv[3];
  const path = workspacePath(slug, "/agents");
  if (action === "list") show(await api.request(path));
  else if (action === "create" || action === "add") {
    const host = hostArgument();
    const created = await api.request<CreatedAgent>(path, "POST", {
      handle: required("--agent"), hostType: host, role: argument("--role") ?? "Coding agent",
      scopes: argument("--scopes")?.split(",").filter(Boolean) ?? [],
    });
    if (action === "add") {
      const paired = await api.request<{ code: string }>(`${path}/${created.id}/pairing`, "POST");
      await pairAndInstall(api.origin, host, paired.code);
    }
    show(created);
  }
  else {
    const agents = await api.request<Array<{ id: string; handle: string }>>(path);
    const agent = agents.find((item) => item.handle.toLowerCase() === required("--agent").toLowerCase());
    if (!agent) throw new Error("Agent not found in this workspace.");
    const agentPath = `${path}/${agent.id}`;
    if (action === "connect") {
      const paired = await api.request<{ code: string }>(`${agentPath}/pairing`, "POST");
      await pairAndInstall(api.origin, hostArgument(), paired.code);
    } else if (action === "scopes") show(await api.request(agentPath, "PATCH", { scopes: required("--scopes").split(",").filter(Boolean) }));
    else if (action === "tokens") show(await api.request(`${agentPath}/tokens`));
    else if (action === "revoke-token") show(await api.request(`${agentPath}/tokens/${uuidArgument("--id")}`, "DELETE"));
    else if (action === "revoke") show(await api.request(agentPath, "DELETE"));
    else throw new Error("Usage: a2a agent list|create|add|connect|scopes|tokens|revoke-token|revoke");
  }
}

async function manageBrief() {
  const api = await humanApi();
  const path = workspacePath(await workspaceSlug(api), "/brief");
  if (process.argv[3] === "show") show(await api.request(path));
  else if (process.argv[3] === "set") {
    const brief = argument("--file") ? await readFile(required("--file"), "utf8") : required("--text");
    show(await api.request(path, "PATCH", { brief }));
  } else throw new Error("Usage: a2a brief show|set --file PATH");
}

async function manageMessages(command: string) {
  const api = await humanApi();
  const slug = await workspaceSlug(api);
  if (command === "inbox") show(await api.request(workspacePath(slug, `/inbox?limit=${Number(argument("--limit") ?? 40)}`)));
  else if (command === "thread") show(await api.request(workspacePath(slug, `/threads/${uuidArgument("--id")}`)));
  else if (command === "context") show(await api.request(workspacePath(slug, "/context")));
  else if (command === "stats") show(await api.request(workspacePath(slug, "/stats")));
  else if (command === "response") show(await api.request(workspacePath(slug, `/messages/${uuidArgument("--id")}/response`), "PATCH", { state: required("--state") }));
  else {
    const body = argument("--file") ? await readFile(required("--file"), "utf8") : required("--body");
    show(await api.request(workspacePath(slug, "/messages"), "POST", {
      to: required("--to").split(","), type: argument("--type") ?? "fyi", subject: required("--subject"), body,
      ...(argument("--thread") ? { threadId: argument("--thread") } : {}),
    }));
  }
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
  await deleteHostIdentity(dirname(dirname(path)), config.hostType);
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
  if (command === "setup") await setup();
  else if (command === "login") await login(await humanUrl());
  else if (command === "account" && process.argv[3] === "logout") {
    const origin = await humanUrl();
    const store = new HumanCredentialStore();
    await new HumanApi(origin, await store.get(origin)).signOut();
    await store.delete(origin);
    process.stdout.write("Account session removed from this machine.\n");
  }
  else if (command === "workspace") await manageWorkspace();
  else if (command === "invite") await manageInvite();
  else if (command === "agent") await manageAgent();
  else if (command === "brief") await manageBrief();
  else if (["send", "inbox", "thread", "context", "stats", "response"].includes(command ?? "")) await manageMessages(command!);
  else if (command === "init") await init();
  else if (command === "status") await status();
  else if (command === "logout") await logout();
  else if (command === "daemon") await daemon();
  else if (command === "mcp") await mcp();
  else if (command === "install") await install();
  else if (command === "hook") await hook();
  else process.stdout.write("Usage: a2a <setup|login|workspace|invite|agent|brief|send|inbox|thread|context|stats|response|status|logout|daemon|mcp|install|hook>\nRun a2a setup --url URL --host codex|claude-code --workspace SLUG --agent HANDLE --email EMAIL --signup --person NAME to get started.\n");
}

main().catch((error: unknown) => {
  // Never print HTTP bodies, headers, pairing codes, tokens, or stack traces.
  const code = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`a2a: ${code}\n`);
  process.exitCode = 1;
});
