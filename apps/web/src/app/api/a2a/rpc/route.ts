import { a2aRpcResponse } from "@/lib/a2a-http";

export async function POST(request: Request) { return a2aRpcResponse(request); }
