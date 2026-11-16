import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

import { AgentApi } from "./api.js";
import type { SidecarConfig } from "./config.js";
import { SyncEngine } from "./sync.js";

export class RealtimeSession {
  private client: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private stopped = false;

  constructor(private readonly config: SidecarConfig, private readonly api: AgentApi, private readonly sync: SyncEngine) {
    this.client = createClient(config.realtimeUrl, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  async start() {
    this.stopped = false;
    await this.sync.setConnection("connecting");
    await this.sync.sync(); // catch up before opening the socket
    await this.connect();
    this.heartbeatTimer = setInterval(() => void this.api.heartbeat().catch(() => this.scheduleRetry()), 30_000);
    this.refreshTimer = setInterval(() => void this.refresh().catch(() => this.scheduleRetry()), 12 * 60_000);
  }

  private async connect() {
    if (this.stopped) return;
    try {
      await this.refresh();
      if (this.channel) await this.client.removeChannel(this.channel);
      this.channel = this.client.channel(`agent:${this.config.agentId}`, { config: { private: true } })
        .on("broadcast", { event: "*" }, ({ payload }) => this.sync.onRealtimeEvent(payload));
      this.channel.subscribe((status) => {
        if (this.stopped) return;
        if (status === "SUBSCRIBED") {
          this.retryCount = 0;
          void this.sync.setConnection("online").then(() => this.sync.sync()).catch(() => this.scheduleRetry());
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          this.scheduleRetry();
        }
      });
    } catch { this.scheduleRetry(); }
  }

  private async refresh() {
    const credentials = await this.api.realtimeToken();
    if (new URL(credentials.url).origin !== new URL(this.config.realtimeUrl).origin ||
        credentials.publishableKey !== this.config.publishableKey) throw new Error("Realtime project configuration changed");
    await this.client.realtime.setAuth(credentials.token);
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
