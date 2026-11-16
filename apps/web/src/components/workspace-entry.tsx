"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { GoogleSignIn } from "./google-sign-in";

type Workspace = { slug: string; displayName: string; role: string };

export function WorkspaceEntry({ join = false }: { join?: boolean }) {
  const router = useRouter();
  const [items, setItems] = useState<Workspace[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/workspaces", { cache: "no-store" }).then(async (response) => {
      if (response.status === 401) { setStatus("signed-out"); return; }
      if (!response.ok) throw new Error("Could not load workspaces.");
      const body = await response.json(); setItems(body.data); setStatus("ready");
    }).catch(() => setStatus("error"));
  }, []);
  async function submit(path: string, body: unknown) {
    setBusy(true); setError("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Could not save.");
      router.push(`/w/${encodeURIComponent(result.data.slug)}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save."); setBusy(false); }
  }
  return <main className="entry-shell">
    <header className="entry-header"><Link className="brand" href="/"><span className="brand-mark" aria-hidden="true">↗</span>a2a</Link><Link href={join ? "/workspaces" : "/join"}>{join ? "My workspaces" : "Have an invite?"}</Link></header>
    <section className="entry-main">
      <div><p className="eyebrow">{join ? "JOIN A WORKSPACE" : "YOUR WORKSPACES"}</p><h1>{join ? "Work together, from day one." : "Pick up where the team left off."}</h1><p className="entry-intro">A shared inbox, clear ownership, and the context every agent needs to keep moving.</p></div>
      <div className="entry-panel">
        {status === "loading" && <p role="status">Loading workspaces…</p>}
        {status === "error" && <p role="alert">Could not load workspaces. Refresh to try again.</p>}
        {status === "signed-out" && <><h2>Sign in to continue</h2><p>Use your Google account to access your workspaces.</p><GoogleSignIn /></>}
        {status === "ready" && <>
          {!join && <><h2>Open a workspace</h2>{items.length ? <ul className="workspace-list">{items.map((item) => <li key={item.slug}><Link href={`/w/${item.slug}`}><strong>{item.displayName}</strong><span>{item.role} ↗</span></Link></li>)}</ul> : <p>No workspaces yet. Create one below or join with an invite.</p>}</>}
          {join ? <form onSubmit={(event) => { event.preventDefault(); void submit("/api/workspaces/join", { code }); }}><h2>Enter your invite</h2><label>Invite code<input required value={code} onChange={(event) => setCode(event.target.value)} placeholder="A2A-XXXXX-XXXXX-XXXXX" autoComplete="off" /></label><button className="button button-primary" disabled={busy}>Join workspace</button></form> :
            <form onSubmit={(event) => { event.preventDefault(); void submit("/api/workspaces", { name, slug }); }}><h2>Create a workspace</h2><label>Workspace name<input required maxLength={80} value={name} onChange={(event) => { setName(event.target.value); setSlug(event.target.value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} placeholder="Project Atlas" /></label><label>URL slug<input required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="project-atlas" /></label><button className="button button-primary" disabled={busy}>Create workspace</button></form>}
          {error && <p role="alert" className="form-error">{error}</p>}
        </>}
      </div>
    </section>
  </main>;
}
