import { randomUUID } from "node:crypto";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";

import { AgentApi, ApiError } from "./api.js";
import { createMcpServer } from "./mcp.js";

it("exposes exactly four tools and never echoes the sent body", async () => {
  const api = {
    send: async () => ({ messageId: randomUUID(), threadId: randomUUID(), recipientHandles: ["codex"], senderUnreadCount: 0 }),
    inbox: async () => ({ items: [], nextCursor: null }),
    read: async () => ({ body: "authorized read" }),
    agents: async () => [],
  } as unknown as Parameters<typeof createMcpServer>[0];
  const server = createMcpServer(api);
  const client = new Client({ name: "a2a-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["a2a_agents", "a2a_inbox", "a2a_read", "a2a_send"]);
    const sent = await client.callTool({ name: "a2a_send", arguments: {
      to: "codex", type: "fyi", subject: "MCP send", body: "secret body that must stay out of the ack",
    } });
    expect(sent.isError).not.toBe(true);
    expect(JSON.stringify(sent)).not.toContain("secret body");
    expect(JSON.stringify(sent)).toContain("messageId");
  } finally {
    await client.close();
    await server.close();
  }
});

it("rejects an API acknowledgment that tries to echo a message body", async () => {
  const api = new AgentApi({ apiUrl: "https://a2a.example", realtimeUrl: "https://realtime.example",
    publishableKey: "public", organizationId: randomUUID(), agentId: randomUUID(), hostType: "codex" }, "token");
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({
    data: { messageId: randomUUID(), threadId: randomUUID(), recipientHandles: ["codex"], senderUnreadCount: 0,
      body: "untrusted echoed body" }, error: null, requestId: randomUUID(),
  }) }));
  try {
    await expect(api.send({ to: "codex", type: "fyi", subject: "Test", body: "untrusted echoed body" }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" } satisfies Partial<ApiError>);
  } finally { vi.unstubAllGlobals(); }
});
