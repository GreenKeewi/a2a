import { createHash, randomUUID } from "node:crypto";

import {
  AgentCard, Message, Role, TaskState, type Task, type SendMessageRequest, type GetTaskRequest,
  type ListTasksRequest, type ListTasksResponse, type CancelTaskRequest,
} from "@a2a-js/sdk";
import {
  ContentTypeNotSupportedError, PushNotificationNotSupportedError, RequestMalformedError,
  TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError, VersionNotSupportedError,
} from "@a2a-js/sdk/errors";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import type { Sql } from "postgres";

import { AgentError, sendAgentMessage, type AgentPrincipal } from "./agents";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const handlePattern = /^[A-Za-z][A-Za-z0-9-]{1,39}$/;
const tokenPattern = /^[^\x00-\x1f\x7f]{1,200}$/;
const messageTypes = new Set(["fyi", "question", "blocker", "decision", "handoff"]);

function deterministicUuid(clientAgentId: string, messageId: string) {
  const bytes = createHash("sha256").update(clientAgentId).update("\0").update(messageId).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function textPart(value: string) {
  return { content: { $case: "text" as const, value }, metadata: undefined, filename: "", mediaType: "text/plain" };
}

function protocolMessage(messageId: string, contextId: string, taskId: string, role: Role, body: string, subject: string): Message {
  return { messageId, contextId, taskId, role, parts: [textPart(body)],
    metadata: { subject }, extensions: [], referenceTaskIds: [] };
}

function messageBody(message: Message) {
  if (!tokenPattern.test(message.messageId) || message.role !== Role.ROLE_USER || !message.parts.length) {
    throw new RequestMalformedError();
  }
  const parts = message.parts.map((part) => {
    if (part.content?.$case !== "text" || (part.mediaType && part.mediaType !== "text/plain")) {
      throw new ContentTypeNotSupportedError();
    }
    return part.content.value;
  });
  const body = parts.join("\n").trim();
  if (!body || body.length > 8_000) throw new RequestMalformedError();
  return body;
}

function subjectFor(message: Message, body: string) {
  const supplied = message.metadata?.subject;
  const firstLine = body.split(/\r?\n/, 1)[0]!.trim();
  const subject = typeof supplied === "string" ? supplied.trim() :
    firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine;
  if (!subject || subject.length > 80 || /[\x00-\x1f\x7f]/.test(subject)) throw new RequestMalformedError();
  return subject;
}

function typeFor(message: Message) {
  const value = message.metadata?.type;
  return typeof value === "string" && messageTypes.has(value) ? value as "fyi" | "question" | "blocker" | "decision" | "handoff" : "question";
}

function checkContext(context: ServerCallContext, organizationId: string) {
  if (context.requestedVersion !== "1.0") throw new VersionNotSupportedError();
  if (context.tenant && context.tenant !== organizationId) throw new RequestMalformedError();
}

export function makeAgentCard(baseUrl: string, target?: { handle: string; role: string; organizationId: string }): AgentCard {
  const endpoint = target ? `/api/a2a/agents/${encodeURIComponent(target.handle)}/rpc` : "/api/a2a/rpc";
  return {
    name: target ? `${target.handle} via a2a` : "a2a coordination gateway",
    description: target ? `Deliver text coordination requests to ${target.handle}. Replies appear in the same task.` :
      "Deliver text coordination requests to an agent in your workspace. Set message.metadata.to to its handle.",
    supportedInterfaces: [{ url: new URL(endpoint, baseUrl).toString(), protocolBinding: "JSONRPC",
      protocolVersion: "1.0", tenant: target?.organizationId ?? "" }],
    provider: undefined, version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: { bearer: { scheme: { $case: "httpAuthSecurityScheme", value: {
      description: "Pair an a2a agent and use its revocable token.", scheme: "Bearer", bearerFormat: "a2a-agent-token",
    } } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    skills: [{ id: "coordinate", name: "Agent coordination", description: "Deliver a text request and retrieve the recipient agent's reply.",
      tags: ["coordination", "messaging"], examples: [], inputModes: ["text/plain"], outputModes: ["text/plain"],
      securityRequirements: [{ schemes: { bearer: { list: [] } } }] }],
    signatures: [],
  };
}

type TaskRow = Record<string, unknown>;

async function waitForAgentReply(read: () => Promise<TaskRow>, returnImmediately?: boolean) {
  let row = await read();
  if (returnImmediately || row.reply_id || row.canceled_at) return row;
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    row = await read();
    if (row.reply_id || row.canceled_at) break;
  }
  return row;
}

export class A2ABridgeHandler implements A2ARequestHandler {
  constructor(private readonly sql: Sql, private readonly principal: AgentPrincipal,
    private readonly card: AgentCard, private readonly fixedTarget?: string) {}

  async getAgentCard() { return this.card; }
  async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> { throw new UnsupportedOperationError(); }

  private async targetFor(message: Message, taskTarget?: string) {
    const requested = this.fixedTarget ?? message.metadata?.to ?? taskTarget;
    if (typeof requested !== "string" || !handlePattern.test(requested)) throw new RequestMalformedError();
    const rows = await this.sql`SELECT id, handle, role FROM agents
      WHERE organization_id = ${this.principal.organizationId} AND normalized_handle = ${requested.toLowerCase()}
        AND revoked_at IS NULL AND id <> ${this.principal.agentId}`;
    if (!rows[0]) throw new TaskNotFoundError();
    if (this.fixedTarget && message.metadata?.to && String(message.metadata.to).toLowerCase() !== requested.toLowerCase()) {
      throw new RequestMalformedError();
    }
    return { id: String(rows[0].id), handle: String(rows[0].handle) };
  }

  private async taskRow(id: string) {
    if (!uuidPattern.test(id)) throw new TaskNotFoundError();
    const rows = await this.sql`
      SELECT t.id, t.context_id, t.thread_id, t.initial_message_id, t.client_agent_id, t.target_agent_id,
        t.created_at, t.canceled_at, target.handle AS target_handle, read_receipt.read_at,
        reply.id AS reply_id, reply.body AS reply_body, reply.subject AS reply_subject, reply.created_at AS reply_at
      FROM a2a_tasks t JOIN agents target ON target.id = t.target_agent_id
      LEFT JOIN LATERAL (
        SELECT min(r.read_at) AS read_at FROM a2a_task_messages tm
        JOIN message_recipients r ON r.message_id = tm.message_id AND r.agent_id = t.target_agent_id
        WHERE tm.task_id = t.id
      ) read_receipt ON true
      LEFT JOIN LATERAL (
        SELECT m.id, m.body, m.subject, m.created_at
        FROM a2a_task_messages tm JOIN messages m ON m.reply_to_message_id = tm.message_id
        JOIN message_recipients r ON r.message_id = m.id AND r.agent_id = t.client_agent_id
        WHERE tm.task_id = t.id AND m.organization_id = t.organization_id AND m.thread_id = t.thread_id
          AND m.sender_agent_id = t.target_agent_id
        ORDER BY m.created_at ASC, m.id ASC LIMIT 1
      ) reply ON true
      WHERE t.id = ${id} AND t.organization_id = ${this.principal.organizationId}
        AND t.client_agent_id = ${this.principal.agentId}
        AND (${this.fixedTarget ?? null}::text IS NULL OR target.normalized_handle = ${this.fixedTarget?.toLowerCase() ?? null})
    `;
    if (!rows[0]) throw new TaskNotFoundError();
    return rows[0] as TaskRow;
  }

  private async materialize(row: TaskRow, historyLength?: number): Promise<Task> {
    const id = String(row.id);
    const contextId = String(row.context_id);
    const requests = await this.sql`SELECT m.id, m.body, m.subject, m.created_at FROM a2a_task_messages tm
      JOIN messages m ON m.id = tm.message_id WHERE tm.task_id = ${id}
      ORDER BY m.created_at ASC, m.id ASC LIMIT 100`;
    const history = requests.map((message) => protocolMessage(String(message.id), contextId, id, Role.ROLE_USER,
      String(message.body), String(message.subject)));
    if (row.reply_id) history.push(protocolMessage(String(row.reply_id), contextId, id, Role.ROLE_AGENT,
      String(row.reply_body), String(row.reply_subject)));
    const state = row.canceled_at ? TaskState.TASK_STATE_CANCELED : row.reply_id ? TaskState.TASK_STATE_COMPLETED :
      row.read_at ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_SUBMITTED;
    const timestamp = row.canceled_at ?? row.reply_at ?? row.read_at ?? row.created_at;
    const boundedHistory = historyLength === undefined ? history : historyLength <= 0 ? [] : history.slice(-Math.min(historyLength, 100));
    return { id, contextId, status: { state, message: row.reply_id && !row.canceled_at ? history.at(-1) : undefined,
      timestamp: timestamp instanceof Date ? timestamp.toISOString() : new Date(String(timestamp)).toISOString() },
      artifacts: row.reply_id && !row.canceled_at ? [{ artifactId: String(row.reply_id), name: "Agent reply",
        description: "Reply from the destination agent", parts: [textPart(String(row.reply_body))], metadata: undefined, extensions: [] }] : [],
      history: boundedHistory, metadata: { destination: String(row.target_handle) } };
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    checkContext(context, this.principal.organizationId);
    const message = params.message;
    if (!message) throw new RequestMalformedError();
    if (params.configuration?.acceptedOutputModes?.length &&
        !params.configuration.acceptedOutputModes.includes("text/plain")) throw new ContentTypeNotSupportedError();
    const body = messageBody(message);
    const subject = subjectFor(message, body);
    const replay = await this.sql`SELECT t.id, t.context_id, target.normalized_handle, m.body, m.subject
      FROM a2a_task_messages tm JOIN a2a_tasks t ON t.id = tm.task_id
      JOIN agents target ON target.id = t.target_agent_id JOIN messages m ON m.id = tm.message_id
      WHERE t.organization_id = ${this.principal.organizationId} AND t.client_agent_id = ${this.principal.agentId}
        AND tm.external_message_id = ${message.messageId} LIMIT 2`;
    if (replay.length > 1) throw new RequestMalformedError();
    if (replay[0]) {
      const bound = replay[0];
      if ((message.taskId && message.taskId !== String(bound.id)) ||
          (message.contextId && message.contextId !== String(bound.context_id)) ||
          (this.fixedTarget && this.fixedTarget.toLowerCase() !== String(bound.normalized_handle)) ||
          (message.metadata?.to && String(message.metadata.to).toLowerCase() !== String(bound.normalized_handle)) ||
          body !== String(bound.body) || subject !== String(bound.subject)) throw new RequestMalformedError();
      return this.materialize(await this.taskRow(String(bound.id)), params.configuration?.historyLength);
    }
    const existingTask = message.taskId ? await this.taskRow(message.taskId) : undefined;
    const target = await this.targetFor(message, existingTask ? String(existingTask.target_handle) : undefined);
    let threadId: string | undefined;
    let contextId = message.contextId || randomUUID();
    if (message.taskId) {
      if (!existingTask) throw new TaskNotFoundError();
      if (String(existingTask.target_agent_id) !== target.id ||
          (message.contextId && message.contextId !== String(existingTask.context_id))) throw new RequestMalformedError();
      if (existingTask.canceled_at || existingTask.reply_id) throw new UnsupportedOperationError();
      threadId = String(existingTask.thread_id);
      contextId = String(existingTask.context_id);
    } else {
      if (message.contextId && !tokenPattern.test(message.contextId)) throw new RequestMalformedError();
      if (message.contextId) {
        const found = await this.sql`SELECT thread_id FROM a2a_tasks WHERE organization_id = ${this.principal.organizationId}
          AND client_agent_id = ${this.principal.agentId} AND target_agent_id = ${target.id}
          AND context_id = ${contextId} ORDER BY created_at DESC LIMIT 1`;
        if (found[0]) threadId = String(found[0].thread_id);
      }
    }
    const submit = async (db: Sql, withinTransaction = false) => {
      try {
        return await sendAgentMessage(db, this.principal, { to: target.handle, type: typeFor(message), subject, body,
          clientMessageId: deterministicUuid(this.principal.agentId, message.messageId), ...(threadId ? { threadId } : {}) },
        withinTransaction);
      } catch (error) {
        if (error instanceof AgentError && error.code === "INVALID_REQUEST") throw new RequestMalformedError();
        if (error instanceof AgentError && (error.code === "NOT_FOUND" || error.code === "INVALID_ROUTE")) throw new TaskNotFoundError();
        throw error;
      }
    };
    if (existingTask) {
      const existingTaskId = String(existingTask.id);
      await this.sql.begin(async (tx) => {
        const locked = await tx`SELECT canceled_at FROM a2a_tasks WHERE id = ${existingTaskId}
          AND organization_id = ${this.principal.organizationId} AND client_agent_id = ${this.principal.agentId}
          FOR UPDATE`;
        if (!locked[0] || locked[0].canceled_at) throw new UnsupportedOperationError();
        const reply = await tx`SELECT 1 FROM a2a_task_messages tm JOIN messages m ON m.reply_to_message_id = tm.message_id
          JOIN message_recipients r ON r.message_id = m.id AND r.agent_id = ${this.principal.agentId}
          WHERE tm.task_id = ${existingTaskId} AND m.organization_id = ${this.principal.organizationId}
            AND m.thread_id = ${String(existingTask.thread_id)} AND m.sender_agent_id = ${target.id} LIMIT 1`;
        if (reply.length) throw new UnsupportedOperationError();
        const sent = await submit(tx as unknown as Sql, true);
        const priorBinding = await tx`SELECT task_id FROM a2a_task_messages WHERE message_id = ${sent.messageId}`;
        if (priorBinding[0] && String(priorBinding[0].task_id) !== existingTaskId) throw new RequestMalformedError();
        await tx`INSERT INTO a2a_task_messages (task_id, message_id, external_message_id)
          VALUES (${existingTaskId}, ${sent.messageId}, ${message.messageId}) ON CONFLICT (message_id) DO NOTHING`;
      });
      return this.materialize(await waitForAgentReply(() => this.taskRow(existingTaskId),
        params.configuration?.returnImmediately), params.configuration?.historyLength);
    }
    const persistedTaskId = await this.sql.begin(async (tx) => {
      const sent = await submit(tx as unknown as Sql, true);
      const stored = await tx`SELECT body, subject FROM messages WHERE id = ${sent.messageId}
        AND organization_id = ${this.principal.organizationId} AND sender_agent_id = ${this.principal.agentId}`;
      if (!stored[0] || String(stored[0].body) !== body || String(stored[0].subject) !== subject) {
        throw new RequestMalformedError();
      }
      const taskId = randomUUID();
      await tx`INSERT INTO a2a_tasks
        (id, organization_id, client_agent_id, target_agent_id, context_id, thread_id, initial_message_id)
        VALUES (${taskId}, ${this.principal.organizationId}, ${this.principal.agentId}, ${target.id},
          ${contextId}, ${sent.threadId}, ${sent.messageId}) ON CONFLICT (initial_message_id) DO NOTHING`;
      const task = await tx`SELECT id, target_agent_id, context_id FROM a2a_tasks WHERE initial_message_id = ${sent.messageId}
        AND organization_id = ${this.principal.organizationId} AND client_agent_id = ${this.principal.agentId}`;
      if (!task[0] || String(task[0].target_agent_id) !== target.id ||
          (message.contextId && String(task[0].context_id) !== message.contextId)) throw new RequestMalformedError();
      const boundTaskId = String(task[0].id);
      await tx`INSERT INTO a2a_task_messages (task_id, message_id, external_message_id)
        VALUES (${boundTaskId}, ${sent.messageId}, ${message.messageId}) ON CONFLICT (message_id) DO NOTHING`;
      return boundTaskId;
    });
    return this.materialize(await waitForAgentReply(() => this.taskRow(persistedTaskId),
      params.configuration?.returnImmediately), params.configuration?.historyLength);
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext) {
    checkContext(context, this.principal.organizationId);
    return this.materialize(await this.taskRow(params.id), params.historyLength);
  }

  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    checkContext(context, this.principal.organizationId);
    const pageSize = params.pageSize === undefined ? 50 : params.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RequestMalformedError();
    const offset = params.pageToken ? Number(Buffer.from(params.pageToken, "base64url").toString("utf8")) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new RequestMalformedError();
    const after = params.statusTimestampAfter ? new Date(params.statusTimestampAfter) : null;
    if (after && Number.isNaN(after.getTime())) throw new RequestMalformedError();
    const state = params.status === TaskState.TASK_STATE_UNSPECIFIED ? null : params.status;
    const rows = await this.sql`
      WITH visible AS (
        SELECT t.id, t.created_at, coalesce(t.canceled_at, reply.reply_at, read_receipt.read_at, t.created_at) AS status_at,
          CASE WHEN t.canceled_at IS NOT NULL THEN ${TaskState.TASK_STATE_CANCELED}
               WHEN reply.reply_at IS NOT NULL THEN ${TaskState.TASK_STATE_COMPLETED}
               WHEN read_receipt.read_at IS NOT NULL THEN ${TaskState.TASK_STATE_WORKING}
               ELSE ${TaskState.TASK_STATE_SUBMITTED} END AS state
        FROM a2a_tasks t JOIN agents target ON target.id = t.target_agent_id
        LEFT JOIN LATERAL (
          SELECT min(r.read_at) AS read_at FROM a2a_task_messages tm
          JOIN message_recipients r ON r.message_id = tm.message_id AND r.agent_id = t.target_agent_id
          WHERE tm.task_id = t.id
        ) read_receipt ON true
        LEFT JOIN LATERAL (
          SELECT m.created_at AS reply_at FROM a2a_task_messages tm
          JOIN messages m ON m.reply_to_message_id = tm.message_id
          JOIN message_recipients r ON r.message_id = m.id AND r.agent_id = t.client_agent_id
          WHERE tm.task_id = t.id AND m.organization_id = t.organization_id AND m.thread_id = t.thread_id
            AND m.sender_agent_id = t.target_agent_id
          ORDER BY m.created_at ASC, m.id ASC LIMIT 1
        ) reply ON true
        WHERE t.organization_id = ${this.principal.organizationId} AND t.client_agent_id = ${this.principal.agentId}
          AND (${this.fixedTarget ?? null}::text IS NULL OR target.normalized_handle = ${this.fixedTarget?.toLowerCase() ?? null})
          AND (${params.contextId || null}::text IS NULL OR t.context_id = ${params.contextId || null})
      ), filtered AS (
        SELECT id, created_at FROM visible
        WHERE (${state}::integer IS NULL OR state = ${state})
          AND (${after?.toISOString() ?? null}::timestamptz IS NULL OR status_at >= ${after?.toISOString() ?? null}::timestamptz)
      ), counted AS (SELECT count(*)::int AS total_size FROM filtered),
      paged AS (SELECT id, created_at FROM filtered ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${offset})
      SELECT counted.total_size, paged.id FROM counted LEFT JOIN paged ON true
      ORDER BY paged.created_at DESC NULLS LAST, paged.id DESC NULLS LAST
    `;
    const totalSize = Number(rows[0]?.total_size ?? 0);
    const page = await Promise.all(rows.filter((row) => row.id).map(async (row) =>
      this.materialize(await this.taskRow(String(row.id)), params.historyLength)));
    if (!params.includeArtifacts) for (const task of page) task.artifacts = [];
    return { tasks: page, pageSize, totalSize,
      nextPageToken: offset + pageSize < totalSize ? Buffer.from(String(offset + pageSize)).toString("base64url") : "" };
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext) {
    checkContext(context, this.principal.organizationId);
    const before = await this.taskRow(params.id);
    if (before.canceled_at || before.reply_id) throw new TaskNotCancelableError();
    await this.sql.begin(async (tx) => {
      const changed = await tx`UPDATE a2a_tasks t SET canceled_at = now() WHERE t.id = ${params.id}
        AND organization_id = ${this.principal.organizationId} AND client_agent_id = ${this.principal.agentId}
        AND canceled_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM a2a_task_messages tm JOIN messages reply ON reply.reply_to_message_id = tm.message_id
          JOIN message_recipients r ON r.message_id = reply.id AND r.agent_id = t.client_agent_id
          WHERE tm.task_id = t.id AND reply.organization_id = t.organization_id
            AND reply.thread_id = t.thread_id AND reply.sender_agent_id = t.target_agent_id
        ) RETURNING t.id`;
      if (!changed.length) throw new TaskNotCancelableError();
      await tx`UPDATE messages m SET response_state = 'cancelled', resolved_by_agent_id = ${this.principal.agentId}, resolved_at = now()
        FROM a2a_task_messages tm WHERE tm.message_id = m.id AND tm.task_id = ${params.id}
          AND m.organization_id = ${this.principal.organizationId} AND m.sender_agent_id = ${this.principal.agentId}
          AND m.response_state = 'open'`;
    });
    return this.materialize(await this.taskRow(params.id));
  }

  async *sendMessageStream(): AsyncGenerator<never> { throw new UnsupportedOperationError(); }
  async *resubscribe(): AsyncGenerator<never> { throw new UnsupportedOperationError(); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
}
