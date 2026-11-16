import { agentCardResponse } from "@/lib/a2a-http";

type Context = { params: Promise<{ handle: string }> };

export async function GET(request: Request, { params }: Context) {
  return agentCardResponse(request, (await params).handle);
}
