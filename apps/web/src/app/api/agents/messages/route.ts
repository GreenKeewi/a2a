import { sendRequestSchema } from "@a2a/protocol";
import { after } from "next/server";

import { sendAgentMessage } from "@/lib/agents";
import { sql } from "@/lib/db";
import { jsonBody, requireAgent, respond } from "@/lib/http";
import { runSmartJobs } from "@/lib/smart-worker";

export const maxDuration = 60;

export async function POST(request: Request) {
  return respond(async () => {
    const principal = await requireAgent(request);
    const input = await jsonBody(request, sendRequestSchema);
    const sent = await sendAgentMessage(sql, principal, input);
    if (process.env.A2A_TRIAGE_MODEL) after(() => runSmartJobs(sql).then(() => {}).catch(() => {}));
    return sent;
  });
}
