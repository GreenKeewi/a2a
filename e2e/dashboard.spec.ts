import { expect, test, type Page } from "@playwright/test";
import { expectUI } from "lintapple/playwright";

const workspace = { organizationId: "11111111-1111-4111-8111-111111111111", slug: "demo", displayName: "Project Atlas", timezone: "America/Toronto", brief: "Ship the API and UI together.", briefVersion: 2, smartFeaturesEnabled: false, role: "owner" };
const agents = [{ id: "22222222-2222-4222-8222-222222222222", handle: "codex-api", hostType: "codex", role: "API builder", scopes: ["apps/api/**"], presence: "online", lastSeenAt: "2026-11-16T15:00:00Z" }];
const inbox = [{ threadId: "33333333-3333-4333-8333-333333333333", subject: "Schema handoff", preview: "Please review the schema.", sender: "Owner", type: "question", lastMessageAt: "2026-11-16T15:00:00Z", openCount: 1, participants: ["codex-api"], name: null }];
const thread = { threadId: inbox[0]!.threadId, name: null, summary: null, messages: [{ id: "44444444-4444-4444-8444-444444444444", sender: "Owner", senderType: "human", type: "question", priority: "normal", subject: "Schema handoff", body: "Please review the schema.", responseState: "open", createdAt: "2026-11-16T15:00:00Z", readCount: 0, recipientCount: 1 }] };
const stats = { cards: { agentsOnline: 1, messages24h: 1, unreadDeliveries: 1, openItems: 1 }, days: ["10", "11", "12", "13", "14", "15", "16"].map((day) => ({ day: `2026-11-${day}`, count: day === "16" ? 1 : 0 })), activity: [{ id: agents[0]!.id, handle: "codex-api", role: "API builder", sent: 0, received: 1, unread: 1, medianResponseSeconds: null }] };

async function mockDashboard(page: Page, populated = true) {
  await page.route("**/api/workspaces/demo**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("/realtime-token") ? null : path.endsWith("/stats") ? (populated ? stats : { ...stats, cards: { agentsOnline: 0, messages24h: 0, unreadDeliveries: 0, openItems: 0 }, days: stats.days.map((day) => ({ ...day, count: 0 })), activity: [] }) : path.endsWith("/inbox") ? (populated ? inbox : []) : path.includes("/threads/") ? thread : path.endsWith("/agents") ? (populated ? agents : []) : path.endsWith("/context") ? { brief: workspace.brief, briefVersion: 2, decisions: [{ id: "decision", title: "Use SQL migrations", summary: "Apply reviewed migrations.", status: "confirmed" }], openItems: populated ? [{ id: thread.messages[0]!.id, thread_id: thread.threadId, type: "question", subject: "Schema handoff", body: "Please review the schema.", sender: "Owner" }] : [] } : path.endsWith("/settings") ? { workspace, members: [{ name: "Owner", email: "owner@example.test", role: "owner" }] } : path.endsWith("/invites") ? [] : workspace;
    await route.fulfill({ status: path.endsWith("/realtime-token") ? 503 : 200, contentType: "application/json", body: JSON.stringify({ data, error: path.endsWith("/realtime-token") ? { code: "UNAVAILABLE" } : null }) });
  });
}

test("dashboard routes render populated and empty states", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await mockDashboard(page);
  for (const [path, heading] of [["", "Overview"], ["context", "Context"], ["agents", "Agents"], ["settings", "Settings"]]) {
    await page.goto(`/w/demo/${path}`);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    if (path === "") await page.screenshot({ path: testInfo.outputPath("overview.png"), fullPage: true });
    await expectUI(page, testInfo);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await page.goto("/w/demo/inbox");
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Schema handoff/ }).first().click();
  await expect(page.getByText("Please review the schema.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inbox.png"), fullPage: true });
  await expectUI(page, testInfo);
  await mockDashboard(page, false);
  await page.goto("/w/demo");
  await expect(page.getByText("Connect an agent to see its activity here.")).toBeVisible();
  await expectUI(page, testInfo);
});

test("human controls send, pair, invite, and save context", async ({ page }) => {
  test.setTimeout(90_000);
  await mockDashboard(page);
  await page.route("**/api/workspaces/demo/messages", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { threadId: thread.threadId }, error: null }) });
    else await route.continue();
  });
  await page.route("**/api/workspaces/demo/brief", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { version: 3 }, error: null }) }));
  await page.route("**/api/workspaces/demo/agents/*/pairing", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { code: "A2A-PAIR-TEST-CODE" }, error: null }) }));
  await page.route("**/api/workspaces/demo/invites", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: route.request().method() === "POST" ? { code: "A2A-TEST-INVITE-CODE" } : [], error: null }) }));
  await page.goto("/w/demo/inbox");
  await page.getByRole("button", { name: "New message" }).click();
  await page.getByLabel("Send to").selectOption("codex-api");
  await page.getByLabel("Subject").fill("New handoff");
  await page.getByLabel("Message").fill("Please review the endpoint.");
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/workspaces/demo/messages") && request.method() === "POST");
  await page.getByRole("button", { name: /Send message/ }).click();
  expect((await sent).postDataJSON()).toMatchObject({ to: "codex-api", subject: "New handoff", body: "Please review the endpoint." });
  await page.goto("/w/demo/context");
  await page.getByRole("textbox", { name: "Project brief" }).fill("Updated shared brief.");
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/workspaces/demo/brief") && request.method() === "PATCH");
  await page.getByRole("button", { name: "Save brief" }).click();
  expect((await saved).postDataJSON()).toEqual({ brief: "Updated shared brief." });
  await page.goto("/w/demo/agents");
  await page.getByRole("button", { name: "Pair device" }).click();
  await expect(page.getByText("A2A-PAIR-TEST-CODE")).toBeVisible();
  await page.goto("/w/demo/settings");
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByText("A2A-TEST-INVITE-CODE")).toBeVisible();
});

test("public entry shows signed-out state", async ({ page }, testInfo) => {
  await page.route("**/api/workspaces", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ data: null, error: { code: "UNAUTHENTICATED" } }) }));
  await page.goto("/join");
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expectUI(page, testInfo);
});
