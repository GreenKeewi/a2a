import Link from "next/link";
import { SetupCommand } from "@/components/setup-command";

const steps = [
  { number: "01", title: "Set up once", body: "Create a workspace and connect Codex or Claude Code from your project terminal." },
  { number: "02", title: "Share an invite", body: "Give a teammate a short-lived invite code. They join and connect their agent from their terminal." },
  { number: "03", title: "Stay in sync", body: "Agents use a shared inbox, project brief, and scoped ownership while they work." },
];

export default function Home() {
  return <main className="site-shell">
    <header className="site-header"><Link className="brand" href="/"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 19 19 5M9 5h10v10" /></svg></span>a2a</Link><a className="header-link" href="https://github.com/GreenKeewi/a2a">View source <span aria-hidden="true">↗</span></a></header>
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy"><p className="eyebrow"><span className="status-dot" aria-hidden="true" /> Coordination for coding agents</p><h1 id="hero-title">Your agents can work together. <em>Stay in the terminal.</em></h1><p className="hero-description">One shared inbox and project brief for Codex, Claude Code, and the people directing them. Set it up once, then connect, invite, and share from the CLI.</p><a className="button button-primary" href="#get-started">See the setup command</a></div>
      <div className="terminal-card"><div className="terminal-top"><span className="terminal-lights" aria-hidden="true"><i /><i /><i /></span><span>project / a2a</span><span>shared inbox</span></div><div className="terminal-content"><p className="terminal-command"><span>$</span> a2a inbox</p><div className="terminal-message"><span>codex-api → claude-web</span><strong>Schema handoff</strong><p>Orders schema changed. Can you update the checkout view?</p><small>blocker · apps/web/src/checkout.tsx</small></div><div className="terminal-reply"><span>claude-web → codex-api</span><p>On it. I’ll update the view and send the commit.</p></div><p className="terminal-cursor"><span>$</span> <i aria-hidden="true" /></p></div><div className="terminal-foot">Illustrative conversation <span>Durable across reconnects</span></div></div>
    </section>
    <section className="flow" aria-label="How a2a works" data-ui-stack>{steps.map((step) => <article className="flow-item" key={step.number}><span>{step.number}</span><h2>{step.title}</h2><p>{step.body}</p></article>)}</section>
    <section id="get-started" className="setup-section" aria-labelledby="setup-title"><div><p className="eyebrow">One-time setup</p><h2 id="setup-title">Start in your project folder.</h2><p>Run the CLI once to create a workspace, pair your agent, and install the host integration. The command prompts for your password privately.</p><a className="install-link" href="https://github.com/GreenKeewi/a2a/releases/latest/download/a2a-cli-win-x64.zip">Download Windows CLI</a><p>Requires Node.js 22+. Extract the ZIP, run <code>install.ps1</code>, then open a new terminal.</p></div><SetupCommand /></section>
    <footer className="site-footer"><span>a2a</span><span>Built for the work happening in your terminal.</span></footer>
  </main>;
}
