import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Entry } from "@napi-rs/keyring";
import { z } from "zod";

const safeUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
});
export const configSchema = z.strictObject({
  apiUrl: safeUrl,
  realtimeUrl: safeUrl,
  publishableKey: z.string().min(1),
  organizationId: z.uuid(),
});
export type SidecarConfig = z.infer<typeof configSchema>;
export const hostIdentitySchema = z.strictObject({ hostType: z.enum(["claude-code", "codex"]), agentId: z.uuid() });
export type HostIdentity = z.infer<typeof hostIdentitySchema>;
export type AgentConnection = SidecarConfig & HostIdentity;

export function configPath(projectRoot: string) { return join(projectRoot, ".a2a", "config.json"); }

export async function findConfig(start = process.cwd()): Promise<{ path: string; config: SidecarConfig }> {
  let current = resolve(start);
  for (;;) {
    const path = configPath(current);
    try { return { path, config: configSchema.parse(JSON.parse(await readFile(path, "utf8"))) }; }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("No .a2a/config.json found. Run a2a init in the project root.");
    current = parent;
  }
}

export async function saveConfig(projectRoot: string, value: SidecarConfig) {
  const config = configSchema.parse(value);
  const path = configPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function userConfigRoot() {
  return platform() === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming") :
    platform() === "darwin" ? join(homedir(), "Library", "Application Support") : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export function hostIdentityPath(projectRoot: string, hostType: HostIdentity["hostType"]) {
  const root = resolve(projectRoot);
  const fingerprint = createHash("sha256").update(platform() === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 24);
  return join(userConfigRoot(), "a2a", "projects", fingerprint, `${hostType}.json`);
}

export async function saveHostIdentity(projectRoot: string, identity: HostIdentity) {
  const parsed = hostIdentitySchema.parse(identity);
  const path = hostIdentityPath(projectRoot, parsed.hostType);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function findHostIdentity(projectRoot: string, hostType: HostIdentity["hostType"]): Promise<HostIdentity> {
  try { return hostIdentitySchema.parse(JSON.parse(await readFile(hostIdentityPath(projectRoot, hostType), "utf8"))); }
  catch { throw new Error(`No ${hostType} identity found for this project. Run a2a init --host ${hostType}.`); }
}

export interface CredentialStore {
  get(config: AgentConnection): Promise<string>;
  set(config: AgentConnection, token: string): Promise<void>;
  delete(config: AgentConnection): Promise<void>;
}

export class OsCredentialStore implements CredentialStore {
  private entry(config: AgentConnection) { return new Entry("a2a-agent", `${new URL(config.apiUrl).origin}:${config.agentId}`); }
  async get(config: AgentConnection) {
    const token = this.entry(config).getPassword();
    if (!token) throw new Error("Agent credential is missing. Run a2a init again.");
    return token;
  }
  async set(config: AgentConnection, token: string) { this.entry(config).setPassword(token); }
  async delete(config: AgentConnection) { this.entry(config).deletePassword(); }
}

export function userCachePath(agentId: string) {
  const base = platform() === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local") :
    platform() === "darwin" ? join(homedir(), "Library", "Caches") : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "a2a", `${agentId}.json`);
}
