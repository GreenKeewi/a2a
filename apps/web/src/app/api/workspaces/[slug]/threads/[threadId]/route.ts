import { z } from "zod";

import { sql } from "@/lib/db";
import { getHumanThread } from "@/lib/human-dashboard";
import { requireHuman, respond } from "@/lib/http";
import { resolveWorkspaceId, WorkspaceError } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string; threadId: string }> };
export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const { slug, threadId } = await params;
    if (!z.uuid().safeParse(threadId).success) throw new WorkspaceError("INVALID_REQUEST");
    const organizationId = await resolveWorkspaceId(sql, slug, userId);
    return getHumanThread(sql, organizationId, threadId);
  });
}
