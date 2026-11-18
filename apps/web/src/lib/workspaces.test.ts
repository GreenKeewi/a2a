import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInviteCode,
  readWorkspace,
  redeemInviteCode,
  updateProjectBrief,
} from "./workspaces";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname)) {
  throw new Error("TEST_DATABASE_URL must point to a local PostgreSQL instance");
}

const databaseName = `a2a_phase1_${randomUUID().replaceAll("-", "")}`;
const ownerId = randomUUID();
const inviteeAId = randomUUID();
const inviteeBId = randomUUID();
const removedId = randomUUID();
const alphaId = randomUUID();
const betaId = randomUUID();
const admin = postgres(adminUrl, { max: 2, prepare: false });
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const sql = postgres(databaseUrl.toString(), { max: 10, prepare: false });
const migrationDirectory = resolve(import.meta.dirname, "../../../../supabase/migrations");

async function migrate() {
  const names = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    await sql.unsafe(await readFile(resolve(migrationDirectory, name), "utf8"));
  }
}

async function seedUser(id: string) {
  await sql`INSERT INTO "user" (id, name, email) VALUES (${id}, ${id}, ${`${id}@example.test`})`;
}

async function seedWorkspace(id: string, slug: string, creatorId: string) {
  await sql`INSERT INTO organization (id, name, slug, created_at) VALUES (${id}, ${slug}, ${slug}, now())`;
  await sql`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${randomUUID()}, ${id}, ${creatorId}, 'owner', now())`;
}

beforeAll(async () => {
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$`);
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await sql.unsafe("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated");
  await migrate();
  await Promise.all([seedUser(ownerId), seedUser(inviteeAId), seedUser(inviteeBId), seedUser(removedId)]);
  await seedWorkspace(alphaId, "alpha", ownerId);
  await seedWorkspace(betaId, "beta", inviteeBId);
}, 60_000);

afterAll(async () => {
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("workspace access", () => {
  it("creates a CLI account and workspace through cookie-authenticated HTTP routes", async () => {
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:4300";
    process.env.BETTER_AUTH_SECRET = "local-testing-secret-with-32-plus-characters";
    const authRoute = await import("../app/api/auth/[...all]/route");
    const email = `cli-${randomUUID()}@example.test`;
    const signedUp = await authRoute.POST(new Request("http://127.0.0.1:4300/api/auth/sign-up/email", {
      method: "POST", headers: { origin: "http://127.0.0.1:4300", "content-type": "application/json" },
      body: JSON.stringify({ name: "CLI Owner", email, password: "a-long-test-password-for-cli" }),
    }));
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers.getSetCookie().map((value) => value.split(";", 1)[0])
      .find((value) => value?.startsWith("better-auth.session_token="));
    expect(cookie).toBeTruthy();
    const workspaceRoute = await import("../app/api/workspaces/route");
    const slug = `cli-${randomUUID().slice(0, 8)}`;
    const created = await workspaceRoute.POST(new Request("http://127.0.0.1:4300/api/workspaces", {
      method: "POST", headers: { origin: "http://127.0.0.1:4300", cookie: cookie!, "content-type": "application/json" },
      body: JSON.stringify({ name: "CLI Workspace", slug }),
    }));
    expect(created.status).toBe(200);
    expect((await created.json()).data.slug).toBe(slug);
    const owner = await sql`SELECT m.role FROM member m JOIN organization o ON o.id = m.organization_id WHERE o.slug = ${slug}`;
    expect(owner[0]?.role).toBe("owner");
  }, 60_000);

  it("provisions settings when Better Auth creates an organization", async () => {
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:4300";
    process.env.BETTER_AUTH_SECRET = "local-testing-secret-with-32-plus-characters";
    const { auth } = await import("./auth");
    const created = await auth.api.createOrganization({
      body: { name: "Plugin Workspace", slug: "plugin-workspace", userId: ownerId },
    });
    expect(created).not.toBeNull();
    expect((await readWorkspace(sql, created!.id, ownerId)).displayName).toBe("Plugin Workspace");
    const audit = await sql`SELECT action FROM audit_events WHERE organization_id = ${created!.id} ORDER BY created_at`;
    expect(audit.map((row) => row.action)).toContain("workspace.created");
    const route = await import("../app/api/auth/[...all]/route");
    for (const path of ["invite-member", "accept-invitation", "update-member-role", "delete", "create"]) {
      const request = new Request(`http://127.0.0.1:4300/api/auth/organization/${path}`, { method: "POST" });
      expect((await route.POST(request)).status).toBe(404);
    }
    expect((await route.GET(new Request("http://127.0.0.1:4300/api/auth/organization/list"))).status).toBe(404);
    expect((await route.POST(new Request("http://127.0.0.1:4300/api/auth/organization%2Finvite-member", { method: "POST" }))).status).toBe(404);
    expect((await route.GET(new Request("http://127.0.0.1:4300/api/auth/get-session"))).status).toBe(200);
    const { createWorkspaceSchema } = await import("./workspace-inputs");
    expect(createWorkspaceSchema.safeParse({ name: "Reserved", slug: "join" }).success).toBe(false);
    const { respond } = await import("./http");
    const duplicate = await respond(() => auth.api.createOrganization({
      body: { name: "Duplicate", slug: "plugin-workspace", userId: ownerId },
    }));
    expect(duplicate.status).toBe(409);
  }, 60_000);

  it("lets exactly one concurrent claimant use the final invite", async () => {
    const code = await createInviteCode(sql, alphaId, ownerId, { maxUses: 1, expiresInHours: 24 });
    expect(code).toMatch(/^A2A-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    const [a, b] = await Promise.allSettled([
      redeemInviteCode(sql, code, inviteeAId),
      redeemInviteCode(sql, code, inviteeBId),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rows = await sql`SELECT use_count FROM workspace_invite_codes WHERE code_hash = encode(sha256(${code}::bytea), 'hex')`;
    expect(rows[0]?.use_count).toBe(1);
  });

  it("defaults invite codes to five uses and 24 hours", async () => {
    const code = await createInviteCode(sql, alphaId, ownerId);
    const rows = await sql`
      SELECT maximum_uses, extract(epoch from (expires_at - created_at)) / 3600 AS hours
      FROM workspace_invite_codes WHERE code_hash = encode(sha256(${code}::bytea), 'hex')
    `;
    expect(rows[0]?.maximum_uses).toBe(5);
    expect(Number(rows[0]?.hours)).toBeCloseTo(24, 1);
  });

  it("returns an HTTP conflict when the same user races two valid invites", async () => {
    const [first, second] = await Promise.all([
      createInviteCode(sql, alphaId, ownerId),
      createInviteCode(sql, alphaId, ownerId),
    ]);
    const { respond } = await import("./http");
    const responses = await Promise.all([
      respond(() => redeemInviteCode(sql, first, removedId)),
      respond(() => redeemInviteCode(sql, second, removedId)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await sql`DELETE FROM member WHERE organization_id = ${alphaId} AND user_id = ${removedId}`;
  });

  it("checks current membership on every read and write", async () => {
    await expect(readWorkspace(sql, alphaId, removedId)).rejects.toThrow("FORBIDDEN");
    await expect(updateProjectBrief(sql, alphaId, removedId, "No access")).rejects.toThrow("FORBIDDEN");
    await sql`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${randomUUID()}, ${alphaId}, ${removedId}, 'member', now())`;
    expect((await readWorkspace(sql, alphaId, removedId)).organizationId).toBe(alphaId);
    await expect(createInviteCode(sql, alphaId, removedId)).rejects.toThrow("FORBIDDEN");
    await expect(updateProjectBrief(sql, alphaId, removedId, "Not an owner")).rejects.toThrow("FORBIDDEN");
    await sql`DELETE FROM member WHERE organization_id = ${alphaId} AND user_id = ${removedId}`;
    await expect(readWorkspace(sql, alphaId, removedId)).rejects.toThrow("FORBIDDEN");
    await expect(readWorkspace(sql, betaId, ownerId)).rejects.toThrow("FORBIDDEN");
  });

  it("stores immutable, ordered brief versions", async () => {
    const first = await updateProjectBrief(sql, alphaId, ownerId, "First goal");
    const second = await updateProjectBrief(sql, alphaId, ownerId, "Second goal");
    expect([first.version, second.version]).toEqual([1, 2]);
    const history = await sql`SELECT version, brief FROM workspace_brief_versions WHERE organization_id = ${alphaId} ORDER BY version`;
    expect(history.map((row) => [row.version, row.brief])).toEqual([[1, "First goal"], [2, "Second goal"]]);
    await expect(updateProjectBrief(sql, alphaId, ownerId, "x".repeat(2001))).rejects.toThrow("INVALID_BRIEF");
  });
});

it("upgrades a populated initial schema without losing an existing organization", async () => {
  const upgradeName = `a2a_upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${upgradeName}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${upgradeName}`;
  const upgradeSql = postgres(url.toString(), { max: 2, prepare: false });
  try {
    await upgradeSql.unsafe("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated");
    await upgradeSql.unsafe(await readFile(resolve(migrationDirectory, "202611150001_initial_schema.sql"), "utf8"));
    const userId = randomUUID();
    const organizationId = randomUUID();
    await upgradeSql`INSERT INTO "user" (id, name, email) VALUES (${userId}, 'Owner', 'upgrade@example.test')`;
    await upgradeSql`INSERT INTO organization (id, name, slug, created_at) VALUES (${organizationId}, 'Existing', 'existing', now())`;
    await upgradeSql`INSERT INTO member (id, user_id, organization_id, role, created_at) VALUES (${randomUUID()}, ${userId}, ${organizationId}, 'owner', now())`;
    await upgradeSql.unsafe(await readFile(resolve(migrationDirectory, "202611150002_access_and_search.sql"), "utf8"));
    expect((await readWorkspace(upgradeSql, organizationId, userId)).displayName).toBe("Existing");
    const policy = await upgradeSql`
      SELECT c.relname, c.relrowsecurity,
             has_table_privilege('anon', c.oid, 'SELECT') AS anon_read,
             has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_read
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `;
    expect(policy).toHaveLength(20);
    expect(policy.every((row) => row.relrowsecurity && !row.anon_read && !row.authenticated_read)).toBe(true);
    await upgradeSql.unsafe("CREATE TABLE default_grant_probe (id integer)");
    const defaults = await upgradeSql`
      SELECT has_table_privilege('anon', 'default_grant_probe', 'SELECT') AS anon_read,
             has_table_privilege('authenticated', 'default_grant_probe', 'SELECT') AS authenticated_read
    `;
    expect(defaults[0]?.anon_read).toBe(false);
    expect(defaults[0]?.authenticated_read).toBe(false);
  } finally {
    await upgradeSql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${upgradeName}" WITH (FORCE)`);
  }
}, 60_000);
