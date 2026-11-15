# a2a — Canonical Product and Build Plan

**Status:** ready to build  
**Updated:** 2026-11-15  
**This file is the single source of truth.** It replaces the earlier separate specification and implementation plan.

## 1. What we are building

`a2a` is a hosted coordination layer for coding agents. Claude Code and Codex agents working in the same project get:

- A durable inbox.
- Direct, group, and broadcast messaging.
- Low-latency notifications while they work.
- A compact shared briefing so they understand the project, ownership, recent decisions, and open blockers.
- A live dashboard where humans can observe and participate.

The product exists because agents at a hackathon could technically work at the same time but did not share enough context to build compatible pieces. Messaging alone is insufficient; the useful unit is **message + ownership + decision history + current project brief**.

### One-line pitch

> Connect Claude Code and Codex to one shared inbox and project briefing, then watch them coordinate live.

### MVP success test

Two people on different machines connect one Claude Code agent and one Codex agent. Codex sends a blocker with a file reference. Claude is notified, reads it, replies, and both people see the thread and receipt update live. Claude can disconnect, reconnect, and catch up without losing or duplicating a message.

## 2. Product principles

1. **Durable before live.** PostgreSQL is truth; Realtime is only a notification hint.
2. **Notify, then fetch.** Push IDs and subjects, never full bodies into model context.
3. **Four tools, not a toolbox.** Keep MCP metadata small and place richer context inside results only when needed.
4. **Shared context stays compact.** Brief, scopes, recent decisions, and open blockers fit in a bounded session briefing.
5. **No surprise token spend.** Never start or resume Claude or Codex automatically.
6. **Smart features advise.** Models may summarize or suggest; they never send, route, resolve, or modify messages autonomously.
7. **One install per repo.** `npx a2a init` configures the selected coding client without overwriting unrelated settings.
8. **A2A-aligned, then conformant.** Use Agent2Agent concepts internally, but claim protocol conformance only after the bridge passes compatibility tests.

## 3. What is in the MVP

### Core coordination

- Google sign-in.
- Workspaces and human invite codes.
- Separate agent pairing codes and revocable agent tokens.
- Named agents with role and owned scopes.
- Direct, multi-recipient, and broadcast threads.
- Typed messages: `blocker`, `question`, `handoff`, `decision`, `fyi`.
- Per-agent delivered and read receipts.
- Compact project briefing at session start.
- Project brief, recent decisions, agent scopes, and open questions/blockers.
- Human-to-agent messages from the dashboard.
- Online, idle, and offline presence.

### Dashboard

- Conversations and unread delivery state.
- Agent directory, role, scopes, host type, and presence.
- Editable project brief.
- Decision log and open blockers/questions.
- Invite, pairing, token, member, and workspace settings.
- Simple statistics.

### Explicitly not in the MVP

- Background auto-responders.
- Automatic code changes.
- A full task board or replacement for GitHub/Linear.
- File uploads or binary artifacts.
- Automatic file locking.
- Vector search.
- Public agent marketplace.
- Guaranteed wake-up of an idle model when its host does not expose a stable mechanism.

Tasks and contracts should initially be referenced by URL, issue ID, commit, file, or line range. If users later need a native task board or contract registry, add them from observed usage instead of guessing now.

### Product differentiation

- Hosted and cross-machine rather than a shared local SQLite or Git mailbox.
- A live human dashboard rather than agent-only logs.
- Shared brief, scopes, decisions, and open blockers rather than messaging without common context.
- Local sidecar delivery rather than asking every agent to poll manually.
- A deliberate path from Claude Code/Codex MCP clients to external Agent2Agent interoperability.

## 4. User and agent journeys

### Create or join a workspace

1. A person signs in with Google through Better Auth.
2. They create a workspace or enter a human invite code.
3. A workspace maps to a Better Auth organization with `owner` and `member` roles.
4. Owners manage human invite codes; members may connect and revoke their own agents.

Human invite codes:

- Format: `A2A-XXXX-XXXX-XXXX` using unambiguous Base32.
- 72 random bits before formatting.
- Hashed at rest.
- Default expiry: 24 hours.
- Default maximum uses: five.
- Revocable by an owner.

### Connect an agent

1. In the dashboard, choose **Connect agent**.
2. Enter handle, host (`claude-code` or `codex`), role, and optional owned scopes.
3. The server creates a one-time pairing code valid for ten minutes.
4. Run:

   ```text
   npx a2a init --code A2A-PAIR-XXXX-XXXX
   ```

5. The CLI exchanges the code for a random 256-bit agent token.
6. The token is stored outside the repository; only non-secret project configuration is written locally.
7. The CLI shows its planned config changes, merges MCP and hook settings, adds a managed instruction block, and verifies the connection.

Human invite codes and agent pairing codes are deliberately different. A leaked team invite must not become permanent machine access.

### Agent session startup

1. The host starts the local stdio MCP sidecar.
2. The sidecar authenticates, fetches unread headers, and subscribes to the agent's private Realtime topic.
3. A session-start hook reads the local cache and injects a briefing only if it is new.
4. The briefing contains, within a 400-token hard limit:
   - One-sentence project goal and stack.
   - The current agent's role and owned scopes.
   - Other active agents and their scopes.
   - Up to three recent decisions.
   - Open blockers/questions addressed to this agent.
5. Full message bodies remain out of context until the agent calls `a2a_read`.

### Send and receive

1. Sender calls `a2a_send`.
2. Sidecar assigns `clientMessageId` and calls the authenticated API.
3. The API resolves recipients and inserts thread, message, and receipt rows transactionally.
4. A database trigger broadcasts an IDs-only event to recipient and workspace topics.
5. Recipient sidecar fetches authorized unread headers and updates its local snapshot.
6. A host hook injects one compact notice at the next supported lifecycle point.
7. Recipient uses `a2a_inbox`, then `a2a_read`, and replies with `a2a_send` using the same thread.

### Offline behavior

- Messages remain queued in PostgreSQL.
- Startup and every reconnect perform cursor catch-up.
- The sidecar fetches before subscribing and once again after subscribing to close the race window.
- Duplicate events are harmless.
- Missing events do not lose messages.

## 5. Architecture

```text
Claude Code / Codex CLI
        |
        | stdio MCP + lifecycle hooks
        v
Local a2a sidecar
  - 4 MCP tools
  - local unread/briefing cache
  - heartbeat + reconnect
  - private Supabase Realtime subscription
        |                              ^
        | HTTPS reads/writes           | WebSocket notifications
        v                              |
Next.js app on Vercel ------------> Supabase
  - Better Auth                       - PostgreSQL source of truth
  - Google OAuth                      - private Realtime Broadcast
  - workspace + agent APIs            - triggers, RLS, SQL functions
  - dashboard
  - asynchronous smart worker
        |
        v
Vercel AI Gateway, optional
```

### Why this shape

- Vercel handles normal authenticated HTTP well but is not the dependency for a permanent per-agent stream.
- Sidecars and dashboards subscribe directly to private Supabase Realtime channels using short-lived JWTs minted by the app.
- All authoritative data reads and every durable mutation still pass through the web API.
- Hooks only read a local file, so they remain fast and work through temporary network failures.

## 6. Notification behavior

| Agent state | Claude Code | Codex CLI |
|---|---|---|
| Session starts/resumes | Session hook adds changed briefing | Session hook adds changed briefing |
| Working and calling tools | Post-tool hook adds changed urgent notice | Post-tool hook adds changed urgent notice |
| About to stop | Stop hook may continue once for unseen urgent mail | Stop hook may continue once for unseen urgent mail |
| Open but model idle | OS notification; experimental channels may be an opt-in flag | OS notification; model sees it at next supported hook |
| CLI closed | Durable queue; optional notification-only daemon | Durable queue; optional notification-only daemon |

The daemon, if shipped, may maintain connectivity and show desktop notifications. It must never run `claude`, `codex`, or another model command.

### Interruption policy

- `blocker`: high priority, notify mid-turn, one guarded Stop continuation.
- `question`: normal priority, notify mid-turn if explicitly high; otherwise at turn boundary.
- `handoff`: next turn boundary.
- `decision`: briefing and inbox, unless marked high.
- `fyi`: inbox only.

### Stop-loop guard

Continue only when an urgent unread message exists, its notification version has not already caused a continuation in this session, and the host indicates this Stop is not already hook-triggered. Otherwise allow Stop. Hook errors always fail open.

## 7. MCP interface

Expose exactly four tools.

### `a2a_send`

`Send a concise message to one or more workspace agents.`

```ts
type SendInput = {
  to: string | string[]; // handle, "*", or "owner:<scope>"
  type: "blocker" | "question" | "handoff" | "decision" | "fyi";
  subject: string;       // 1..80 characters
  body: string;          // recommended <=1600 chars; hard max 8000
  priority?: "low" | "normal" | "high";
  threadId?: string;
  replyTo?: string;
  refs?: Array<{
    kind: "file" | "commit" | "url" | "task";
    value: string;
    lineStart?: number;
    lineEnd?: number;
  }>;
};
```

Rules:

- Handles resolve case-insensitively inside the workspace.
- `*` means all active non-revoked agents except the sender.
- `owner:<scope>` resolves the single longest matching active scope claim.
- Ambiguous or missing routes fail before persistence.
- Result contains IDs, resolved handles, and sender unread count; it never echoes the body.

### `a2a_inbox`

`List unread or recent headers without loading message bodies.`

```ts
type InboxInput = {
  unreadOnly?: boolean; // default true
  limit?: number;       // default 10, max 25
  cursor?: string;
  includeBriefing?: boolean; // default false; sidecar uses true at session start
  types?: MessageType[];
  query?: string;       // optional full-text search, 2..80 characters
};
```

Returns compact headers. When `query` is present, it searches authorized message subjects, bodies, and decision summaries but still returns headers only. When requested, it also returns the bounded project briefing. Listing does not mark messages read.

### `a2a_read`

`Read one message or a compact thread and mark delivered content read.`

```ts
type ReadInput = {
  messageId?: string;
  threadId?: string;
  mode?: "message" | "thread";
};
```

Thread mode returns the rolling summary and latest four messages, not unlimited history.

### `a2a_agents`

`List agents, roles, scopes, and current presence.`

```ts
type AgentsInput = {
  onlineOnly?: boolean;
  scope?: string;
};
```

## 8. Token and context budgets

- Combined MCP descriptions: target under 220 tokens.
- Automatic notice: target under 35 tokens, hard maximum 60.
- Session briefing: target 250 tokens, hard maximum 400.
- Inbox: at most 25 headers and no bodies.
- Subject: 80 characters maximum.
- Body: warning above 1,600 characters, rejection above 8,000.
- Thread read: summary plus latest four messages.
- Cache only headers by default.

Notice format:

```text
📬 2 new · codex-api [blocker] Orders schema changed · run a2a_inbox
```

Additional rules:

- Notify only when unread state version changes.
- Send file paths, line ranges, commits, issue IDs, and URLs instead of pasted code.
- Tool results do not repeat input.
- Briefing is regenerated from structured data, not an ever-growing chat transcript.

## 9. Shared understanding layer

This is the key addition beyond a mailbox.

### Project brief

Humans maintain a concise workspace brief in the dashboard:

- Goal.
- Current milestone.
- Stack.
- Repository conventions.
- Important constraints.

The brief has a 2,000-character hard limit and version history. Only the current compact form enters session briefing.

### Roles and scopes

Each agent has:

- Handle.
- Host type.
- Short role.
- Owned scopes such as `/api/**`, `apps/web/**`, or `database-schema`.

Scopes support routing and warn about overlapping ownership. The MVP warns but does not block file edits.

### Decisions

Agents send `decision` messages. The dashboard displays a decision log sourced from those messages. Smart processing may propose a concise decision summary, but the original message remains authoritative.

### Open coordination items

`blocker` and `question` messages remain open until the sender or a human resolves or cancels them. Briefings prioritize items addressed to the current agent.

### Interface changes

Do not create a separate contract subsystem in the MVP. Send interface changes as `decision` or `handoff` messages with file, commit, schema, or URL references. This gives agents the necessary context without adding more MCP tools and database concepts.

## 10. Smart behavior

### Deterministic first

- Route by handle, broadcast, or `owner:<scope>`.
- Enforce priority floors for blockers.
- Track unresolved questions and blockers.
- Create dashboard reminders after configured thresholds.
- Build session briefing from structured records.
- Deduplicate sends with `clientMessageId`.
- Detect overlapping scope claims and show warnings.

### Optional model-assisted processing

Use Vercel AI SDK through AI Gateway with model name in `A2A_TRIAGE_MODEL`.

Allowed:

- Summarize a thread after six messages or approximately 1,500 tokens.
- Propose a one-sentence decision entry.
- Suggest a priority when omitted.
- Suggest likely scope owners when routing is ambiguous.
- Flag likely secrets for human review.

Forbidden:

- Auto-answering.
- Sending as an agent.
- Changing body or recipients.
- Resolving coordination items.
- Running code or tools.
- Blocking delivery on model failure.

Every generated field stores model, prompt version, source version, timestamp, and confidence. Turning smart processing off must leave core behavior unchanged.

## 11. Data model

Better Auth owns `user`, `session`, `account`, `verification`, `organization`, `member`, and any organization invitation tables it requires.

Application tables:

### `workspace_settings`

`organization_id`, `slug`, `display_name`, `timezone`, `brief`, `brief_version`, `smart_features_enabled`, timestamps.

### `workspace_brief_versions`

`id`, `organization_id`, `version`, `brief`, `created_by_user_id`, `created_at`.

### `workspace_invite_codes`

`id`, `organization_id`, `code_hash`, creator, expiry, maximum uses, use count, revocation, timestamps.

### `agents`

`id`, `organization_id`, creator, `handle`, normalized handle, host type, role, `scopes[]`, skills JSON, last seen, revocation, timestamps. Enforce one active normalized handle per workspace.

### `agent_pairing_codes`

`id`, `agent_id`, `code_hash`, expiry, used timestamp, created timestamp.

### `agent_tokens`

`id`, `agent_id`, `token_hash`, display prefix, last used, expiry, revocation, created timestamp.

### `threads`

`id`, `organization_id`, optional name, kind (`direct|group|broadcast`), rolling summary, summary-through message, summary version, last message, created timestamp.

### `thread_agent_members`

Composite key `thread_id + agent_id`, joined timestamp.

### `messages`

`id`, organization, thread, exactly one human or agent sender, optional `client_message_id`, optional reply, type, priority, subject, body, A2A-aligned parts JSON, requires-response flag, response state, resolver, created timestamp.

Unique `(sender_agent_id, client_message_id)` provides idempotency.

Maintain a PostgreSQL full-text search vector over subject and body with a GIN index. Search results remain workspace- and thread-authorized before ranking.

### `message_recipients`

Composite key `message_id + agent_id`, delivered, read, and last-notified timestamps. Index `(agent_id, read_at, message_id)`.

### `decision_records`

`id`, organization, source message, title, summary, status (`proposed|confirmed|superseded`), model metadata, timestamps.

### `rate_limit_buckets` and `audit_events`

Atomic fixed-window buckets plus security-relevant audit entries. Audit metadata excludes codes, tokens, and message bodies.

Use UUIDs, `timestamptz`, foreign keys, partial indexes for active credentials, transactions, and checked SQL migrations.

## 12. Authentication and authorization

### Humans

- Better Auth only; do not use Supabase Auth for people.
- Google is the only MVP provider.
- Better Auth organizations represent workspaces.
- Production and local callback URLs are explicit.
- Every server operation checks current organization membership.

### Agents

- Pairing returns plaintext token once.
- Store only SHA-256 hash plus display prefix.
- Token is scoped to one agent and organization.
- Revocation immediately blocks API and Realtime token minting.
- Never put credentials in repository files, process arguments, MCP results, analytics, or logs.

### Realtime

The API mints a 15-minute JWT with:

```text
sub
aud=authenticated
role=authenticated
principal_type=user|agent
organization_id
agent_id, for agent tokens
exp
```

Private topics:

- `agent:<agent_id>`
- `workspace:<organization_id>`

RLS compares topic IDs to JWT claims. Clients receive only; database triggers broadcast.

## 13. APIs and events

### Human routes

- Better Auth handler.
- Create workspace.
- Create/revoke human invite.
- Join workspace.
- Read/update project brief.
- Create/revoke agent.
- Create pairing code.
- Send human message.
- Resolve/cancel coordination item.
- Get stats.
- Mint user Realtime token.

### Agent routes

- Pair exchange.
- Send message.
- List inbox headers.
- Read message.
- Read compact thread.
- List agents.
- Fetch briefing.
- Heartbeat.
- Mint agent Realtime token.
- Revoke current token.

Every API response uses `{ data, error, requestId }` and stable safe error codes.

### Realtime event

```ts
type RealtimeEventV1 = {
  version: 1;
  event: "message.created" | "message.read" | "agent.presence" |
         "brief.updated" | "coordination.resolved" | "thread.updated";
  organizationId: string;
  agentId?: string;
  messageId?: string;
  threadId?: string;
  occurredAt: string;
};
```

Events contain identifiers only. Receivers fetch authorized data.

## 14. Sidecar design

Commands:

- `a2a init --code <pairing-code>`
- `a2a mcp`
- `a2a hook <event>`
- `a2a status`
- `a2a logout`
- Optional `a2a daemon`, notifications only

Startup sequence:

1. Validate project and credential configuration.
2. Start stdio MCP.
3. Fetch briefing and unread headers.
4. Subscribe to private agent topic.
5. Fetch unread headers again.
6. Heartbeat every 30 seconds.
7. Refresh Realtime JWT before expiry.
8. Reconnect with exponential backoff capped at 30 seconds plus jitter.

Local state:

- `.a2a/config.json`: API URL and project identity only.
- User credential store: agent token.
- User cache: cursor, at most 100 headers, briefing version, unread version, connection state.

Write cache atomically. On corruption, preserve the bad file for diagnostics, rebuild from API, and keep MCP available. Hooks make no network calls and target 100 ms with a 500 ms hard timeout.

## 15. Dashboard and stats

Routes:

- `/` — landing and Google sign-in.
- `/join` — human invite entry.
- `/w/:slug` — overview.
- `/w/:slug/inbox` — threads and composer.
- `/w/:slug/context` — project brief, scopes, decisions, blockers.
- `/w/:slug/agents` — connect, presence, scope, revoke.
- `/w/:slug/settings` — workspace, members, invites, smart toggle.

Overview cards:

- Agents online now.
- Messages in the last 24 hours.
- Unread agent deliveries.
- Open blockers/questions.

Additional simple stats:

- Messages by day for seven days.
- Agent activity: sent, received, unread, median first-response time.

Definitions:

- Online: heartbeat within 90 seconds.
- Idle: last seen 90 seconds to ten minutes.
- Open: response-required message with `response_state=open`.
- Response time: message creation to first direct recipient reply.
- Median: PostgreSQL `percentile_cont(0.5)` over the selected range.

Do not show “tokens saved” until measurements are defensible.

UI should be compact and calm, with desktop split-view conversations and mobile list-to-thread navigation. Design loading, empty, error, disconnected, revoked, dialog, and populated states. Use keyboard-accessible controls, visible focus, product design tokens, Playwright, and lintapple at phone and desktop sizes.

## 16. Agent2Agent protocol strategy

Claude Code and Codex are MCP clients, not public A2A servers. The hub acts as the bridge.

Internal mapping:

| a2a product | Agent2Agent protocol |
|---|---|
| Agent profile | Agent Card |
| Message body/refs | Message Parts |
| Thread ID | `contextId` |
| Delegated work thread | Task |
| Output reference | Artifact/Part |

After the messaging MVP works:

1. Pin a stable A2A specification and official SDK version.
2. Publish gateway and agent-specific Agent Cards that point to real endpoints.
3. Expose authenticated A2A message/task endpoints.
4. Convert incoming A2A messages into normal durable inbox records.
5. Map sidecar replies back into the external context/task.
6. Add streaming and push only after basic request/response compatibility passes.
7. State the exact supported protocol version and capabilities.

Do not publish Agent Cards pointing to endpoints that are not implemented.

## 17. Security, reliability, and observability

### Security requirements

- Hash human invites, pairing codes, and agent tokens.
- Use constant-time comparison.
- Validate every input with shared schemas.
- Derive organization from the authenticated principal.
- Reject absolute paths, parent traversal, and control characters in file refs.
- Redact authorization, cookies, OAuth data, codes, tokens, and bodies from logs.
- Add CSRF protection and secure cookies for human mutations.
- Add CSP, frame, MIME, referrer, and transport headers.
- Audit membership, invite, pairing, token, scope, brief, and revocation changes.
- Rate-limit invite/pair attempts, sends, reads, and token minting.

### Reliability rules

- Transactional writes.
- At-least-once notifications, exactly-once persistence by idempotency key.
- Stable `(created_at, id)` cursors.
- Cursor catch-up after every reconnect.
- Smart-worker failure never affects delivery.
- Forward-only tested migrations.

### Metrics

- Send success and p95 latency.
- Broadcast-to-fetch latency.
- Sidecar connection/reconnect count.
- Unread backlog.
- Invite/pair failures by safe reason.
- Smart-job latency, cost, and failure.
- Notification deduplication.

Initial targets:

- Connected notification p95 under five seconds.
- Send API 99.9% success excluding validation/caller errors.
- Dashboard server response p95 under one second excluding OAuth.

## 18. Repository structure

```text
.
├── apps/web/
│   ├── src/app/                 # Next.js pages and route handlers
│   ├── src/components/          # shared UI
│   ├── src/features/            # auth, workspaces, agents, messages, context, stats
│   └── src/lib/                 # db, security, realtime, logging
├── packages/protocol/           # schemas, API types, events, cursors
├── packages/sidecar/            # CLI, MCP, sync, cache, hooks, host adapters
├── packages/testkit/            # factories and service fixtures
├── supabase/migrations/         # schema, functions, triggers, RLS
├── supabase/tests/              # SQL tests
├── e2e/                         # cross-host and browser acceptance tests
├── docs/runbooks/               # local, deploy, security, incident response
├── ui-policy.json
└── PLAN.md
```

Use Node 22+, pnpm workspaces, ESM, strict TypeScript, Drizzle, Zod, Vitest, Playwright, and lintapple. Pin exact versions in the lockfile.

## 19. Build sequence

Each phase must finish with working tests and a review before the next phase.

### Phase 0 — Foundation

Build:

- pnpm monorepo and packages.
- Shared TypeScript config and quality scripts.
- Next.js app shell.
- lintapple policy and Playwright setup.
- Shared API envelope, message schemas, cursor, and event types.

Exit criteria:

- Install, typecheck, unit test, and production build pass.
- Protocol tests reject body/subject overflow, malformed cursors, unsafe refs, and unknown event versions.

### Phase 1 — Database and human access

Build:

- Better Auth Drizzle schema, Google provider, organization plugin.
- Application schema and indexes.
- Workspace create/join.
- Hashed human invite codes with atomic use counting.
- Project brief and version history.

Exit criteria:

- Concurrent final invite use has one winner.
- Removed/non-member users cannot access workspace data.
- Fresh and upgrade migration tests pass.

### Phase 2 — Agent identity and durable messaging

Build:

- Agent creation, roles, scopes, and overlap warning.
- Pairing exchange and revocable hashed tokens.
- Direct, group, broadcast, and scope-owner routing.
- Threads, recipients, inbox headers, read receipts, decisions, and open coordination state.
- Heartbeat and agent directory.

Exit criteria:

- Pair replay fails.
- Duplicate send returns the original message ID.
- Cross-workspace IDs reveal no data.
- Group/broadcast receipt state is independent per agent.

### Phase 3 — Realtime and sidecar

Build:

- Realtime JWT issuance and RLS topic isolation.
- Database Broadcast triggers.
- CLI config, credential store, API client, and local cache.
- Catch-up-first sync engine, heartbeat, refresh, and reconnect.

Exit criteria:

- Agent A cannot subscribe to agent B or another workspace.
- Dropped event is recovered by cursor catch-up.
- No token or pairing code exists in generated repo files or logs.
- Connected notification p95 is measured under five seconds locally.

### Phase 4 — MCP and host notifications

Build:

- Four MCP tools over stdio.
- Claude Code and Codex config adapters.
- Session, prompt, post-tool, and Stop hooks.
- Managed `CLAUDE.md`/`AGENTS.md` block.
- Status and logout commands.

Managed instruction text:

```text
Use a2a for cross-agent coordination. Check a2a_inbox when notified, before changing another agent's scope, and before ending work with an open handoff. Keep messages concise and reference files or commits instead of pasting code. Blockers and questions require a reply; FYIs do not.
```

Exit criteria:

- A test MCP client discovers exactly four tools.
- Send acknowledgments never echo bodies.
- Hook reruns do not duplicate notices.
- One urgent Stop continuation occurs; a second does not.
- Existing host config is merged and remains valid.
- No hook launches a model process.

### Phase 5 — Dashboard and statistics

Build:

- Landing, join, workspace shell, inbox, context, agents, settings.
- Live workspace subscription and targeted refetch.
- Human composer.
- Brief editor, scopes, decisions, blockers, invites, pairing, revocation.
- Four cards, seven-day chart, and activity table.

Exit criteria:

- New message appears without refresh.
- Seeded statistics match SQL fixtures, including timezone boundaries.
- Public and authenticated empty/populated/error/dialog states pass Playwright and lintapple at phone and desktop sizes.
- Keyboard and focus paths pass.

### Phase 6 — Smart layer

Build:

- Provider-neutral AI Gateway client.
- Thread summaries and proposed decisions.
- Scope-owner suggestions and secret warnings.
- Deterministic escalation reminders.

Exit criteria:

- Smart-disabled behavior is identical for send, inbox, read, and notification.
- Timeout or malformed model output cannot mutate or delay a message.
- Generated fields contain provenance and can be ignored.

### Phase 7 — A2A bridge

Build:

- Pinned protocol version.
- Real Agent Card endpoints.
- Authenticated message/task gateway.
- Context/task mapping and compatibility suite.

Exit criteria:

- Official compatibility tests pass for every claimed capability.
- Product copy names the exact supported version.

### Phase 8 — Release hardening

Build:

- CI gates for typecheck, lint, tests, migrations, build, Playwright, lintapple.
- Cross-machine acceptance harness.
- Deployment, rollback, key rotation, and incident runbooks.
- Structured logs and operational metrics.

Production verification:

1. Confirm exact Git revision and Vercel deployment.
2. Confirm migration version and private Realtime configuration.
3. Complete real Google sign-in.
4. Join a second account by invite.
5. Pair real Claude Code and Codex agents.
6. Exchange, read, reply, and observe dashboard updates.
7. Disconnect and prove catch-up.
8. Retry and prove idempotency.
9. Revoke token and prove API plus Realtime denial.

## 20. Model and work-splitting strategy

### Recommended team

| Responsibility | Model | Effort |
|---|---|---|
| Primary implementation | Codex with GPT-6.1 Sol | high |
| Independent phase review | Claude Code with Opus 5.5 | medium for routine phases, high for auth/realtime/hooks |
| Final security and architecture review | GPT-6 Astra or Opus 5.5 | xhigh/max |
| Mechanical follow-up fixes | GPT-6.1 Sol | low/medium after findings are confirmed |

GPT-6.1 Sol owns implementation continuity. Opus provides a genuinely independent review instead of competing edits. Astra or maximum-effort Opus is reserved for the small number of areas where a subtle mistake would compromise workspace isolation, credentials, delivery guarantees, or unattended token usage.

Do not run Opus 5.5 at Low for an entire phase involving authentication, SQL/RLS, Realtime, hooks, credential storage, or reconnect logic. Low effort is acceptable only for bounded mechanical work whose interface and tests already exist.

### Core working rule

> One model writes a phase; another model reviews it. They do not edit the same checkout concurrently.

This prevents merge conflicts and stops architectural decisions from drifting between agents. The reviewer is read-only until it returns findings. The primary builder validates each finding against code and tests before changing anything.

### Phase ownership

| Phase | Primary builder | Reviewer | Special focus |
|---|---|---|---|
| 0 — Foundation | Sol high | Opus medium | repository boundaries, schemas, quality gates |
| 1 — Database and humans | Sol high | Opus high | Better Auth, invite races, organization isolation |
| 2 — Agents and messages | Sol high | Opus high | token handling, idempotency, recipient authorization |
| 3 — Realtime and sidecar | Sol high | Opus high, then Astra targeted review | JWT claims, RLS topics, reconnect/catch-up, credential leakage |
| 4 — MCP and hooks | Sol high | Opus high | current Claude/Codex schemas, Stop-loop guard, context budget |
| 5 — Dashboard and stats | Sol high | Opus medium/high | actual user journey, live states, stats correctness, UI quality |
| 6 — Smart layer | Sol high | Opus high | asynchronous isolation, provenance, model failure behavior |
| 7 — A2A bridge | Sol high | Opus high or Astra high | pinned protocol mapping and truthful capability claims |
| 8 — Release hardening | Sol high | Astra xhigh/max plus Opus high | full threat model, deployment chain, cross-machine proof |

### Phase loop

Repeat this sequence for every phase:

1. Create a branch named `codex/a2a-phase-<number>-<slug>` from the last accepted phase.
2. Start a fresh Codex chat with GPT-6.1 Sol on high.
3. Tell it to read `PLAN.md` and implement only the selected phase.
4. Codex writes failing tests, implements the minimum complete phase, runs the phase checks, and creates a clean commit.
5. Stop implementation. Do not begin the next phase.
6. Give Opus the plan section, base commit, head commit, diff, and test output in a fresh read-only review session.
7. Opus returns evidence-backed findings with severity, file, line, failure mode, and expected behavior. It does not edit.
8. Codex evaluates each finding, fixes confirmed issues, adds regression tests, and reruns all affected checks.
9. Opus performs a short re-review only on the fixes and unresolved findings.
10. Merge or fast-forward the accepted phase, then begin the next phase from that revision.

Never carry uncommitted changes from one phase into the next. A phase is accepted only when its exit criteria pass and all blocking/high review findings are resolved or explicitly documented with a reason.

### Handoff packet

Every builder-to-reviewer handoff contains:

```text
Phase:
Plan section:
Base commit:
Head commit:
Files changed:
Tests run and exact result:
Exit criteria checked:
Known limitations:
Unresolved questions:
```

Do not include secrets, tokens, OAuth values, full environment files, or production message bodies. The reviewer should inspect the actual diff rather than relying only on the builder's summary.

### Review format

Each review finding must contain:

- Severity: blocking, high, normal, or suggestion.
- Exact file and line.
- Concrete failure scenario.
- Which plan requirement or invariant it violates.
- Evidence that the issue survives existing code/tests.
- Smallest acceptable fix or missing regression test.

If a suspected issue is refuted by code, schema constraints, or a test, the reviewer records the refutation and drops it. The builder must not blindly implement speculative feedback.

### Safe parallel work

The default is sequential. Parallel work is allowed only after Phase 2 freezes shared contracts and only in separate worktrees.

The one useful parallel window is:

- **Codex worktree:** dashboard shell and human workflows that consume frozen mock interfaces.
- **Claude worktree:** sidecar host-template research, fixture design, and read-only compatibility tests.

During this window:

- Neither agent changes `packages/protocol`, database migrations, auth, API route contracts, or shared configuration.
- Each worktree has a declared file ownership list.
- Claude does not implement production sidecar behavior unless ownership is explicitly transferred.
- Codex integrates both tracks after review and runs cross-package tests.

Do not parallelize database schema, auth, Realtime authorization, or message semantics. Those subsystems share invariants and need one implementation owner.

### Reasoning-effort policy

Use **high** for phase implementation by default.

Escalate to **xhigh/max** only for:

- Realtime JWT and RLS isolation.
- Credential storage and revocation.
- Invite/pair race conditions.
- Idempotency and reconnect correctness.
- Stop-hook loop prevention.
- Final threat review and deployment verification.

Use **low/medium** only for:

- Scaffolding already defined by the plan.
- Mechanical type fixes.
- Snapshot updates after a verified schema change.
- UI copy or styling fixes with existing browser tests.
- Applying already-confirmed review findings.

### Builder prompt

```text
Read PLAN.md completely. Implement only Phase <N>: <name> on a new
codex/a2a-phase-<N>-<slug> branch. Treat the phase exit criteria and global
product principles as requirements. Write failing tests before production
behavior, preserve unrelated work, and do not start a later phase. Run every
check required by this phase. When finished, commit the phase and report the
base/head revisions, files changed, exact test results, exit criteria, known
limitations, and any unresolved questions. Do not deploy or use production
credentials.
```

### Reviewer prompt

```text
Review Phase <N> of PLAN.md as a read-only reviewer. Compare <base>..<head>
and inspect surrounding authorization, schema, and error paths. Do not edit.
Prioritize cross-workspace isolation, credential leakage, race conditions,
idempotency, reconnect behavior, context/token budgets, and the phase exit
criteria. Report only evidence-backed findings with severity, exact file/line,
failure scenario, violated requirement, why current tests do not refute it,
and the smallest acceptable fix or regression test. Record and drop refuted
candidates.
```

### Final red-team prompt

```text
Perform a final adversarial review of the completed a2a MVP against PLAN.md.
Use attacker/victim framing. Try to cross workspace boundaries, replay invites
and pairing codes, reuse revoked tokens, subscribe to foreign Realtime topics,
duplicate sends, lose messages across reconnects, inject unsafe refs or prompt
content, leak secrets through logs/config/tool output, and trigger infinite
Stop-hook continuations. Also verify that deployment evidence proves the real
Google sign-in and Claude-to-Codex flow rather than only a green build. Do not
edit; return ranked evidence-backed findings and explicit refutations.
```

## 21. Test matrix

### Unit

- Schemas, routing, hashing, priority, cursors, briefing budget, notification formatting, Stop guard, stats definitions.

### Database/integration

- Auth organization boundaries.
- Invite/pair races.
- Idempotent send.
- Inbox pagination and receipts.
- Brief versioning.
- Realtime JWT/RLS isolation.
- Broadcast event shape.
- Smart failure fallback.

### Sidecar

- stdio MCP contract.
- Startup/reconnect catch-up.
- Duplicate/missing events.
- Atomic and corrupt cache handling.
- Windows/macOS/Linux paths.
- Host config snapshots and hook fixtures.

### Browser

- Sign-in state, join, connect, copy once, revoke.
- Inbox live update and human send.
- Brief and scope edits.
- Stats fixtures.
- Empty/loading/error/disconnected states.
- Phone/desktop, keyboard, focus, accessibility, lintapple.

### Threat regression

- Foreign workspace IDs and topics.
- Removed member.
- Revoked agent.
- Pair replay.
- Invite brute force/rate limit.
- Unsafe refs.
- Seeded secrets in logs and generated files.
- Prompt-injection text treated only as untrusted message content.

## 22. Release boundary

The first useful release is Phases 0–5 plus the core portions of Phase 8. Do not delay it for model-assisted intelligence or the external Agent2Agent bridge.

The initial product should prove one thing exceptionally well:

> Claude Code and Codex can maintain a shared understanding, message each other across machines, and reliably notice and retrieve new work without wasting context.

## 23. Locked decisions

- Name: `a2a`.
- Web: Next.js on Vercel.
- Data and realtime: Supabase PostgreSQL + private Realtime Broadcast.
- Human auth: Better Auth + Google.
- Team access: Google session + human invite code.
- Agent access: separate pairing code + revocable token.
- Integration: local stdio MCP sidecar.
- MCP tools: four.
- Shared context: brief + scopes + decisions + open coordination items.
- Automatic background responder: no.
- Smart model actions: advisory and asynchronous only.
- Native task board/contracts/file locks: later, only if validated.
- External Agent2Agent bridge: after the messaging MVP.
- Implementation owner: Codex GPT-6.1 Sol on high, one phase at a time.
- Independent reviewer: Opus 5.5 on medium/high; Astra or max-effort Opus for final security review.
- Concurrent editing of the same checkout: prohibited.

## 24. Non-blocking decisions before public launch

- Final domain.
- Publishable npm scope; workspace packages may use private names until chosen.
- Whether only owners or all members can create human invites; default to owners.
- Whether to ship the notification-only daemon in the first public release.
- Retention, export, and workspace deletion defaults.
- Pricing and quotas.

## 25. Primary references

- [Agent2Agent protocol specification](https://a2a-protocol.org/dev/specification/agent-card/)
- [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Better Auth Google provider](https://better-auth.com/docs/authentication/google)
- [Better Auth organizations](https://better-auth.com/docs/plugins/organization)
- [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)
- [Supabase serverless database connections](https://supabase.com/docs/guides/database/connecting-to-postgres/serverless-drivers)
- [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)
- [Supabase database Broadcast](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)

