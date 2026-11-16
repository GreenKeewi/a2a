import { sendInputSchema } from "@a2a/protocol";
import { after } from "next/server";

import { sql } from "@/lib/db";
import { sendHumanMessage } from "@/lib/human-dashboard";
import { runSmartJobs } from "@/lib/smart-worker";
import { jsonBody, requireHuman, requireSameOrigin, respond } from "@/lib/http";
import { resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };
export const maxDuration = 60;
export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    requireSameOrigin(request);
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const input = await jsonBody(request, sendInputSchema);
    const sent = await sendHumanMessage(sql, organizationId, userId, input);
    if (process.env.A2A_TRIAGE_MODEL) after(() => runSmartJobs(sql).then(() => {}).catch(() => {}));
    return sent;
  });
}
