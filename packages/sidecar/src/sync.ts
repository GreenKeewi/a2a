import { realtimeEventSchema } from "@a2a/protocol";

import { readCache, writeCache, type InboxHeader, type SidecarCache } from "./cache.js";

export interface SyncApi {
  inbox(options: { cursor?: string; includeBriefing?: boolean; unreadOnly?: boolean; limit?: number }): Promise<{
    items: InboxHeader[]; nextCursor: string | null; briefing?: unknown;
  }>;
  pendingNotices(): Promise<InboxHeader[]>;
  acknowledgeNotices(ids: string[]): Promise<{ acknowledged: string[] }>;
}

export class SyncEngine {
  private running: Promise<SidecarCache> | null = null;
  private pending = false;
  private writeQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly api: SyncApi, private readonly cachePath: string,
    private readonly onNotice: (header: InboxHeader, latencyMs: number) => void = () => {},
    private readonly drainNotices = true) {}

  async cache() { return readCache(this.cachePath); }

  private updateCache(change: (current: SidecarCache) => SidecarCache): Promise<SidecarCache> {
    const write = this.writeQueue.then(async () => {
      const next = change(await this.cache());
      await writeCache(this.cachePath, next);
      return next;
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  async setConnection(connection: SidecarCache["connection"]) {
    return this.updateCache((cache) => ({ ...cache, connection }));
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
    // Drain urgent notices first; refreshing 100 cached headers must not delay them.
    for (; this.drainNotices;) {
      const pending = await this.api.pendingNotices();
      if (!pending.length) break;
      for (const item of pending) this.onNotice(item, Math.max(0, Date.now() - new Date(item.createdAt).getTime()));
      await this.api.acknowledgeNotices(pending.map((item) => item.id));
      if (pending.length < 25) break;
    }
    const fetched: InboxHeader[] = [];
    let cursor: string | null = null;
    let briefing: unknown;
    do {
      const page = await this.api.inbox({ ...(cursor ? { cursor } : {}), includeBriefing: !cursor, unreadOnly: false, limit: 25 });
      if (!cursor && page.briefing !== undefined) briefing = page.briefing;
      fetched.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && fetched.length < 100);
    const next = await this.updateCache((previous) => ({
      ...previous, headers: fetched.slice(0, 100), newestId: fetched[0]?.id ?? null,
      briefing: briefing ?? previous.briefing,
      briefingVersion: typeof briefing === "object" && briefing && "briefVersion" in briefing && typeof briefing.briefVersion === "number"
        ? briefing.briefVersion : previous.briefingVersion,
      lastSyncedAt: new Date().toISOString(),
    }));
    return next;
  }

  onRealtimeEvent(payload: unknown) {
    const event = realtimeEventSchema.safeParse(payload);
    if (!event.success) return;
    void this.sync().catch(() => { /* reconnect and the next poll repeat catch-up */ });
  }
}
