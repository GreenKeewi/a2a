import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import { parse as parseToml } from "smol-toml";

import { emptyCache, writeCache } from "./cache.js";
import { evaluateHook } from "./hook.js";
import { hostInstallStatus, installHost, uninstallHost } from "./install.js";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function project() { const path = await mkdtemp(join(tmpdir(), "a2a-hook-test-")); temporary.push(path); return path; }

test("hook notices are deduplicated, and an urgent Stop can continue once", async () => {
  const root = await project();
  const cachePath = join(root, "cache.json");
  const id = "11111111-1111-4111-8111-111111111111";
  await writeCache(cachePath, { ...emptyCache(), briefing: { brief: "Ship the API", briefVersion: 1 }, briefingVersion: 1,
    headers: [{ id, threadId: "22222222-2222-4222-8222-222222222222", type: "blocker", priority: "high",
      subject: "Need schema review", senderHandle: "agent-a", createdAt: new Date().toISOString(), unread: true }] });
  const input = { session_id: "session-1" };
  expect(await evaluateHook("SessionStart", input, cachePath)).toMatchObject({ hookSpecificOutput: { hookEventName: "SessionStart" } });
  expect(await evaluateHook("SessionStart", input, cachePath)).toEqual({});
  expect(await evaluateHook("PostToolUse", input, cachePath)).toEqual({});
  expect(await evaluateHook("Stop", input, cachePath)).toMatchObject({ decision: "block" });
  expect(await evaluateHook("Stop", input, cachePath)).toEqual({});
  expect(await evaluateHook("Stop", { ...input, stop_hook_active: true }, cachePath)).toEqual({});
  const parallel = await Promise.all(Array.from({ length: 6 }, () => evaluateHook("PostToolUse", { session_id: "parallel" }, cachePath)));
  expect(parallel.filter((item) => "hookSpecificOutput" in item)).toHaveLength(1);
});

test("normal questions wait for a turn boundary", async () => {
  const root = await project();
  const cachePath = join(root, "cache.json");
  await writeCache(cachePath, { ...emptyCache(), headers: [{ id: "33333333-3333-4333-8333-333333333333",
    threadId: "44444444-4444-4444-8444-444444444444", type: "question", priority: "normal",
    subject: "Which schema?", senderHandle: "agent-b", createdAt: new Date().toISOString(), unread: true }] });
  const input = { session_id: "session-question" };
  expect(await evaluateHook("PostToolUse", input, cachePath)).toEqual({});
  expect(await evaluateHook("UserPromptSubmit", input, cachePath)).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
  expect(await evaluateHook("UserPromptSubmit", input, cachePath)).toEqual({});
  expect(await evaluateHook("Stop", input, cachePath)).toEqual({});
});

test.each(["codex", "claude-code"] as const)("%s installer preserves existing settings and reruns remain singular", async (host) => {
    const root = await project();
    const canonicalRoot = root.replaceAll("\\", "/");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const previousClaudeConfig = process.env.A2A_CLAUDE_CONFIG_PATH;
    process.env.A2A_CLAUDE_CONFIG_PATH = join(root, "user", ".claude.json");
    if (host === "codex") {
      await mkdir(join(root, ".codex"));
      await writeFile(join(root, ".codex", "config.toml"), 'model = "test"\n');
      await writeFile(join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] } }));
      await writeFile(join(root, "AGENTS.md"), "Existing instructions\n");
    } else {
      await mkdir(join(root, "user"));
      await writeFile(process.env.A2A_CLAUDE_CONFIG_PATH, JSON.stringify({ projects: { [root]: { mcpServers: { other: { command: "other" } } } } }));
      await mkdir(join(root, ".claude"));
      await writeFile(join(root, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] } }));
      await writeFile(join(root, "CLAUDE.md"), "Existing instructions\n");
    }
    await installHost(root, host, join(root, "dist", "cli.js"));
    await installHost(root, host, join(root, "dist", "cli.js"));
    const hooks = JSON.parse(await readFile(join(root, host === "codex" ? ".codex" : ".claude", host === "codex" ? "hooks.json" : "settings.local.json"), "utf8"));
    expect(hooks.hooks.Stop).toHaveLength(2);
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.Stop[1].hooks[0].timeout).toBe(2);
    const instructions = await readFile(join(root, host === "codex" ? "AGENTS.md" : "CLAUDE.md"), "utf8");
    expect(instructions.match(/a2a managed instructions start/g)).toHaveLength(1);
    expect(instructions).toContain("replyTo");
    if (host === "codex") {
      const parsed = parseToml(await readFile(join(root, ".codex", "config.toml"), "utf8"));
      expect(parsed.model).toBe("test");
      expect((parsed.mcp_servers as Record<string, unknown>).a2a).toBeTruthy();
    }
    else {
      const projects = JSON.parse(await readFile(process.env.A2A_CLAUDE_CONFIG_PATH, "utf8")).projects;
      expect(projects[canonicalRoot].mcpServers.other).toBeTruthy();
      if (canonicalRoot !== root) expect(projects[root]).toBeUndefined();
    }
    expect(await hostInstallStatus(root, host)).toMatchObject({ mcpInstalled: true, hooksInstalled: true });
    await uninstallHost(root, host, join(root, "dist", "cli.js"));
    expect(await hostInstallStatus(root, host)).toMatchObject({ mcpInstalled: false, hooksInstalled: false });
    expect(await readFile(join(root, host === "codex" ? "AGENTS.md" : "CLAUDE.md"), "utf8")).toContain("Existing instructions");
    if (previousClaudeConfig === undefined) delete process.env.A2A_CLAUDE_CONFIG_PATH;
    else process.env.A2A_CLAUDE_CONFIG_PATH = previousClaudeConfig;
}, 15_000);
