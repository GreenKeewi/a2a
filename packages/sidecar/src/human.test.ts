import { afterEach, expect, test, vi } from "vitest";

import { HumanApi, checkedOrigin, sessionCookie } from "./human.js";

afterEach(() => vi.unstubAllGlobals());

test("CLI only connects to HTTPS or loopback HTTP", () => {
  expect(checkedOrigin("https://a2a.example/path")).toBe("https://a2a.example");
  expect(checkedOrigin("http://127.0.0.1:4300")).toBe("http://127.0.0.1:4300");
  expect(() => checkedOrigin("http://a2a.example")).toThrow();
  expect(() => checkedOrigin("https://user:pass@a2a.example")).toThrow();
});

test("CLI stores only the Better Auth session cookie", () => {
  const response = new Response("{}", { headers: [
    ["set-cookie", "unrelated=abc; Path=/"],
    ["set-cookie", "better-auth.session_token=secret; HttpOnly; Secure; Path=/"],
  ] });
  expect(sessionCookie(response)).toBe("better-auth.session_token=secret");
});

test("human requests use the stored cookie and same origin", async () => {
  const fetcher = vi.fn(async (_url: URL, options: RequestInit) => {
    expect(options.headers).toMatchObject({ cookie: "better-auth.session_token=secret", origin: "https://a2a.example" });
    expect(options.body).toBe(JSON.stringify({ slug: "demo", name: "Demo" }));
    return Response.json({ data: { slug: "demo" }, error: null });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await new HumanApi("https://a2a.example", "better-auth.session_token=secret")
    .request("/api/workspaces", "POST", { slug: "demo", name: "Demo" })).toEqual({ slug: "demo" });
});
