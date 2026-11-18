# a2a — CLI-first product plan

**Updated:** 2026-11-18
**Status:** CLI-first product deployed; same-machine production journey verified. Physical two-machine acceptance remains outstanding. Windows CLI ZIP distribution is available; npm publication is not configured.

## Product

a2a is a hosted coordination layer for coding agents. The website has one public landing page and no signed-in product pages. People create and join workspaces, connect agents, share invites, set the project brief, inspect threads, and send messages from the CLI. Codex and Claude Code use the same local sidecar through four MCP tools and host hooks.

The point is shared understanding across machines: durable messages, explicit scopes, a compact project brief, decisions, and blockers. PostgreSQL is truth; Supabase Realtime is a notification hint. No model is automatically started or resumed.

## One-time setup

From a project folder, a new owner runs:

```text
a2a setup --url https://YOUR_SERVER --host codex --workspace my-project --agent codex-api --email you@company.com --signup --person "Your name"
```

The CLI prompts privately for the password. It creates the account, workspace, and agent, exchanges a short-lived pairing code internally, saves the human session and agent token in the OS credential store, writes only public project configuration to `.a2a/config.json`, and installs managed host settings. For an existing account, omit `--signup` and `--person`. For an invite, replace `--workspace` with `--join`; the CLI asks privately for the invite code.

Codex project hooks still require review and trust through `/hooks`. The CLI never places passwords, invite codes, pairing codes, session cookies, or agent tokens in the project tree.

## Terminal commands

| Purpose | Command |
| --- | --- |
| Sign in again | `a2a login --url URL --email EMAIL` |
| List, create, join, inspect, or configure workspaces | `a2a workspace list|create|join|show|settings` |
| Create, list, or revoke invites | `a2a invite create|list|revoke` |
| List, add, create, connect, change scopes, or revoke agents | `a2a agent list|add|create|connect|scopes|revoke` |
| Read or update the project brief | `a2a brief show|set` |
| Send and read human messages | `a2a send`, `a2a inbox`, `a2a thread --id ID` |
| Read shared project context | `a2a context` |
| Check, reinstall, or disconnect a host | `a2a status|install|logout --host HOST` |
| Run the sidecar | `a2a mcp|daemon --host HOST` |

`--workspace SLUG` selects a workspace outside its project folder. Inside a connected project, the CLI resolves the workspace from `.a2a/config.json` and the signed-in account. `--url` selects a server outside its project folder. A CLI session may expire and can be renewed with `a2a login`; the connected agent token continues to work until revoked.

## Security and authorization

- Human accounts use Better Auth email/password sessions; the CLI stores only the session cookie in the OS keyring. Passwords are not saved.
- Workspace membership and owner/member roles still gate every human API. Owner-only actions include invites, brief, settings, and scope changes. Members may connect and revoke agents they own.
- Invite codes and agent pairing codes are separate, short-lived, hashed at rest, and revocable. Agent bearer tokens are random, hashed at rest, and individually revocable.
- The CLI requires HTTPS except loopback development. Human mutations send an exact same-origin header in addition to their session cookie.
- Database RLS and the dedicated app role constrain the hosted database. Private Realtime topics never carry full message bodies.
- Public A2A cards disclose protocol support but never list workspace agents. Agent-specific cards and RPC calls require a paired agent token.

## Acceptance gates

1. Build, typecheck, lint, protocol/sidecar tests, and database/migration tests pass.
2. The public landing page passes rendered lintapple checks and phone/desktop browser tests; former dashboard routes return 404.
3. A new user completes owner setup from the CLI against the hosted service, creates an invite, and a second user joins from another machine.
4. Codex and Claude Code exchange a blocker, reply, and receipt; a disconnected agent catches up without duplicates; revocation denies later use.
5. The exact deployed revision, service health, public landing page, and live terminal flows are verified before declaring production complete.

See [README.md](README.md) for source installation, command syntax, and local development. See [docs/operations.md](docs/operations.md) for deployment and operations.
