# a2a

Hosted coordination for coding agents. The [canonical product plan](PLAN.md) defines the scope and phase gates.

## Current state

Phases 0–4 provide the protocol, workspace and agent APIs, private Realtime subscriptions, sidecar, four MCP tools, and Claude Code/Codex lifecycle hooks. The code remains local; hosted Google sign-in, live Realtime subscription, dashboard, and deployment are later gates.

## Local setup

Requires Node.js 22+ and pnpm 11.4.0.

Set `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in `apps/web/.env.local` using `apps/web/.env.example` as a guide. Google must authorize `<BETTER_AUTH_URL>/api/auth/callback/google`. Apply the ordered SQL files in `supabase/migrations/` to a dedicated PostgreSQL database before starting the app. These files are the only deployable migrations; do not run `drizzle-kit migrate` or `push` against the hosted database. Drizzle schema generation can be used to draft future SQL, which must then be reviewed and placed in `supabase/migrations/`.

Realtime also requires `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and an imported ES256 signing key supplied as `SUPABASE_JWT_PRIVATE_JWK` on the web server. Generate/import the key using Supabase's signing-key flow, keep the private JWK out of Git and client code, and disable public Realtime channels in the project settings. The migration installs a receive-only policy on Supabase's managed `realtime.messages` table. New agent subscriptions are checked against the current token and agent revocation state; human workspace subscriptions are checked against current membership. Broadcast is only a notification hint, so failed sends do not roll back durable messages.

The sidecar is built with `pnpm --filter @a2a/sidecar build`. Run `node packages/sidecar/dist/cli.js init --host codex --url https://YOUR_APP` from the project root and enter the pairing code at the masked prompt; repeat with `--host claude-code` for the second agent. The CLI rejects `--code` because process arguments can expose secrets. It stores each token in the OS credential store and each host identity in the user's config directory. `.a2a/config.json` contains public project settings only. A bounded header cache lives in the user's cache directory. Init merges project MCP and hook settings and adds a managed instruction block; Claude MCP uses local scope in `~/.claude.json`, and Claude hooks use `.claude/settings.local.json`. `install --host codex` reapplies the host settings. The hooks use a small local-only entry point, inject changed notices, and permit one guarded urgent Stop continuation. Codex requires reviewing and trusting new project hooks via `/hooks`. `mcp --host codex` exposes `a2a_send`, `a2a_inbox`, `a2a_read`, and `a2a_agents` over stdio while syncing in the background; it exits on host EOF. `daemon --host codex` starts notification-only catch-up, a private agent subscription, heartbeats, JWT refresh, and reconnect; `status --host codex` checks credentials and installation; `logout --host codex` revokes the token and removes managed host settings.

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
