#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { evaluateHook, hookEvents } from "./hook.js";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function projectRoot() {
  let current = resolve(process.cwd());
  for (;;) {
    try { await access(join(current, ".a2a", "config.json")); return current; }
    catch { const parent = dirname(current); if (parent === current) throw new Error("No a2a config"); current = parent; }
  }
}

function userConfigRoot() {
  return process.env.A2A_CONFIG_HOME ?? (platform() === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming") :
    platform() === "darwin" ? join(homedir(), "Library", "Application Support") : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
}

function cacheRoot() {
  return platform() === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local") :
    platform() === "darwin" ? join(homedir(), "Library", "Caches") : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
}

async function main() {
  const event = argument("--event");
  const host = argument("--host");
  if (!hookEvents.some((candidate) => candidate === event) || (host !== "codex" && host !== "claude-code")) return {};
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (raw.length > 65536) return {};
  }
  const root = await projectRoot();
  const fingerprint = createHash("sha256").update(platform() === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 24);
  const identityPath = join(userConfigRoot(), "a2a", "projects", fingerprint, `${host}.json`);
  const identity = JSON.parse(await readFile(identityPath, "utf8")) as { agentId?: unknown };
  if (typeof identity.agentId !== "string" || !/^[0-9a-f-]{36}$/i.test(identity.agentId)) return {};
  const path = join(cacheRoot(), "a2a", `${identity.agentId}.json`);
  return evaluateHook(event as (typeof hookEvents)[number], JSON.parse(raw || "{}"), path);
}

let finished = false;
const timeout = setTimeout(() => {
  if (finished) return;
  finished = true;
  process.stdout.write("{}\n", () => process.exit(0));
}, 450);
function finish(result: object) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
void main().then(finish, () => finish({}));
