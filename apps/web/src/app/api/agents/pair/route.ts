import { z } from "zod";

import { exchangePairingCode } from "@/lib/agents";
import { sql } from "@/lib/db";
import { jsonBody, respond } from "@/lib/http";

const pairSchema = z.strictObject({ code: z.string().min(1).max(100) });

export async function POST(request: Request) {
  return respond(async () => {
    const { code } = await jsonBody(request, pairSchema);
    return exchangePairingCode(sql, code);
  });
}
