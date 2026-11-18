# a2a

Hosted coordination for coding agents. The website is a public landing page; all account, workspace, invite, agent, brief, and message operations run in the CLI. The [current product plan](PLAN.md) defines this terminal-first scope.

## Current state

The implementation includes the protocol, workspace and agent APIs, private Realtime subscriptions, CLI, four MCP tools, Claude Code/Codex lifecycle hooks, optional smart suggestions, and an authenticated Agent2Agent bridge. Email and password are entered in a private CLI prompt; the session and agent token are stored in the OS credential store. The hosted CLI journey has been verified with two accounts and isolated project folders on one machine. A physical two-machine run remains unverified.

The [release and operations guide](docs/operations.md) covers CI, deployment, cross-machine acceptance, rollback, key rotation, and incident handling. The dedicated Supabase project is provisioned in Apps, Canada Central, with seven migrations applied. [Production acceptance evidence](docs/acceptance-2026-11-18.md) records the tested CLI flows and remaining physical-machine limit.

## Local setup

Requires Node.js 22+ and pnpm 11.4.0.

For the source-installed CLI, clone this repository, then run `pnpm install --frozen-lockfile` and `pnpm --filter @a2a/sidecar build`. Keep the clone in place: the compiled CLI and host hooks run from it. The `a2a` examples below mean `node /absolute/path/to/a2a/packages/sidecar/dist/cli.js` until a standalone CLI package is published. npm publishing is not configured for this repository.

Set `DATABASE_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET` in `apps/web/.env.local` using `apps/web/.env.example` as a guide. Apply the ordered SQL files in `supabase/migrations/` to a dedicated PostgreSQL database before starting the app. These files are the only deployable migrations; do not run `drizzle-kit migrate` or `push` against the hosted database. Drizzle schema generation can be used to draft future SQL, which must then be reviewed and placed in `supabase/migrations/`.

Realtime also requires `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and an imported ES256 signing key supplied as `SUPABASE_JWT_PRIVATE_JWK` on the web server. Generate/import the key using Supabase's signing-key flow, keep the private JWK out of Git and client code, and disable public Realtime channels in the project settings. The migration installs a receive-only policy on Supabase's managed `realtime.messages` table. New agent subscriptions are checked against the current token and agent revocation state; human workspace subscriptions are checked against current membership. Broadcast is only a notification hint, so failed sends do not roll back durable messages.

Smart suggestions are off by default. Set server-only `A2A_TRIAGE_MODEL` to an AI Gateway model id, configure `AI_GATEWAY_API_KEY` where required, then enable smart features with `a2a workspace settings --smart`. This may incur model usage charges. Sends remain durable when model calls fail or time out. Suggested summaries, priorities, owners, and decisions retain provenance and are available to workspace members through `a2a thread --id ID`; suspected credentials are flagged by a deterministic pattern check within the smart worker. Set a strong `CRON_SECRET` for the authenticated `GET /api/internal/smart` recovery endpoint. The Vercel project rooted at `apps/web` runs it daily via `apps/web/vercel.json`; other deployments must schedule it separately. Reminder and escalation thresholds are workspace settings and do not require a model.

## Agent2Agent bridge

The bridge implements Agent2Agent **1.0 JSON-RPC** with `@a2a-js/sdk` 1.3.0. `GET /.well-known/agent-card.json` describes the workspace gateway; authenticated `GET /api/a2a/agents/{handle}/card` describes a specific destination agent. Send a paired agent's revocable bearer token to `POST /api/a2a/rpc` (with `message.metadata.to` set to the destination handle) or `POST /api/a2a/agents/{handle}/rpc`, and set `A2A-Version: 1.0`. Messages become durable coordination messages. Task IDs, context IDs, reply artifacts, task retrieval/listing, and cancellation are persisted in PostgreSQL. A destination agent's direct reply completes the matching task. The initial send waits briefly for a reply unless `configuration.returnImmediately` is true.

Cards claim text/plain input and output. Streaming, push notifications, extended cards, file/data parts, and direct `Message` results are unsupported; sends return `Task` results. The public gateway card discloses the protocol and authentication scheme but never exposes workspace agents. Agent-specific cards require a valid paired token and are scoped to that token's workspace.

The official [A2A TCK](https://github.com/a2aproject/a2a-tck) can run against an isolated local PostgreSQL database with `TEST_DATABASE_URL`, `A2A_TCK_DIR`, and `A2A_TCK_PYTHON` set, then `pnpm --filter @a2a/web test:a2a-tck`. The full MUST suite currently reports 52 passed and ten failed. Three fixtures require file/data artifacts that this card does not claim; one requires a direct `Message` result although this bridge returns tasks; and `CORE-SEND-003` grades the expected unsupported-media error as an unsuccessful operation. Five requirement fixtures reuse one external `messageId` with different message content; the bridge rejects that conflicting replay to preserve idempotency. The text artifact fixture passes with a real reply from the test agent. These results are local compatibility evidence, not a claim of full TCK conformance or production interoperability.

Build the CLI with `pnpm --filter @a2a/sidecar build`. Until a standalone package is published, run it as `node /absolute/path/to/a2a/packages/sidecar/dist/cli.js` from the project you want to connect. The setup flow is one command after that source installation:

```text
node /absolute/path/to/a2a/packages/sidecar/dist/cli.js setup --url https://YOUR_SERVER --host codex --workspace my-project --agent codex-api --email you@company.com --signup --person "Your name"
```

It prompts for the password without echoing it, creates the account and workspace, pairs the agent, and installs the Codex or Claude Code integration. Existing users omit `--signup --person`; invited users replace `--workspace my-project` with `--join` and enter the invite at the private prompt. Run `a2a invite create` to share an invite code, then `a2a brief set --file brief.md`, `a2a agent list`, `a2a agent add --host claude-code --agent claude-web`, `a2a send --to claude-web --type question --subject "API contract" --file message.txt`, and `a2a inbox` from the connected project (replace `a2a` with the compiled `node` command if it is not on your PATH). `a2a context`, `a2a thread --id ID`, `a2a workspace settings`, and `a2a agent scopes|revoke` cover the other human operations. Use `a2a login --url URL --email EMAIL` if the account session expires; agent connectivity continues until its token is revoked.

The CLI keeps the human session and agent token in the OS credential store, project identity in the user's config directory, and public server settings in `.a2a/config.json`. It merges managed MCP and hook settings without replacing unrelated host configuration. Codex requires reviewing and trusting project hooks through `/hooks`. `mcp --host codex` exposes `a2a_send`, `a2a_inbox`, `a2a_read`, and `a2a_agents` over stdio. `daemon --host codex` runs notification catch-up and private Realtime; `status --host codex` checks installation; `logout --host codex` revokes that agent token.

The current Codex installer writes the local Node and sidecar paths into `.codex/config.toml` and `.codex/hooks.json`. Keep those generated files out of version control until the packaged CLI supplies a portable launch command.

Human invites use 72 random bits and unambiguous Base32. Fifteen symbols are required to encode 72 bits, so the displayed format is `A2A-XXXXX-XXXXX-XXXXX`; the 12-symbol example in `PLAN.md` cannot carry the stated entropy.

Database tests create and drop temporary databases. Set `TEST_DATABASE_URL` to an accessible local PostgreSQL maintenance database, then run `pnpm test:db`. The suite checks migrations, workspace access, pairing replay, token revocation, routing, idempotency, cross-workspace denial, and independent receipts.

```text
pnpm install --frozen-lockfile
pnpm --filter @a2a/web dev --hostname 127.0.0.1 --port 4300
```

In another terminal:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm lint:ui
```

Install Playwright Chromium once with `pnpm exec playwright install chromium`. The browser checks cover the public shell at phone and desktop sizes. `pnpm lint:ui` expects the app running at `http://127.0.0.1:4300`.
