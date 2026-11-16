import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { readCache, type InboxHeader } from "./cache.js";
import { findHostIdentity, saveConfig, saveHostIdentity } from "./config.js";
import { SyncEngine } from "./sync.js";

function header(index: number): InboxHeader {
  return {
    id: randomUUID(), threadId: randomUUID(), type: "fyi", priority: "normal",
    subject: `Message ${index}`, senderHandle: "sender", createdAt: new Date(Date.now() - index).toISOString(), unread: true,
  };
}

it("recovers dropped events through cursor catch-up and keeps only 100 headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-sync-"));
  try {
    const path = join(directory, "cache.json");
    const messages: InboxHeader[] = [];
    const acknowledged = new Set<string>();
    const notices: string[] = [];
    const api = { inbox: async ({ cursor, limit = 25 }: { cursor?: string; limit?: number }) => {
      const start = cursor ? Number(cursor) : 0;
      return { items: messages.slice(start, start + limit), nextCursor: start + limit < messages.length ? String(start + limit) : null, briefing: { briefVersion: 1 } };
    }, pendingNotices: async () => messages.filter((item) => !acknowledged.has(item.id)).slice(0, 25),
    acknowledgeNotices: async (ids: string[]) => { ids.forEach((id) => acknowledged.add(id)); return { acknowledged: ids }; } };
    const sync = new SyncEngine(api, path, (item, latency) => { notices.push(item.id); expect(latency).toBeLessThan(5_000); });
    await sync.sync();
    expect(notices).toHaveLength(0);
    const first = header(0);
    messages.push(first);
    await sync.sync();
    expect(notices).toEqual([first.id]);
    const missed = Array.from({ length: 125 }, (_, index) => header(index + 1));
    messages.unshift(...missed);
    // No Realtime event is delivered. A reconnect still pages through all 125 new headers.
    const recovered = await sync.sync();
    expect(notices).toHaveLength(126);
    expect(new Set(notices).size).toBe(126);
    expect(recovered.headers).toHaveLength(100);
    expect(recovered.newestId).toBe(missed[0]?.id);
    expect((await readCache(path)).newestId).toBe(missed[0]?.id);
    const delayedCommit = header(200);
    messages.push(delayedCommit); // older sort position, but committed after the latest was cached
    await sync.sync();
    expect(notices.at(-1)).toBe(delayedCommit.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("preserves corrupt cache and writes no token or pairing code to project config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-config-"));
  const previousConfigHome = process.env.A2A_CONFIG_HOME;
  process.env.A2A_CONFIG_HOME = directory;
  try {
    const path = join(directory, "cache.json");
    await writeFile(path, "broken-json");
    expect((await readCache(path)).headers).toEqual([]);
    expect((await readdir(directory)).some((name) => name.startsWith("cache.json.corrupt."))).toBe(true);
    await saveConfig(directory, {
      apiUrl: "https://a2a.example", realtimeUrl: "https://realtime.example", publishableKey: "sb_publishable_test",
      organizationId: randomUUID(),
    });
    const claudeId = randomUUID();
    const codexId = randomUUID();
    await saveHostIdentity(directory, { hostType: "claude-code", agentId: claudeId });
    await saveHostIdentity(directory, { hostType: "codex", agentId: codexId });
    expect((await findHostIdentity(directory, "claude-code")).agentId).toBe(claudeId);
    expect((await findHostIdentity(directory, "codex")).agentId).toBe(codexId);
    const config = await readFile(join(directory, ".a2a", "config.json"), "utf8");
    expect(config).not.toMatch(/a2a_[A-Za-z0-9_-]{43}|A2A-PAIR-/);
    expect(config).toContain("sb_publishable_test");
    await expect(saveConfig(directory, {
      apiUrl: "https://another.example", realtimeUrl: "https://realtime.example", publishableKey: "sb_publishable_test",
      organizationId: randomUUID(),
    })).rejects.toThrow("already connected");
  } finally {
    if (previousConfigHome === undefined) delete process.env.A2A_CONFIG_HOME; else process.env.A2A_CONFIG_HOME = previousConfigHome;
    await rm(directory, { recursive: true, force: true });
  }
});
