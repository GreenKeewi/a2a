import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth-schema";

const date = (name: string) => timestamp(name, { withTimezone: true });
const id = (name: string) => uuid(name).defaultRandom().primaryKey();

export const workspaceSettings = pgTable("workspace_settings", {
  organizationId: uuid("organization_id").primaryKey().references(() => organization.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  brief: text("brief").notNull().default(""),
  briefVersion: integer("brief_version").notNull().default(0),
  smartFeaturesEnabled: boolean("smart_features_enabled").notNull().default(false),
  createdAt: date("created_at").notNull().defaultNow(),
  updatedAt: date("updated_at").notNull().defaultNow(),
}, (table) => [check("workspace_brief_length", sql`char_length(${table.brief}) <= 2000`)]);

export const workspaceBriefVersions = pgTable("workspace_brief_versions", {
  id: id("id"),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  brief: text("brief").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => user.id),
  createdAt: date("created_at").notNull().defaultNow(),
}, (table) => [uniqueIndex("brief_organization_version_uq").on(table.organizationId, table.version)]);

export const workspaceInviteCodes = pgTable("workspace_invite_codes", {
  id: id("id"),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => user.id),
  expiresAt: date("expires_at").notNull(),
  maximumUses: integer("maximum_uses").notNull(),
  useCount: integer("use_count").notNull().default(0),
  revokedAt: date("revoked_at"),
  createdAt: date("created_at").notNull().defaultNow(),
}, (table) => [
  index("invite_organization_idx").on(table.organizationId),
  check("invite_uses_valid", sql`${table.maximumUses} > 0 AND ${table.useCount} >= 0 AND ${table.useCount} <= ${table.maximumUses}`),
]);

export const agents = pgTable("agents", {
  id: id("id"),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => user.id),
  handle: text("handle").notNull(),
  normalizedHandle: text("normalized_handle").notNull(),
  hostType: text("host_type").notNull(),
  role: text("role").notNull(),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  skills: jsonb("skills").notNull().default({}),
  lastSeenAt: date("last_seen_at"),
  revokedAt: date("revoked_at"),
  createdAt: date("created_at").notNull().defaultNow(),
  updatedAt: date("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("agent_active_handle_uq").on(table.organizationId, table.normalizedHandle).where(sql`${table.revokedAt} IS NULL`),
  index("agent_organization_idx").on(table.organizationId),
]);

export const agentPairingCodes = pgTable("agent_pairing_codes", {
  id: id("id"),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: date("expires_at").notNull(),
  usedAt: date("used_at"),
  createdAt: date("created_at").notNull().defaultNow(),
}, (table) => [index("pairing_agent_idx").on(table.agentId)]);

export const agentTokens = pgTable("agent_tokens", {
  id: id("id"),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  displayPrefix: text("display_prefix").notNull(),
  lastUsedAt: date("last_used_at"),
  expiresAt: date("expires_at"),
  revokedAt: date("revoked_at"),
  createdAt: date("created_at").notNull().defaultNow(),
}, (table) => [index("token_active_agent_idx").on(table.agentId).where(sql`${table.revokedAt} IS NULL`)]);

export const threads = pgTable("threads", {
  id: id("id"),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name"),
  kind: text("kind").notNull(),
  rollingSummary: text("rolling_summary"),
  summaryThroughMessageId: uuid("summary_through_message_id"),
  summaryVersion: integer("summary_version").notNull().default(0),
  lastMessageAt: date("last_message_at"),
  createdAt: date("created_at").notNull().defaultNow(),
}, (table) => [
  index("thread_organization_last_idx").on(table.organizationId, table.lastMessageAt),
  check("thread_kind_valid", sql`${table.kind} IN ('direct','group','broadcast')`),
]);

export const threadAgentMembers = pgTable("thread_agent_members", {
  threadId: uuid("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  joinedAt: date("joined_at").notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.threadId, table.agentId] }), index("thread_member_agent_idx").on(table.agentId)]);

export const messages = pgTable("messages", {
  id: id("id"),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  threadId: uuid("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  senderUserId: uuid("sender_user_id").references(() => user.id),
  senderAgentId: uuid("sender_agent_id").references(() => agents.id),
  clientMessageId: text("client_message_id"),
  replyToMessageId: uuid("reply_to_message_id"),
  type: text("type").notNull(),
  priority: text("priority").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  parts: jsonb("parts").notNull().default([]),
  requiresResponse: boolean("requires_response").notNull().default(false),
  responseState: text("response_state").notNull().default("none"),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => user.id),
  resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id),
  resolvedAt: date("resolved_at"),
  createdAt: date("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("message_sender_client_id_uq").on(table.senderAgentId, table.clientMessageId).where(sql`${table.clientMessageId} IS NOT NULL`),
  index("message_org_created_idx").on(table.organizationId, table.createdAt, table.id),
  index("message_thread_created_idx").on(table.threadId, table.createdAt, table.id),
  check("message_exactly_one_sender", sql`num_nonnulls(${table.senderUserId}, ${table.senderAgentId}) = 1`),
  check("message_subject_length", sql`char_length(${table.subject}) BETWEEN 1 AND 80`),
  check("message_body_length", sql`char_length(${table.body}) BETWEEN 1 AND 8000`),
]);

export const messageRecipients = pgTable("message_recipients", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  deliveredAt: date("delivered_at"),
  readAt: date("read_at"),
  lastNotifiedAt: date("last_notified_at"),
}, (table) => [primaryKey({ columns: [table.messageId, table.agentId] }), index("recipient_agent_unread_idx").on(table.agentId, table.readAt, table.messageId)]);

export const decisionRecords = pgTable("decision_records", {
  id: id("id"),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  sourceMessageId: uuid("source_message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull().default("proposed"),
  modelMetadata: jsonb("model_metadata"),
  createdAt: date("created_at").notNull().defaultNow(),
  updatedAt: date("updated_at").notNull().defaultNow(),
}, (table) => [index("decision_organization_idx").on(table.organizationId, table.createdAt)]);

export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").notNull(),
  windowStart: date("window_start").notNull(),
  count: integer("count").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.key, table.windowStart] })]);

export const auditEvents = pgTable("audit_events", {
  id: id("id"),
  organizationId: uuid("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => user.id),
  actorAgentId: uuid("actor_agent_id").references(() => agents.id),
  action: text("action").notNull(),
  targetId: text("target_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: date("created_at").notNull().defaultNow(),
}, (table) => [index("audit_organization_created_idx").on(table.organizationId, table.createdAt)]);
