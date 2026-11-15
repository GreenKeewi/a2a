import { z } from "zod";

export const messageTypeSchema = z.enum(["blocker", "question", "handoff", "decision", "fyi"]);
export const messagePrioritySchema = z.enum(["low", "normal", "high"]);
export type MessageType = z.infer<typeof messageTypeSchema>;
export type MessagePriority = z.infer<typeof messagePrioritySchema>;

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: false });
const controlCharacters = /[\u0000-\u001f\u007f]/;

function isSafeRelativeFile(value: string): boolean {
  if (!value || controlCharacters.test(value) || /^[a-zA-Z]:/.test(value) || /^[\\/]/.test(value)) {
    return false;
  }
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export const messageRefSchema = z.strictObject({
  kind: z.enum(["file", "commit", "url", "task"]),
  value: z.string().min(1).max(2048),
  lineStart: z.int().positive().optional(),
  lineEnd: z.int().positive().optional(),
}).superRefine((ref, context) => {
  if (controlCharacters.test(ref.value) || (ref.kind === "file" && !isSafeRelativeFile(ref.value))) {
    context.addIssue({ code: "custom", message: "Unsafe reference value", path: ["value"] });
  }
  if (ref.kind === "url" && (!URL.canParse(ref.value) || !["https:", "http:"].includes(new URL(ref.value).protocol))) {
    context.addIssue({ code: "custom", message: "Reference URL must use HTTP or HTTPS", path: ["value"] });
  }
  if ((ref.lineStart || ref.lineEnd) && ref.kind !== "file") {
    context.addIssue({ code: "custom", message: "Line ranges require a file reference" });
  }
  if (ref.lineEnd !== undefined && (ref.lineStart === undefined || ref.lineEnd < ref.lineStart)) {
    context.addIssue({ code: "custom", message: "Invalid line range", path: ["lineEnd"] });
  }
});
export type MessageRef = z.infer<typeof messageRefSchema>;

const recipient = z.string().trim().min(1).max(100);
export const sendInputSchema = z.strictObject({
  to: z.union([recipient, z.array(recipient).min(1).max(25)]),
  type: messageTypeSchema,
  subject: z.string().max(80).trim().min(1),
  body: z.string().max(8000).trim().min(1),
  priority: messagePrioritySchema.optional(),
  threadId: uuid.optional(),
  replyTo: uuid.optional(),
  refs: z.array(messageRefSchema).max(20).optional(),
});
export type SendInput = z.infer<typeof sendInputSchema>;

export const inboxInputSchema = z.strictObject({
  unreadOnly: z.boolean().default(true),
  limit: z.int().min(1).max(25).default(10),
  cursor: z.string().refine((value) => {
    try { decodeCursor(value); return true; } catch { return false; }
  }, "Invalid cursor").optional(),
  includeBriefing: z.boolean().default(false),
  types: z.array(messageTypeSchema).min(1).optional(),
  query: z.string().trim().min(2).max(80).optional(),
});
export type InboxInput = z.infer<typeof inboxInputSchema>;

export const readInputSchema = z.strictObject({
  messageId: uuid.optional(),
  threadId: uuid.optional(),
  mode: z.enum(["message", "thread"]).default("message"),
}).superRefine((input, context) => {
  if (input.mode === "message" && (!input.messageId || input.threadId)) {
    context.addIssue({ code: "custom", message: "Message mode needs only messageId" });
  }
  if (input.mode === "thread" && (!input.threadId || input.messageId)) {
    context.addIssue({ code: "custom", message: "Thread mode needs only threadId" });
  }
});
export type ReadInput = z.infer<typeof readInputSchema>;

export const agentsInputSchema = z.strictObject({
  onlineOnly: z.boolean().default(false),
  scope: z.string().trim().min(1).max(200).optional(),
});
export type AgentsInput = z.infer<typeof agentsInputSchema>;

const cursorSchema = z.strictObject({ createdAt: timestamp, id: uuid });
export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(cursorSchema.parse(value))).toString("base64url");
}

export function decodeCursor(encoded: string): Cursor {
  if (encoded.length === 0 || encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid cursor");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new Error("Invalid cursor");
  }
  try {
    return cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
  } catch {
    throw new Error("Invalid cursor");
  }
}

export const realtimeEventSchema = z.strictObject({
  version: z.literal(1),
  event: z.enum([
    "message.created", "message.read", "agent.presence", "brief.updated",
    "coordination.resolved", "thread.updated",
  ]),
  organizationId: uuid,
  agentId: uuid.optional(),
  messageId: uuid.optional(),
  threadId: uuid.optional(),
  occurredAt: timestamp,
});
export type RealtimeEventV1 = z.infer<typeof realtimeEventSchema>;

export const apiErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.union([
    z.strictObject({ data: dataSchema, error: z.null(), requestId: uuid }),
    z.strictObject({ data: z.null(), error: apiErrorSchema, requestId: uuid }),
  ]);
}
