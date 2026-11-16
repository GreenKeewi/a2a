import { importJWK, SignJWT, type JWK } from "jose";
import type { Sql } from "postgres";

import { AgentError, type AgentPrincipal } from "./agents";

type RealtimePrincipal = { kind: "agent"; agent: AgentPrincipal } | { kind: "user"; userId: string; organizationId: string };

function realtimeSettings() {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const privateJwk = process.env.SUPABASE_JWT_PRIVATE_JWK;
  if (!url || !publishableKey || !privateJwk) throw new Error("Realtime is not configured");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "127.0.0.1" && parsedUrl.hostname !== "localhost") {
    throw new Error("Realtime URL must use HTTPS");
  }
  const jwk = JSON.parse(privateJwk) as JWK;
  const kid = jwk.kid;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !kid || !jwk.d) throw new Error("Invalid Realtime signing key");
  return { url: parsedUrl.origin, publishableKey, jwk, kid };
}

export function publicRealtimeConfig() {
  const { url, publishableKey } = realtimeSettings();
  return { url, publishableKey };
}

export async function mintRealtimeToken(sql: Sql, principal: RealtimePrincipal) {
  const { jwk, kid } = realtimeSettings();
  if (principal.kind === "agent") {
    const { agentId, organizationId, tokenId } = principal.agent;
    if (!tokenId) throw new AgentError("UNAUTHENTICATED");
    const valid = await sql`
      SELECT 1 FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
      WHERE t.id = ${tokenId} AND t.agent_id = ${agentId} AND a.organization_id = ${organizationId}
        AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND a.revoked_at IS NULL
    `;
    if (!valid.length) throw new AgentError("UNAUTHENTICATED");
  } else {
    const valid = await sql`SELECT 1 FROM member WHERE user_id = ${principal.userId} AND organization_id = ${principal.organizationId}`;
    if (!valid.length) throw new AgentError("FORBIDDEN");
  }
  const key = await importJWK(jwk, "ES256");
  const isAgent = principal.kind === "agent";
  const subject = isAgent ? principal.agent.agentId : principal.userId;
  const organizationId = isAgent ? principal.agent.organizationId : principal.organizationId;
  const token = await new SignJWT({ role: "authenticated", principal_type: isAgent ? "agent" : "user",
    organization_id: organizationId, ...(isAgent ? { agent_id: principal.agent.agentId, token_id: principal.agent.tokenId } : {}) })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setSubject(subject).setAudience("authenticated").setIssuedAt().setExpirationTime("15m").sign(key);
  return { token, expiresIn: 900 };
}
