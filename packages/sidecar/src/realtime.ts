import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

import { AgentApi, ApiError } from "./api.js";
import type { AgentConnection } from "./config.js";
import { SyncEngine } from "./sync.js";

export class RealtimeSession {
  private client: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private stopped = false;
  private currentJwt = "";

  constructor(private readonly config: AgentConnection, private readonly api: Pick<AgentApi, "realtimeToken" | "heartbeat">,
    private readonly sync: Pick<SyncEngine, "sync" | "setConnection" | "onRealtimeEvent">, client?: SupabaseClient,
    private readonly onRevoked: () => void = () => {}) {
    this.client = client ?? createClient(config.realtimeUrl, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      accessToken: async () => this.currentJwt,
    });
  }

  async start() {
    this.stopped = false;
    await this.sync.setConnection("connecting").catch(() => {});
    await this.sync.sync().catch(() => {}); // outages retry after the socket reconnects
    await this.connect();
    if (this.stopped) return;
    this.heartbeatTimer = setInterval(() => void this.api.heartbeat().catch(() => {}), 30_000);
    this.refreshTimer = setInterval(() => void this.refresh().catch((error: unknown) => this.handleError(error)), 12 * 60_000);
  }

  private async connect() {
    if (this.stopped) return;
    try {
      await this.refresh();
      const old = this.channel;
      this.channel = null;
      if (old) await this.client.removeChannel(old);
      const channel = this.client.channel(`agent:${this.config.agentId}`, { config: { private: true } })
        .on("broadcast", { event: "*" }, ({ payload }) => this.sync.onRealtimeEvent(payload));
      this.channel = channel;
      channel.subscribe((status) => {
        if (this.stopped || this.channel !== channel) return;
        if (status === "SUBSCRIBED") {
          if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
          this.retryCount = 0;
          void this.sync.setConnection("online").then(() => this.sync.sync()).catch(() => this.scheduleRetry());
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.scheduleRetry();
        }
      });
    } catch (error) { this.handleError(error); }
  }

  private handleError(error: unknown) {
    if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
      this.onRevoked();
      void this.stop().catch(() => {});
      return;
    }
    this.scheduleRetry();
  }

  private async refresh() {
    const credentials = await this.api.realtimeToken();
    if (new URL(credentials.url).origin !== new URL(this.config.realtimeUrl).origin ||
        credentials.publishableKey !== this.config.publishableKey) throw new Error("Realtime project configuration changed");
    this.currentJwt = credentials.token;
    await this.client.realtime.setAuth();
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    void this.sync.setConnection("offline").catch(() => {});
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.retryCount++, 6));
    const jitter = Math.floor(Math.random() * Math.min(1_000, delay));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay + jitter);
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.channel) await this.client.removeChannel(this.channel);
    await this.client.removeAllChannels();
    await this.sync.setConnection("offline");
  }
}
