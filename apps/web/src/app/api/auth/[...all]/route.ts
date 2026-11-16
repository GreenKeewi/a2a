import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "../../../../lib/auth";

const handlers = toNextJsHandler(auth);

function organizationRoute(request: Request) {
  try {
    const path = decodeURIComponent(new URL(request.url).pathname);
    return path === "/api/auth/organization" || path.startsWith("/api/auth/organization/");
  } catch {
    return true;
  }
}

export function GET(request: Request) {
  if (organizationRoute(request)) return new Response("Not Found", { status: 404 });
  return handlers.GET(request);
}

export function POST(request: Request) {
  if (organizationRoute(request)) return new Response("Not Found", { status: 404 });
  return handlers.POST(request);
}
