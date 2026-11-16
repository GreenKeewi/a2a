import { sql } from "@/lib/db";
import { requireHuman, respond } from "@/lib/http";
import { readWorkspace, resolveWorkspaceId } from "@/lib/workspaces";

type Context = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const userId = await requireHuman(request);
    const organizationId = await resolveWorkspaceId(sql, (await params).slug, userId);
    const workspace = await readWorkspace(sql, organizationId, userId);
    const [decisions, openItems] = await Promise.all([
      sql`SELECT id, title, summary, status, created_at FROM decision_records
          WHERE organization_id = ${organizationId} ORDER BY created_at DESC LIMIT 50`,
      sql`SELECT m.id, m.thread_id, m.type, m.subject, m.body, m.created_at,
                 coalesce(a.handle, u.name, 'Member') AS sender
          FROM messages m LEFT JOIN agents a ON a.id = m.sender_agent_id
          LEFT JOIN "user" u ON u.id = m.sender_user_id
          WHERE m.organization_id = ${organizationId} AND m.response_state = 'open'
            AND m.type IN ('blocker', 'question')
          ORDER BY m.created_at DESC LIMIT 50`,
    ]);
    return { brief: workspace.brief, briefVersion: workspace.briefVersion, decisions, openItems };
  });
}
