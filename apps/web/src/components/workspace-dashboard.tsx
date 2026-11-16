"use client";

import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Section = "overview" | "inbox" | "context" | "agents" | "settings";
type Workspace = { organizationId: string; slug: string; displayName: string; timezone: string; brief: string; briefVersion: number; smartFeaturesEnabled: boolean; reminderAfterMinutes: number; escalateAfterMinutes: number; role: string };
type Agent = { id: string; handle: string; hostType: string; role: string; scopes: string[]; presence: string; lastSeenAt: string | null };
type ThreadHeader = { threadId: string; name: string | null; subject: string; preview: string; sender: string; type: string; lastMessageAt: string; openCount: number; participants: string[] };
type Message = { id: string; sender: string; senderType: string; type: string; priority: string; subject: string; body: string; responseState: string; createdAt: string; readCount: number; recipientCount: number };
type Suggestion = { kind: string; value: unknown; sourceMessageId: string; model: string; promptVersion: string; sourceVersion: string; confidence: number; generatedAt: string };
type Thread = { threadId: string; name: string | null; summary: string | null; suggestions: Suggestion[]; messages: Message[] };
type Stats = { cards: { agentsOnline: number; messages24h: number; unreadDeliveries: number; openItems: number }; days: { day: string; count: number }[]; activity: { id: string; handle: string; role: string; sent: number; received: number; unread: number; medianResponseSeconds: number | null }[] };
type ContextData = { brief: string; briefVersion: number; decisions: { id: string; title: string; summary: string; status: string }[]; openItems: { id: string; thread_id: string; type: string; subject: string; body: string; sender: string; reminder_level?: string }[] };
type SettingsData = { workspace: Workspace; members: { name: string; email: string; role: string }[] };
type Invite = { id: string; expires_at: string; maximum_uses: number; use_count: number; revoked_at: string | null };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "Request failed");
  return body.data as T;
}

function when(value: string, timezone: string) {
  try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(value)); }
  catch { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)); }
}

function suggestionText(suggestion: Suggestion) {
  if (suggestion.kind === "secret_warning") return "This message may contain a secret. Review it before sharing further.";
  if (Array.isArray(suggestion.value)) return suggestion.value.map(String).join(", ");
  return String(suggestion.value);
}

const tabs: { id: Section; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "◫" }, { id: "inbox", label: "Inbox", icon: "▤" },
  { id: "context", label: "Context", icon: "≡" }, { id: "agents", label: "Agents", icon: "◎" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export function WorkspaceDashboard({ slug, section }: { slug: string; section: Section }) {
  const root = `/api/workspaces/${encodeURIComponent(slug)}`;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "signed-out">("loading");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "live" | "disconnected">("connecting");
  const [stats, setStats] = useState<Stats | null>(null);
  const [inbox, setInbox] = useState<ThreadHeader[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [thread, setThread] = useState<Thread | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [context, setContext] = useState<ContextData | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [briefDraft, setBriefDraft] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [messageSubject, setMessageSubject] = useState("");
  const [messageType, setMessageType] = useState("fyi");
  const [recipient, setRecipient] = useState("");
  const [agentHandle, setAgentHandle] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentHost, setAgentHost] = useState("codex");
  const [agentScopes, setAgentScopes] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [scopeWarning, setScopeWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const sectionRef = useRef(section);
  const threadIdRef = useRef(threadId);

  useEffect(() => { sectionRef.current = section; threadIdRef.current = threadId; }, [section, threadId]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    api<Workspace>(root).then((data) => { setWorkspace(data); setBriefDraft(data.brief); setStatus("ready"); })
      .catch((failure) => { setStatus(failure.message === "UNAUTHENTICATED" ? "signed-out" : "error"); setError(failure.message); });
  }, [root]);
  useEffect(() => {
    if (!workspace) return;
    const requests: Promise<unknown>[] = [];
    if (section === "overview") requests.push(api<Stats>(`${root}/stats`).then(setStats), api<ThreadHeader[]>(`${root}/inbox`).then(setInbox));
    if (section === "inbox") requests.push(api<ThreadHeader[]>(`${root}/inbox`).then(setInbox), api<Agent[]>(`${root}/agents`).then(setAgents));
    if (section === "context") requests.push(api<ContextData>(`${root}/context`).then(setContext));
    if (section === "agents") requests.push(api<Agent[]>(`${root}/agents`).then(setAgents));
    if (section === "settings") requests.push(api<SettingsData>(`${root}/settings`).then(setSettings), api<Invite[]>(`${root}/invites`).then(setInvites));
    Promise.all(requests).then(() => setError("")).catch((failure) => setError(failure.message));
  }, [root, section, revision, workspace]);
  useEffect(() => {
    if (section !== "inbox") return;
    const selected = new URLSearchParams(window.location.search).get("thread");
    if (!selected) return;
    const frame = window.requestAnimationFrame(() => { setThreadId(selected); setShowComposer(true); });
    return () => window.cancelAnimationFrame(frame);
  }, [section]);
  useEffect(() => {
    if (!threadId || section !== "inbox") return;
    let active = true;
    api<Thread>(`${root}/threads/${threadId}`).then((data) => { if (active) setThread(data); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [root, section, threadId, revision]);
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | undefined;
    let client: ReturnType<typeof createClient> | undefined;
    let retryTimer: number | undefined;
    let connecting = false;
    const updateForEvent = (event: string) => {
      const tasks: Promise<unknown>[] = [];
      if (sectionRef.current === "overview") {
        if (event !== "thread.updated" && event !== "brief.updated") tasks.push(api<Stats>(`${root}/stats`).then(setStats));
        if (event === "message.created" || event === "coordination.resolved" || event === "thread.updated") tasks.push(api<ThreadHeader[]>(`${root}/inbox`).then(setInbox));
      }
      if (sectionRef.current === "inbox") {
        if (event === "message.created" || event === "message.read" || event === "coordination.resolved" || event === "thread.updated") {
          tasks.push(api<ThreadHeader[]>(`${root}/inbox`).then(setInbox));
          if (threadIdRef.current) tasks.push(api<Thread>(`${root}/threads/${threadIdRef.current}`)
            .then((data) => { if (threadIdRef.current === data.threadId) setThread(data); }));
        }
        if (event === "agent.presence") tasks.push(api<Agent[]>(`${root}/agents`).then(setAgents));
      }
      if (sectionRef.current === "context" && (event === "brief.updated" || event === "message.created" || event === "coordination.resolved")) tasks.push(api<ContextData>(`${root}/context`).then(setContext));
      if (sectionRef.current === "agents" && event === "agent.presence") tasks.push(api<Agent[]>(`${root}/agents`).then(setAgents));
      if (tasks.length) void Promise.all(tasks).catch((failure) => { if (active) setError(failure.message); });
    };
    async function connect() {
      if (connecting || !active) return;
      connecting = true;
      if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = undefined; }
      try {
        const oldChannel = channel;
        channel = undefined;
        if (client && oldChannel) await client.removeChannel(oldChannel);
        const config = await api<{ token: string; url: string; publishableKey: string }>(`${root}/realtime-token`, { method: "POST" });
        if (!active) return;
        const currentJwt = config.token;
        client = createClient(config.url, config.publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          accessToken: async () => currentJwt,
        });
        await client.realtime.setAuth();
        const nextChannel = client.channel(`workspace:${workspace!.organizationId}`, { config: { private: true } })
          .on("broadcast", { event: "*" }, ({ event }) => updateForEvent(event));
        channel = nextChannel;
        nextChannel.subscribe((state) => {
            if (!active || channel !== nextChannel) return;
            if (state === "SUBSCRIBED") { setConnection("live"); refresh(); }
            else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
              setConnection("disconnected");
              if (!retryTimer) retryTimer = window.setTimeout(() => { retryTimer = undefined; void connect(); }, 5_000);
            }
          });
      } catch {
        if (active) {
          setConnection("disconnected");
          if (!retryTimer) retryTimer = window.setTimeout(() => { retryTimer = undefined; void connect(); }, 5_000);
        }
      }
      finally { connecting = false; }
    }
    void connect();
    const tokenRefresh = window.setInterval(() => { void connect(); }, 12 * 60_000);
    const catchUp = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(tokenRefresh); window.clearInterval(catchUp); if (retryTimer) window.clearTimeout(retryTimer); if (client && channel) void client.removeChannel(channel); };
  }, [root, workspace, refresh]);

  async function act(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setError("");
    try { await action(); after?.(); refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Request failed"); }
    finally { setBusy(false); }
  }

  if (status === "loading") return <main className="dashboard-loading" role="status">Opening workspace…</main>;
  if (status === "signed-out") return <main className="dashboard-loading"><p>Sign in to open this workspace.</p><Link className="button button-primary" href="/workspaces">Sign in</Link></main>;
  if (status === "error" || !workspace) return <main className="dashboard-loading"><p role="alert">Could not open this workspace. {error}</p><Link href="/workspaces">Back to workspaces</Link></main>;

  const title = tabs.find((tab) => tab.id === section)?.label ?? "Overview";
  const threadParticipants = inbox.find((item) => item.threadId === threadId)?.participants ?? [];
  const recipientValue = recipient || (threadId ? threadParticipants.length > 1 ? "__all_thread__" : threadParticipants[0] ?? "" : "");
  return <div className="dashboard-shell">
    <aside className="dashboard-sidebar"><Link href="/workspaces" className="dashboard-brand"><span className="brand-mark" aria-hidden="true">↗</span><span>a2a</span></Link><div className="workspace-switch"><span>WORKSPACE</span><strong>{workspace.displayName}</strong><Link href="/workspaces">Switch workspace ↗</Link></div><nav aria-label="Workspace" className="dashboard-nav">{tabs.map((tab) => <Link key={tab.id} aria-current={section === tab.id ? "page" : undefined} href={`/w/${slug}${tab.id === "overview" ? "" : `/${tab.id}`}`}>{tab.label}</Link>)}</nav><div className="sidebar-foot"><span className={`connection-dot ${connection}`} aria-hidden="true" />{connection === "live" ? "Live updates" : connection === "connecting" ? "Connecting…" : "Disconnected · checking for updates"}</div></aside>
    <main className="dashboard-main"><header className="dashboard-top"><div><p className="eyebrow">{workspace.displayName.toUpperCase()}</p><h1>{title}</h1></div><div className="top-actions"><span>{workspace.role}</span><Link href="/workspaces">All workspaces</Link></div></header>
      {error && <div role="alert" className="dashboard-error">{error}<button type="button" onClick={refresh}>Retry</button></div>}
      {section === "overview" && <div className="dashboard-content"><div className="section-heading"><div><h2>At a glance</h2><p>What needs attention across the workspace.</p></div><Link className="text-link" href={`/w/${slug}/inbox`}>Open inbox ↗</Link></div><div className="stat-grid">{[
        ["Agents online", stats?.cards.agentsOnline ?? "—"], ["Messages · 24h", stats?.cards.messages24h ?? "—"],
        ["Unread deliveries", stats?.cards.unreadDeliveries ?? "—"], ["Open questions", stats?.cards.openItems ?? "—"],
      ].map(([label, value]) => <div className="stat-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="overview-columns"><section className="panel"><div className="panel-head"><h2>Message volume</h2><span>Last 7 days · {workspace.timezone}</span></div>{stats ? <div className="bar-chart" role="img" aria-label="Messages by day">{stats.days.map((day) => <div key={day.day}><span style={{ height: `${Math.max(4, (day.count / Math.max(1, ...stats.days.map((item) => item.count))) * 100)}%` }} /><small>{day.day.slice(5)}</small><b>{day.count}</b></div>)}</div> : <p>Loading activity…</p>}</section><section className="panel"><div className="panel-head"><h2>Recent threads</h2><Link href={`/w/${slug}/inbox`}>See all ↗</Link></div>{inbox.length ? <ul className="compact-list">{inbox.slice(0, 5).map((item) => <li key={item.threadId}><Link href={`/w/${slug}/inbox?thread=${item.threadId}`}><strong>{item.subject}</strong><span>{item.sender} · {when(item.lastMessageAt, workspace.timezone)}</span></Link></li>)}</ul> : <p className="empty-note">Messages will appear here when your agents start talking.</p>}</section></div><section className="panel"><div className="panel-head"><h2>Agent activity</h2><span>Current workspace</span></div>{stats?.activity.length ? <div className="table-scroll"><table><thead><tr><th>Agent</th><th>Sent</th><th>Received</th><th>Unread</th><th>Median response</th></tr></thead><tbody>{stats.activity.map((agent) => <tr key={agent.id}><th>{agent.handle}<small>{agent.role}</small></th><td>{agent.sent}</td><td>{agent.received}</td><td>{agent.unread}</td><td>{agent.medianResponseSeconds == null ? "—" : `${Math.round(agent.medianResponseSeconds)}s`}</td></tr>)}</tbody></table></div> : <p className="empty-note">Connect an agent to see its activity here.</p>}</section></div>}
      {section === "inbox" && <div className="inbox-layout"><div className={`thread-list ${threadId ? "mobile-hidden" : ""}`}><div className="panel-head"><h2>Threads</h2><button className="small-button" type="button" onClick={() => { setThreadId(null); setThread(null); setRecipient(""); setShowComposer(true); }}>New message</button></div>{inbox.length ? inbox.map((item) => <button className={`thread-row ${threadId === item.threadId ? "selected" : ""}`} type="button" key={item.threadId} onClick={() => { setThreadId(item.threadId); setThread(null); setRecipient(item.participants.length > 1 ? "__all_thread__" : item.participants[0] ?? ""); setShowComposer(true); }}><span className="thread-row-top"><strong>{item.subject}</strong><small>{when(item.lastMessageAt, workspace.timezone)}</small></span><span>{item.sender} · {item.preview}</span><small>{item.participants.join(", ")}{item.openCount ? ` · ${item.openCount} open` : ""}</small></button>) : <p className="empty-note">No threads yet. Send the first message to a connected agent.</p>}</div><div className={`conversation ${!showComposer ? "mobile-hidden" : ""}`}><div className="conversation-head"><button className="mobile-back" type="button" onClick={() => { setThreadId(null); setShowComposer(false); }}>← Threads</button><div><h2>{thread?.messages.at(-1)?.subject ?? (threadId ? "Loading thread…" : "New message")}</h2><p>{thread?.summary ?? (threadId ? "Shared conversation" : "Start a conversation with an agent")}</p></div></div><div className="message-stream">{thread?.messages.map((message) => <article className="conversation-message" key={message.id}><div><strong>{message.sender}</strong><span>{when(message.createdAt, workspace.timezone)}</span></div><small>{message.type}{message.responseState === "open" ? " · awaiting response" : ""}</small><h3>{message.subject}</h3><p>{message.body}</p>{message.recipientCount > 0 && <footer>{message.readCount} of {message.recipientCount} read</footer>}</article>)}{thread?.suggestions?.length ? <section className="smart-suggestions" aria-label="Smart suggestions"><h3>Optional suggestions</h3>{thread.suggestions.slice(0, 4).map((suggestion) => <div key={`${suggestion.kind}-${suggestion.sourceVersion}`}><strong>{suggestion.kind.replaceAll("_", " ")}</strong><p>{suggestionText(suggestion)}</p><small>{suggestion.model} · {suggestion.promptVersion} · source {suggestion.sourceVersion.slice(0, 8)} · {Math.round(suggestion.confidence * 100)}% confidence · {when(suggestion.generatedAt, workspace.timezone)}</small></div>)}</section> : null}{!threadId && <div className="conversation-empty"><span aria-hidden="true">↗</span><h3>A place for the next handoff.</h3><p>Choose an agent and send a note, question, blocker, or decision.</p></div>}</div><form className="composer" onSubmit={(event) => { event.preventDefault(); void act(async () => { const participants = inbox.find((item) => item.threadId === threadId)?.participants ?? []; const target = recipient === "__all_thread__" ? participants : threadId ? (recipient || (participants.length > 1 ? participants : participants[0])) : recipient; if (!target) throw new Error("Choose an agent first."); const sent = await api<{ threadId: string }>(`${root}/messages`, { method: "POST", body: JSON.stringify({ to: target, type: messageType, subject: messageSubject, body: messageBody, ...(threadId ? { threadId } : {}) }) }); setThreadId(sent.threadId); }, () => { setMessageBody(""); setMessageSubject(""); }); }}><div className="composer-fields"><label>Send to<select value={recipientValue} onChange={(event) => setRecipient(event.target.value)} required={!threadId}><option value="">{threadId ? "Thread agent" : "Choose agent"}</option>{agents.filter((agent) => !threadId || inbox.find((item) => item.threadId === threadId)?.participants.includes(agent.handle)).map((agent) => <option key={agent.id} value={agent.handle}>{agent.handle}</option>)}{threadId && (inbox.find((item) => item.threadId === threadId)?.participants.length ?? 0) > 1 && <option value="__all_thread__">Everyone in thread</option>}{!threadId && agents.length > 1 && <option value="*">All agents</option>}</select></label><label>Type<select value={messageType} onChange={(event) => setMessageType(event.target.value)}><option value="fyi">Note</option><option value="question">Question</option><option value="blocker">Blocker</option><option value="decision">Decision</option><option value="handoff">Handoff</option></select></label></div><input id="message-subject" aria-label="Subject" required maxLength={80} value={messageSubject} onChange={(event) => setMessageSubject(event.target.value)} placeholder="Subject" /><textarea id="message-body" aria-label="Message" required maxLength={8000} value={messageBody} onChange={(event) => setMessageBody(event.target.value)} placeholder="Write a message…" rows={3} /><div className="composer-actions"><span>Shared with this workspace</span><button className="button button-primary" disabled={busy || !agents.length}>Send message ↗</button></div></form></div></div>}
      {section === "context" && <div className="dashboard-content"><div className="section-heading"><div><h2>Shared context</h2><p>The brief, decisions, and open work your agents can reference.</p></div></div><section className="panel"><div className="panel-head"><h2>Project brief</h2><span>Version {context?.briefVersion ?? workspace.briefVersion}</span></div><form onSubmit={(event) => { event.preventDefault(); void act(() => api(`${root}/brief`, { method: "PATCH", body: JSON.stringify({ brief: briefDraft }) })); }}><textarea id="brief" aria-label="Project brief" disabled={workspace.role !== "owner"} rows={6} maxLength={2000} value={briefDraft} onChange={(event) => setBriefDraft(event.target.value)} placeholder="What are you building? What should every agent know?" /><div className="form-actions"><span>{briefDraft.length} / 2000</span><button className="button button-primary" disabled={busy || briefDraft === context?.brief}>Save brief</button></div></form></section><div className="overview-columns"><section className="panel"><div className="panel-head"><h2>Decisions</h2><span>{context?.decisions.length ?? 0}</span></div>{context?.decisions.length ? <ul className="context-list">{context.decisions.map((item) => <li key={item.id}><strong>{item.title}</strong><p>{item.summary}</p><small>{item.status}</small></li>)}</ul> : <p className="empty-note">Decisions from conversations appear here.</p>}</section><section className="panel"><div className="panel-head"><h2>Open blockers & questions</h2><span>{context?.openItems.length ?? 0}</span></div>{context?.openItems.length ? <ul className="context-list">{context.openItems.map((item) => <li key={item.id}><Link href={`/w/${slug}/inbox?thread=${item.thread_id}`}><strong>{item.subject}</strong></Link><p>{item.body}</p><small>{item.type} · {item.sender}{item.reminder_level && item.reminder_level !== "pending" ? ` · ${item.reminder_level} reminder` : ""}</small><button className="small-button" type="button" disabled={busy} onClick={() => void act(() => api(`${root}/messages/${item.id}/response`, { method: "PATCH", body: JSON.stringify({ state: "resolved" }) }))}>Mark resolved</button></li>)}</ul> : <p className="empty-note">No open blockers or questions.</p>}</section></div></div>}
      {section === "agents" && <div className="dashboard-content"><div className="section-heading"><div><h2>Connected agents</h2><p>Give each agent a clear role and scope of work.</p></div></div><section className="panel"><div className="panel-head"><h2>Directory</h2><span>{agents.length} active</span></div>{agents.length ? <div className="agent-grid">{agents.map((agent) => <article className="agent-card" key={agent.id}><div className="agent-card-top"><span className="agent-avatar">{agent.handle.slice(0, 1).toUpperCase()}</span><span className={`presence-pill ${agent.presence}`}>{agent.presence}</span></div><h3>{agent.handle}</h3><p>{agent.role} · {agent.hostType}</p><div className="scope-tags">{agent.scopes.length ? agent.scopes.map((scope) => <span key={scope}>{scope}</span>) : <span>No scopes assigned</span>}</div><div className="agent-actions">{workspace.role === "owner" && <button className="small-button" type="button" disabled={busy} onClick={() => { const value = window.prompt("Scopes, one path pattern per line", agent.scopes.join("\n")); if (value !== null) void act(async () => { const result = await api<{ overlapWarnings: string[] }>(`${root}/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ scopes: value.split(/\r?\n/).map((scope) => scope.trim()).filter(Boolean) }) }); setScopeWarning((result.overlapWarnings ?? []).length ? `Overlapping scopes with ${(result.overlapWarnings ?? []).join(", ")}.` : ""); }) }}>Edit scopes</button>}<button className="small-button" type="button" disabled={busy} onClick={() => void act(async () => { const result = await api<{ code: string }>(`${root}/agents/${agent.id}/pairing`, { method: "POST" }); setPairingCode(result.code); })}>Pair device</button><button className="danger-link" type="button" disabled={busy} onClick={() => { if (window.confirm(`Revoke ${agent.handle}? Its tokens will stop working.`)) void act(() => api(`${root}/agents/${agent.id}`, { method: "DELETE" })); }}>Revoke</button></div></article>)}</div> : <p className="empty-note">No agents yet. Create one below, then pair it from its host.</p>}</section>{pairingCode && <section className="pairing-notice" role="status"><div><strong>One-time pairing code</strong><p>Enter this in the a2a sidecar on the agent’s device. It expires soon.</p></div><code>{pairingCode}</code><button type="button" onClick={() => setPairingCode("")}>Dismiss</button></section>}{scopeWarning && <p className="dashboard-warning" role="status">{scopeWarning}</p>}<section className="panel"><div className="panel-head"><h2>Add an agent</h2><span>Claude Code or Codex</span></div><form className="agent-form" onSubmit={(event) => { event.preventDefault(); void act(async () => { const result = await api<{ overlapWarnings: string[] }>(`${root}/agents`, { method: "POST", body: JSON.stringify({ handle: agentHandle, role: agentRole, hostType: agentHost, scopes: agentScopes.split("\n").map((value) => value.trim()).filter(Boolean) }) }); setScopeWarning((result.overlapWarnings ?? []).length ? `Overlapping scopes with ${(result.overlapWarnings ?? []).join(", ")}.` : ""); }, () => { setAgentHandle(""); setAgentRole(""); setAgentScopes(""); }); }}><label>Handle<input required value={agentHandle} onChange={(event) => setAgentHandle(event.target.value)} placeholder="codex-api" /></label><label>Role<input required value={agentRole} onChange={(event) => setAgentRole(event.target.value)} placeholder="API builder" /></label><label>Host<select value={agentHost} onChange={(event) => setAgentHost(event.target.value)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option></select></label><label className="full-span">Scopes, one path pattern per line<textarea rows={3} value={agentScopes} onChange={(event) => setAgentScopes(event.target.value)} placeholder="apps/api/**" /></label><button className="button button-primary" disabled={busy}>Add agent ↗</button></form></section></div>}
      {section === "settings" && <div className="dashboard-content"><div className="section-heading"><div><h2>Workspace settings</h2><p>Manage members, invite access, and optional smart features.</p></div></div><section className="panel"><div className="panel-head"><h2>General</h2><span>Owner controls</span></div><form className="settings-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void act(() => api(`${root}/settings`, { method: "PATCH", body: JSON.stringify({ displayName: data.get("displayName"), timezone: data.get("timezone"), smartFeaturesEnabled: data.get("smartFeaturesEnabled") === "on", reminderAfterMinutes: Number(data.get("reminderAfterMinutes")), escalateAfterMinutes: Number(data.get("escalateAfterMinutes")) }) })); }}><label>Workspace name<input name="displayName" key={settings?.workspace.displayName} defaultValue={settings?.workspace.displayName ?? workspace.displayName} disabled={workspace.role !== "owner"} /></label><label>Timezone<input name="timezone" key={settings?.workspace.timezone} defaultValue={settings?.workspace.timezone ?? workspace.timezone} disabled={workspace.role !== "owner"} /></label><label>Remind after (minutes)<input name="reminderAfterMinutes" type="number" min={5} max={10080} defaultValue={settings?.workspace.reminderAfterMinutes ?? workspace.reminderAfterMinutes ?? 120} disabled={workspace.role !== "owner"} /></label><label>Escalate after (minutes)<input name="escalateAfterMinutes" type="number" min={10} max={20160} defaultValue={settings?.workspace.escalateAfterMinutes ?? workspace.escalateAfterMinutes ?? 480} disabled={workspace.role !== "owner"} /></label><label className="checkbox-row"><input name="smartFeaturesEnabled" type="checkbox" key={String(settings?.workspace.smartFeaturesEnabled)} defaultChecked={settings?.workspace.smartFeaturesEnabled ?? workspace.smartFeaturesEnabled} disabled={workspace.role !== "owner"} /><span>Enable smart summaries and suggestions when configured</span></label>{workspace.role === "owner" && <button className="button button-primary" disabled={busy}>Save settings</button>}</form></section><div className="overview-columns"><section className="panel"><div className="panel-head"><h2>Members</h2><span>{settings?.members.length ?? 0}</span></div><ul className="context-list">{settings?.members.map((member) => <li key={member.email}><strong>{member.name}</strong><p>{member.email}</p><small>{member.role}</small></li>)}</ul></section><section className="panel"><div className="panel-head"><h2>Invites</h2><span>Share a one-time code</span></div>{workspace.role === "owner" && <button className="button button-primary" type="button" disabled={busy} onClick={() => void act(async () => { const result = await api<{ code: string }>(`${root}/invites`, { method: "POST", body: JSON.stringify({ maxUses: 5, expiresInHours: 24 }) }); setInviteCode(result.code); })}>Create invite</button>}{inviteCode && <p className="invite-code" role="status">New invite: <code>{inviteCode}</code></p>}{invites.length ? <ul className="context-list">{invites.map((invite) => <li key={invite.id}><strong>{invite.revoked_at ? "Revoked" : new Date(invite.expires_at) < new Date() ? "Expired" : "Active invite"}</strong><p>{invite.use_count} of {invite.maximum_uses} uses · Expires {when(invite.expires_at, workspace.timezone)}</p>{!invite.revoked_at && workspace.role === "owner" && <button className="danger-link" type="button" disabled={busy} onClick={() => void act(() => api(`${root}/invites`, { method: "DELETE", body: JSON.stringify({ inviteId: invite.id }) }))}>Revoke invite</button>}</li>)}</ul> : <p className="empty-note">No invite codes yet.</p>}</section></div></div>}
    </main>
  </div>;
}
