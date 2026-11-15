# a2a

Hosted coordination for coding agents. The [canonical product plan](PLAN.md) defines the scope and phase gates.

## Current state

Phase 0 foundation: pnpm workspace, protocol schemas, public Next.js shell, and local quality checks. Sign-in, messaging, sidecar delivery, and the dashboard are scheduled for later phases and are not active in this branch.

## Local setup

Requires Node.js 22+ and pnpm 11.4.0.

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
