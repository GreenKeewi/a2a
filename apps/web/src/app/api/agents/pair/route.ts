import { z } from "zod";

import { exchangePairingCode } from "@/lib/agents";
import { sql } from "@/lib/db";
import { jsonBody, respond } from "@/lib/http";
import { publicRealtimeConfig } from "@/lib/realtime";

const pairSchema = z.strictObject({ code: z.string().min(1).max(100), hostType: z.enum(["claude-code", "codex"]) });

export async function POST(request: Request) {
  return respond(async () => {
    const { code, hostType } = await jsonBody(request, pairSchema);
    const realtime = publicRealtimeConfig();
    return { ...(await exchangePairingCode(sql, code, hostType)), realtime };
  });
}
