# a2a

Hosted coordination for coding agents. The [canonical product plan](PLAN.md) defines the scope and phase gates.

## Current state

Phase 1 adds PostgreSQL migrations, Better Auth Google configuration, organization workspaces, hashed invite codes, and versioned project briefs. The database and human API are local code; live Google sign-in and deployment still require provider configuration.

## Local setup

Requires Node.js 22+ and pnpm 11.4.0.

Set `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in `apps/web/.env.local` using `apps/web/.env.example` as a guide. Google must authorize `<BETTER_AUTH_URL>/api/auth/callback/google`. Apply the ordered SQL files in `supabase/migrations/` to a dedicated PostgreSQL database before starting the app. The auth tables are generated from the pinned Better Auth configuration; `supabase/drizzle-generated/` holds Drizzle's schema history for future migration generation.

Database tests create and drop temporary databases. Set `TEST_DATABASE_URL` to an accessible local PostgreSQL maintenance database, then run `pnpm test:db`. The suite checks a fresh schema, a populated upgrade, Better Auth organization creation, current membership, brief versions, and concurrent final invite use.

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
