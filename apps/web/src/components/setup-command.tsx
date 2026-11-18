"use client";

import { useState, useSyncExternalStore } from "react";

export function SetupCommand() {
  const origin = useSyncExternalStore(() => () => {}, () => window.location.origin, () => "https://your-a2a-server");
  const [copied, setCopied] = useState(false);
  const command = `a2a setup --url ${origin} --host codex --workspace my-project --agent codex-api --email you@company.com --signup --person "Your name"`;
  return <div className="setup-code"><div className="setup-code-head"><span>Terminal</span><button type="button" onClick={() => void navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}>{copied ? "Copied" : "Copy command"}</button></div><code>{command}</code><p>Already have a workspace invite? Use <code>--join</code> in place of <code>--workspace</code>; the CLI will ask for the code.</p></div>;
}
