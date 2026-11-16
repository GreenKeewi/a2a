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
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
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
  it("provisions settings when Better Auth creates an organization", async () => {
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:4300";
    process.env.BETTER_AUTH_SECRET = "local-testing-secret-with-32-plus-characters";
    process.env.GOOGLE_CLIENT_ID = "local-placeholder";
    process.env.GOOGLE_CLIENT_SECRET = "local-placeholder";
    const { auth } = await import("./auth");
    const created = await auth.api.createOrganization({
      body: { name: "Plugin Workspace", slug: "plugin-workspace", userId: ownerId },
    });
    expect(created).not.toBeNull();
    expect((await readWorkspace(sql, created!.id, ownerId)).displayName).toBe("Plugin Workspace");
  });

  it("lets exactly one concurrent claimant use the final invite", async () => {
    const code = await createInviteCode(sql, alphaId, ownerId, { maxUses: 1, expiresInHours: 24 });
    const [a, b] = await Promise.allSettled([
      redeemInviteCode(sql, code, inviteeAId),
      redeemInviteCode(sql, code, inviteeBId),
    ]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rows = await sql`SELECT use_count FROM workspace_invite_codes WHERE code_hash = encode(sha256(${code}::bytea), 'hex')`;
    expect(rows[0]?.use_count).toBe(1);
  });

  it("checks current membership on every read and write", async () => {
    await expect(readWorkspace(sql, alphaId, removedId)).rejects.toThrow("FORBIDDEN");
    await expect(updateProjectBrief(sql, alphaId, removedId, "No access")).rejects.toThrow("FORBIDDEN");
    await sql`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${randomUUID()}, ${alphaId}, ${removedId}, 'member', now())`;
    expect((await readWorkspace(sql, alphaId, removedId)).organizationId).toBe(alphaId);
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
    await upgradeSql.unsafe(await readFile(resolve(migrationDirectory, "202611150001_initial_schema.sql"), "utf8"));
    const userId = randomUUID();
    const organizationId = randomUUID();
    await upgradeSql`INSERT INTO "user" (id, name, email) VALUES (${userId}, 'Owner', 'upgrade@example.test')`;
    await upgradeSql`INSERT INTO organization (id, name, slug, created_at) VALUES (${organizationId}, 'Existing', 'existing', now())`;
    await upgradeSql`INSERT INTO member (id, user_id, organization_id, role, created_at) VALUES (${randomUUID()}, ${userId}, ${organizationId}, 'owner', now())`;
    await upgradeSql.unsafe(await readFile(resolve(migrationDirectory, "202611150002_access_and_search.sql"), "utf8"));
    expect((await readWorkspace(upgradeSql, organizationId, userId)).displayName).toBe("Existing");
    const policy = await upgradeSql`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.workspace_settings'::regclass`;
    expect(policy[0]?.relrowsecurity).toBe(true);
  } finally {
    await upgradeSql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${upgradeName}" WITH (FORCE)`);
  }
}, 60_000);
