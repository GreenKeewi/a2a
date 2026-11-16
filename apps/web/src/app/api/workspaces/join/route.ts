import { z } from "zod";

import { sql } from "@/lib/db";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { redeemInviteCode } from "@/lib/workspaces";

const joinSchema = z.strictObject({ code: z.string().min(1).max(100) });

export async function POST(request: Request) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const { code } = await jsonBody(request, joinSchema);
    const result = await redeemInviteCode(sql, code, userId);
    const settings = await sql`SELECT slug FROM workspace_settings WHERE organization_id = ${result.organizationId}`;
    if (!settings[0]) throw new Error("Workspace settings missing");
    return { organizationId: result.organizationId, slug: String(settings[0].slug) };
  });
}
