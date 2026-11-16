import { timingSafeEqual } from "node:crypto";

import { sql } from "@/lib/db";
import { runSmartJobs } from "@/lib/smart-worker";

export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!secret || !supplied || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) {
    return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const counts = await runSmartJobs(sql, { limit: 10 });
  return Response.json({ data: counts }, { headers: { "cache-control": "no-store" } });
}
