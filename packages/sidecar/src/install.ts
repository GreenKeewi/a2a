import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import type { HostIdentity } from "./config.js";
import { hookEvents } from "./hook.js";

const instruction = "Use a2a for cross-agent coordination. Check a2a_inbox when notified, before changing another agent's scope, and before ending work with an open handoff. Keep messages concise and reference files or commits instead of pasting code. Blockers and questions require a reply; FYIs do not. When answering a message, pass its id as replyTo to a2a_send and continue its thread with threadId so the original task can complete.";
const start = "<!-- a2a managed instructions start -->";
const end = "<!-- a2a managed instructions end -->";
const tomlStart = "# a2a managed MCP start";
const tomlEnd = "# a2a managed MCP end";

async function readOptional(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function save(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

function command(cliPath: string, event: string, host: HostIdentity["hostType"]) {
  const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
  return `${quote(process.execPath)} ${quote(join(dirname(cliPath), "hook-cli.js"))} --host ${host} --event ${event}`;
}

function mergeHooks(current: Record<string, unknown>, cliPath: string, host: HostIdentity["hostType"]) {
  const hooks = current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks)
    ? current.hooks as Record<string, unknown> : {};
  for (const event of hookEvents) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event] as unknown[]] : [];
    const existing = groups.filter((group) => !isA2aHook(group));
    existing.push({ hooks: [{ type: "command", command: command(cliPath, event, host), timeout: 2 }] });
    hooks[event] = existing;
  }
  return { ...current, hooks };
}

function isA2aHook(group: unknown) {
  if (!group || typeof group !== "object" || !("hooks" in group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some((hook: unknown) => hook && typeof hook === "object" && "command" in hook &&
    typeof hook.command === "string" && hook.command.includes("hook-cli.js") && hook.command.includes(" --event "));
}

function jsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Host configuration must be a JSON object");
  return value as Record<string, unknown>;
}

function claudeProjectKey(projects: Record<string, unknown>, projectRoot: string) {
  const canonical = platform() === "win32" ? projectRoot.replaceAll("\\", "/") : projectRoot;
  if (platform() !== "win32") return canonical;
  return Object.keys(projects).find((key) => key.replaceAll("\\", "/").toLowerCase() === canonical.toLowerCase()) ?? canonical;
}

function managedInstructions(current: string) {
  const block = `${start}\n${instruction}\n${end}`;
  const begin = current.indexOf(start);
  const finish = current.indexOf(end);
  if (begin >= 0 || finish >= 0) {
    if (begin < 0 || finish < begin) throw new Error("Broken a2a managed instruction block");
    return `${current.slice(0, begin)}${block}${current.slice(finish + end.length)}`;
  }
  return `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
}

function withoutManagedInstructions(current: string) {
  const begin = current.indexOf(start);
  const finish = current.indexOf(end);
  if (begin < 0 || finish < begin) return current;
  return `${current.slice(0, begin).trimEnd()}${current.slice(finish + end.length)}`.trimStart();
}

function withoutManagedHooks(current: Record<string, unknown>) {
  const hooks = current.hooks && typeof current.hooks === "object" && !Array.isArray(current.hooks)
    ? current.hooks as Record<string, unknown> : {};
  for (const event of hookEvents) {
    if (!Array.isArray(hooks[event])) continue;
    const remaining = (hooks[event] as unknown[]).filter((group) => !isA2aHook(group));
    if (remaining.length) hooks[event] = remaining;
    else delete hooks[event];
  }
  return { ...current, hooks };
}

export async function installHost(projectRoot: string, host: HostIdentity["hostType"], cliPath: string) {
  const instructions = join(projectRoot, host === "codex" ? "AGENTS.md" : "CLAUDE.md");
  const existingInstructions = await readOptional(instructions);
  const nextInstructions = managedInstructions(existingInstructions);
  const mcpCommand = `${process.execPath}`;
  const mcpArgs = [cliPath, "mcp", "--host", host];
  if (host === "claude-code") {
    const mcpPath = process.env.A2A_CLAUDE_CONFIG_PATH ?? join(homedir(), ".claude.json");
    const settingsPath = join(projectRoot, ".claude", "settings.local.json");
    const mcp = jsonObject(await readOptional(mcpPath));
    const projects = mcp.projects && typeof mcp.projects === "object" && !Array.isArray(mcp.projects)
      ? mcp.projects as Record<string, unknown> : {};
    const existingKey = claudeProjectKey(projects, projectRoot);
    const projectKey = platform() === "win32" ? projectRoot.replaceAll("\\", "/") : projectRoot;
    const project = projects[existingKey] && typeof projects[existingKey] === "object" && !Array.isArray(projects[existingKey])
      ? projects[existingKey] as Record<string, unknown> : {};
    const servers = project.mcpServers && typeof project.mcpServers === "object" && !Array.isArray(project.mcpServers)
      ? project.mcpServers as Record<string, unknown> : {};
    servers.a2a = { command: mcpCommand, args: mcpArgs };
    if (existingKey !== projectKey) delete projects[existingKey];
    projects[projectKey] = { ...project, mcpServers: servers };
    const settings = mergeHooks(jsonObject(await readOptional(settingsPath)), cliPath, host);
    await save(mcpPath, `${JSON.stringify({ ...mcp, projects }, null, 2)}\n`);
    await save(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } else {
    const configPath = join(projectRoot, ".codex", "config.toml");
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    const toml = await readOptional(configPath);
    const begin = toml.indexOf(tomlStart);
    const finish = toml.indexOf(tomlEnd);
    if ((begin >= 0) !== (finish >= 0) || (begin >= 0 && finish < begin)) throw new Error("Broken a2a managed MCP block");
    if (begin < 0 && (/^\s*\[mcp_servers\.a2a\]/m.test(toml) ||
      /\[mcp_servers\]([^[]*)\ba2a\s*=/m.test(toml))) throw new Error("An unmanaged a2a MCP server already exists");
    const without = begin >= 0 ? `${toml.slice(0, begin)}${toml.slice(finish + tomlEnd.length)}` : toml;
    const quoted = (value: string) => JSON.stringify(value);
    const block = `${tomlStart}\n[mcp_servers.a2a]\ncommand = ${quoted(mcpCommand)}\nargs = [${mcpArgs.map(quoted).join(", ")}]\n${tomlEnd}`;
    const hooks = mergeHooks(jsonObject(await readOptional(hooksPath)), cliPath, host);
    await save(configPath, `${without.trimEnd()}${without.trim() ? "\n\n" : ""}${block}\n`);
    await save(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  }
  await save(instructions, nextInstructions);
  return { files: host === "codex" ? [".codex/config.toml", ".codex/hooks.json", "AGENTS.md"] : ["~/.claude.json local MCP entry", ".claude/settings.local.json", "CLAUDE.md"] };
}

export async function uninstallHost(projectRoot: string, host: HostIdentity["hostType"], cliPath: string) {
  const instructions = join(projectRoot, host === "codex" ? "AGENTS.md" : "CLAUDE.md");
  const existingInstructions = await readOptional(instructions);
  if (host === "claude-code") {
    const mcpPath = process.env.A2A_CLAUDE_CONFIG_PATH ?? join(homedir(), ".claude.json");
    const settingsPath = join(projectRoot, ".claude", "settings.local.json");
    const mcp = jsonObject(await readOptional(mcpPath));
    const projects = mcp.projects as Record<string, Record<string, unknown>> | undefined;
    const projectKey = claudeProjectKey(projects ?? {}, projectRoot);
    const servers = projects?.[projectKey]?.mcpServers as Record<string, unknown> | undefined;
    const server = servers?.a2a as { args?: unknown } | undefined;
    if (Array.isArray(server?.args) && server.args.includes(cliPath)) {
      delete servers?.a2a;
      await save(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    }
    const settings = jsonObject(await readOptional(settingsPath));
    await save(settingsPath, `${JSON.stringify(withoutManagedHooks(settings), null, 2)}\n`);
  } else {
    const configPath = join(projectRoot, ".codex", "config.toml");
    const hooksPath = join(projectRoot, ".codex", "hooks.json");
    const toml = await readOptional(configPath);
    const begin = toml.indexOf(tomlStart);
    const finish = toml.indexOf(tomlEnd);
    if (begin >= 0 && finish > begin) {
      const before = toml.slice(0, begin).trimEnd();
      const after = toml.slice(finish + tomlEnd.length).trimStart();
      await save(configPath, `${before}${before && after ? "\n\n" : ""}${after}`.trimEnd() + "\n");
    }
    const hooks = jsonObject(await readOptional(hooksPath));
    await save(hooksPath, `${JSON.stringify(withoutManagedHooks(hooks), null, 2)}\n`);
  }
  if (existingInstructions.includes(start)) await save(instructions, withoutManagedInstructions(existingInstructions));
}

export async function hostInstallStatus(projectRoot: string, host: HostIdentity["hostType"]) {
  const hooksPath = join(projectRoot, host === "codex" ? ".codex" : ".claude", host === "codex" ? "hooks.json" : "settings.local.json");
  const hooks = jsonObject(await readOptional(hooksPath)).hooks as Record<string, unknown> | undefined;
  const installedHooks = hookEvents.every((event) => Array.isArray(hooks?.[event]) &&
    (hooks[event] as unknown[]).some((group) => isA2aHook(group)));
  if (host === "codex") {
    const config = await readOptional(join(projectRoot, ".codex", "config.toml"));
    const userConfig = await readOptional(join(homedir(), ".codex", "config.toml"));
    const requirements = await readOptional(join(homedir(), ".codex", "requirements.toml"));
    return { mcpInstalled: config.includes(tomlStart), hooksInstalled: installedHooks,
      hooksExplicitlyDisabled: [config, userConfig].some((text) => /\[features\][^[]*\b(?:hooks|codex_hooks)\s*=\s*false/m.test(text)) ||
        /\ballow_managed_hooks_only\s*=\s*true/m.test(requirements) };
  }
  const mcpPath = process.env.A2A_CLAUDE_CONFIG_PATH ?? join(homedir(), ".claude.json");
  const mcp = jsonObject(await readOptional(mcpPath));
  const projects = mcp.projects as Record<string, Record<string, unknown>> | undefined;
  const projectKey = claudeProjectKey(projects ?? {}, projectRoot);
  const servers = projects?.[projectKey]?.mcpServers as Record<string, unknown> | undefined;
  return { mcpInstalled: !!servers?.a2a, hooksInstalled: installedHooks, hooksExplicitlyDisabled: false };
}
