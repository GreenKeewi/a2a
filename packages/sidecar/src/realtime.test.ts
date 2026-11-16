import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";

import { emptyCache } from "./cache.js";
import { RealtimeSession } from "./realtime.js";

afterEach(() => vi.useRealTimers());

it("keeps the app-minted JWT when Realtime refreshes its own auth", async () => {
  const config = { apiUrl: "https://a2a.example", realtimeUrl: "https://realtime.example", publishableKey: "sb_publishable_test",
    organizationId: randomUUID(), agentId: randomUUID(), hostType: "codex" as const };
  const api = { realtimeToken: async () => ({ token: "app.minted.jwt", expiresIn: 900, url: config.realtimeUrl,
    publishableKey: config.publishableKey }), heartbeat: async () => ({ online: true }) };
  const sync = { sync: async () => emptyCache(), setConnection: async () => emptyCache(), onRealtimeEvent: () => {} };
  const session = new RealtimeSession(config, api, sync);
  const internals = session as unknown as { refresh(): Promise<void>; client: SupabaseClient };
  await internals.refresh();
  await internals.client.realtime.setAuth();
  expect(internals.client.realtime.accessTokenValue).toBe("app.minted.jwt");
});

it("reconnects once after a close without tearing down the healthy replacement", async () => {
  vi.useFakeTimers();
  const config = { apiUrl: "https://a2a.example", realtimeUrl: "https://realtime.example", publishableKey: "sb_publishable_test",
    organizationId: randomUUID(), agentId: randomUUID(), hostType: "codex" as const };
  const channels: Array<{ emit(status: string): void; on: (...args: unknown[]) => unknown; subscribe: (callback: (status: string) => void) => void }> = [];
  const client = {
    realtime: { setAuth: async () => {} },
    channel: () => {
      let callback: ((status: string) => void) | undefined;
      const channel = { emit: (status: string) => callback?.(status), on: () => channel,
        subscribe: (handler: (status: string) => void) => { callback = handler; } };
      channels.push(channel);
      return channel;
    },
    removeChannel: async (channel: { emit(status: string): void }) => { channel.emit("CLOSED"); },
    removeAllChannels: async () => {},
  } as unknown as SupabaseClient;
  const api = { realtimeToken: async () => ({ token: "test-jwt", expiresIn: 900, url: config.realtimeUrl, publishableKey: config.publishableKey }),
    heartbeat: async () => ({ online: true }) };
  const sync = { sync: async () => emptyCache(), setConnection: async () => emptyCache(), onRealtimeEvent: () => {} };
  const session = new RealtimeSession(config, api, sync, client);
  await session.start();
  expect(channels).toHaveLength(1);
  channels[0]!.emit("SUBSCRIBED");
  channels[0]!.emit("CHANNEL_ERROR");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(channels).toHaveLength(2);
  channels[1]!.emit("SUBSCRIBED");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(channels).toHaveLength(2);
  await session.stop();
});
