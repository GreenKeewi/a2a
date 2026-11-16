import { realtimeEventSchema } from "@a2a/protocol";

import { readCache, writeCache, type InboxHeader, type SidecarCache } from "./cache.js";

export interface SyncApi {
  inbox(options: { cursor?: string; includeBriefing?: boolean; unreadOnly?: boolean; limit?: number }): Promise<{
    items: InboxHeader[]; nextCursor: string | null; briefing?: unknown;
  }>;
}

export class SyncEngine {
  private running: Promise<SidecarCache> | null = null;
  private pending = false;
  constructor(private readonly api: SyncApi, private readonly cachePath: string,
    private readonly onNotice: (header: InboxHeader, latencyMs: number) => void = () => {}) {}

  async cache() { return readCache(this.cachePath); }

  async setConnection(connection: SidecarCache["connection"]) {
    const cache = await this.cache();
    const next = { ...cache, connection };
    await writeCache(this.cachePath, next);
    return next;
  }

  async sync(): Promise<SidecarCache> {
    if (this.running) { this.pending = true; return this.running; }
    this.running = this.run();
    try {
      let result = await this.running;
      while (this.pending) {
        this.pending = false;
        this.running = this.run();
        result = await this.running;
      }
      return result;
    } finally { this.running = null; this.pending = false; }
  }

  private async run(): Promise<SidecarCache> {
    const previous = await this.cache();
    const fetched: InboxHeader[] = [];
    let cursor: string | null = null;
    let briefing: unknown = previous.briefing;
    let reachedKnown = false;
    do {
      const page = await this.api.inbox({ ...(cursor ? { cursor } : {}), includeBriefing: !cursor, unreadOnly: false, limit: 25 });
      if (!cursor && page.briefing !== undefined) briefing = page.briefing;
      for (const item of page.items) {
        fetched.push(item);
        if (item.id === previous.newestId) { reachedKnown = true; break; }
      }
      cursor = page.nextCursor;
      // Initial startup only needs a bounded local cache. Server inbox retains older items.
      if (!previous.newestId && fetched.length >= 100) break;
    } while (cursor && !reachedKnown);
    const merged = [...fetched, ...previous.headers.filter((item) => !fetched.some((fresh) => fresh.id === item.id))].slice(0, 100);
    const next: SidecarCache = {
      ...previous, headers: merged, newestId: merged[0]?.id ?? previous.newestId,
      briefing, briefingVersion: typeof briefing === "object" && briefing && "briefVersion" in briefing && typeof briefing.briefVersion === "number"
        ? briefing.briefVersion : previous.briefingVersion,
      lastSyncedAt: new Date().toISOString(),
    };
    await writeCache(this.cachePath, next);
    if (previous.newestId) {
      for (const item of fetched) {
        if (item.id === previous.newestId) break;
        if (item.unread) this.onNotice(item, Math.max(0, Date.now() - new Date(item.createdAt).getTime()));
      }
    }
    return next;
  }

  onRealtimeEvent(payload: unknown) {
    const event = realtimeEventSchema.safeParse(payload);
    if (!event.success) return;
    void this.sync().catch(() => { /* reconnect and the next poll repeat catch-up */ });
  }
}
