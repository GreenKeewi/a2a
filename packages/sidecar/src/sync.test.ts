import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { readCache, type InboxHeader } from "./cache.js";
import { saveConfig } from "./config.js";
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
    const messages = [header(0)];
    const notices: string[] = [];
    const api = { inbox: async ({ cursor, limit = 25 }: { cursor?: string; limit?: number }) => {
      const start = cursor ? Number(cursor) : 0;
      return { items: messages.slice(start, start + limit), nextCursor: start + limit < messages.length ? String(start + limit) : null, briefing: { briefVersion: 1 } };
    } };
    const sync = new SyncEngine(api, path, (item, latency) => { notices.push(item.id); expect(latency).toBeLessThan(5_000); });
    await sync.sync();
    expect(notices).toHaveLength(0);
    const missed = Array.from({ length: 125 }, (_, index) => header(index + 1));
    messages.unshift(...missed);
    // No Realtime event is delivered. A reconnect still pages through all 125 new headers.
    const recovered = await sync.sync();
    expect(notices).toHaveLength(125);
    expect(new Set(notices).size).toBe(125);
    expect(recovered.headers).toHaveLength(100);
    expect(recovered.newestId).toBe(missed[0]?.id);
    expect((await readCache(path)).newestId).toBe(missed[0]?.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("preserves corrupt cache and writes no token or pairing code to project config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-config-"));
  try {
    const path = join(directory, "cache.json");
    await writeFile(path, "broken-json");
    expect((await readCache(path)).headers).toEqual([]);
    expect((await readdir(directory)).some((name) => name.startsWith("cache.json.corrupt."))).toBe(true);
    await saveConfig(directory, {
      apiUrl: "https://a2a.example", realtimeUrl: "https://realtime.example", publishableKey: "sb_publishable_test",
      organizationId: randomUUID(), agentId: randomUUID(),
    });
    const config = await readFile(join(directory, ".a2a", "config.json"), "utf8");
    expect(config).not.toMatch(/a2a_[A-Za-z0-9_-]{43}|A2A-PAIR-/);
    expect(config).toContain("sb_publishable_test");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
