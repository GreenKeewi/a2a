import { timingSafeEqual } from "node:crypto";

import { AgentError } from "@/lib/agents";
import { sql } from "@/lib/db";
import { respond } from "@/lib/http";
import { runSmartJobs } from "@/lib/smart-worker";

export const maxDuration = 60;

export async function GET(request: Request) {
  return respond(async () => {
    const secret = process.env.CRON_SECRET;
    const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!secret || !supplied || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) ||
        !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
      throw new AgentError("UNAUTHENTICATED");
    }
    return runSmartJobs(sql, { limit: 10 });
  });
}
