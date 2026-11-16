import { sendInputSchema } from "@a2a/protocol";

import { sql } from "@/lib/db";
import { sendHumanMessage } from "@/lib/human-dashboard";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };
export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const input = await jsonBody(request, sendInputSchema);
    return sendHumanMessage(sql, organizationId, userId, input);
  });
}
