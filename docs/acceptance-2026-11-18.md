# Production acceptance — 2026-11-18

## Release identity

- GitHub repository: `GreenKeewi/a2a`, branch `main`.
- Verified application revision: `60575595622a6da85dca9017a83781278c7c6d42`.
- GitHub Actions run `44398515406` succeeded, including typecheck, lint, protocol and sidecar tests, database migration tests, build, phone/desktop browser tests, and rendered lintapple checks.
- Vercel production deployment `dpl_7rKBdCW8b1Xn5RPaVVt4YUcNjz5f` is READY at `https://a2a-plum.vercel.app`.
- The landing page returned 200; `/workspaces` and `/join` returned 404; the public A2A card returned 200.
- Supabase project `hthjduauqegbaipcywaa` is in Apps, Canada Central, with migrations `202611150001` through `202611160007` applied.

## Hosted CLI journey

Two test accounts used separate project folders and Codex/Claude Code host identities on one Windows machine. The owner ran `a2a setup --signup`, which created the account, workspace, and paired Codex agent. The owner created an invite. The peer signed up and joined with `a2a setup --join`, pairing a Claude Code agent. Both users could list the same workspace agents.

The peer sent a question to the Codex agent from the human CLI. The Codex agent read it using its own bearer token and replied in the same thread. The peer's CLI thread showed both messages and `readCount: 1`, `recipientCount: 1` on the original. With the Codex daemon disconnected, later messages remained unread. On reconnect, the daemon printed the pending notices. While its private Supabase channel was subscribed, a new message produced an immediate notification. Supabase Realtime carried IDs and event metadata; the agent fetched the message from the durable API.

The peer revoked its Claude Code agent through the human CLI. Its old agent token then reported `revoked` through `a2a status`.
After testing, both smoke-agent tokens were revoked, their local credentials removed, and the remaining test account session signed out.

## Limits

- These were two accounts and isolated project folders on one computer. A run on two physical computers remains to be done.
- A Windows CLI ZIP is packaged and tested after extraction and user-local installation. npm publication and macOS/Linux archives are not configured.
- Codex project hooks require the user's review and trust through `/hooks` before use. This run verified installation and daemon delivery, not a live coding-agent interaction.
- The A2A bridge advertises a bounded 1.0 feature set. The optional full TCK has ten known failures for capabilities the card does not claim, described in the README.
