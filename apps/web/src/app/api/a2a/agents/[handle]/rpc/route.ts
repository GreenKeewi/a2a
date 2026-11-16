import { a2aRpcResponse } from "@/lib/a2a-http";

type Context = { params: Promise<{ handle: string }> };

export async function POST(request: Request, { params }: Context) {
  return a2aRpcResponse(request, (await params).handle);
}
