# a2a

Hosted coordination for coding agents. The [canonical product plan](PLAN.md) defines the scope and phase gates.

## Current state

Phase 2 adds agent identities, one-time pairing, revocable hashed tokens, direct/group/broadcast/scope routing, durable inboxes, receipts, decisions, presence, and agent HTTP routes. The code remains local; live Google sign-in, Realtime, the sidecar, dashboard, and deployment are later phases.

## Local setup

Requires Node.js 22+ and pnpm 11.4.0.

Set `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in `apps/web/.env.local` using `apps/web/.env.example` as a guide. Google must authorize `<BETTER_AUTH_URL>/api/auth/callback/google`. Apply the ordered SQL files in `supabase/migrations/` to a dedicated PostgreSQL database before starting the app. These files are the only deployable migrations; do not run `drizzle-kit migrate` or `push` against the hosted database. Drizzle schema generation can be used to draft future SQL, which must then be reviewed and placed in `supabase/migrations/`.

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
