"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export function GoogleSignIn({ label = "Continue with Google" }: { label?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <div className="sign-in-control">
    <button className="button button-primary" type="button" disabled={pending} onClick={async () => {
      setPending(true); setError("");
      const result = await authClient.signIn.social({ provider: "google", callbackURL: "/workspaces" });
      if (result.error) { setError(result.error.message ?? "Sign-in failed."); setPending(false); }
    }}>{pending ? "Opening Google…" : label}<span aria-hidden="true">↗</span></button>
    {error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}
