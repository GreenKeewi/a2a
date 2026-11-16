import { auth } from "@/lib/auth";
import { requireHuman, requireSameOrigin, jsonBody, respond } from "@/lib/http";
import { sql } from "@/lib/db";
import { listWorkspaces } from "@/lib/workspaces";
import { createWorkspaceSchema } from "@/lib/workspace-inputs";

export async function GET(request: Request) {
  return respond(async () => listWorkspaces(sql, await requireHuman(request)));
}

export async function POST(request: Request) {
  return respond(async () => {
    requireSameOrigin(request);
    await requireHuman(request);
    const body = await jsonBody(request, createWorkspaceSchema);
    const organization = await auth.api.createOrganization({
      headers: request.headers,
      body: { name: body.name, slug: body.slug },
    });
    if (!organization) throw new Error("Organization creation failed");
    return { organizationId: organization.id, slug: organization.slug };
  });
}
