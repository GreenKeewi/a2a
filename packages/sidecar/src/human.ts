import { Entry } from "@napi-rs/keyring";

export function checkedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("The server URL must use HTTPS (or localhost HTTP).");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Use a server URL without credentials or a query string.");
  return url.origin;
}

export function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  const session = cookies.map((value) => value.split(";", 1)[0] ?? "")
    .find((value) => /^(?:__Secure-)?better-auth\.session_token=/.test(value));
  if (!session) throw new Error("The server did not issue a CLI session. Check the server auth configuration.");
  return session;
}

export class HumanApi {
  readonly origin: string;
  constructor(url: string, private readonly cookie?: string) { this.origin = checkedOrigin(url); }

  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.origin), {
      method,
      headers: {
        accept: "application/json", origin: this.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof value === "object" && value !== null && "error" in value &&
        typeof value.error === "object" && value.error !== null && "code" in value.error ? String(value.error.code) : `HTTP_${response.status}`;
      throw new Error(`${method} ${path}: ${code}`);
    }
    if (typeof value !== "object" || value === null || !("data" in value)) throw new Error("Unexpected API response.");
    return value.data as T;
  }

  async authenticate(mode: "sign-in" | "sign-up", email: string, password: string, name?: string): Promise<string> {
    const response = await fetch(new URL(`/api/auth/${mode}/email`, this.origin), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", origin: this.origin },
      body: JSON.stringify(mode === "sign-up" ? { email, password, name } : { email, password }),
    });
    if (!response.ok) throw new Error(`${mode} failed (HTTP ${response.status}).`);
    return sessionCookie(response);
  }

  async signOut(): Promise<void> {
    if (!this.cookie) return;
    const response = await fetch(new URL("/api/auth/sign-out", this.origin), {
      method: "POST", headers: { origin: this.origin, cookie: this.cookie },
    });
    if (!response.ok) throw new Error(`Account sign-out failed (HTTP ${response.status}).`);
  }
}

export class HumanCredentialStore {
  private entry(origin: string) { return new Entry("a2a-human", checkedOrigin(origin)); }
  async get(origin: string): Promise<string> {
    const value = this.entry(origin).getPassword();
    if (!value) throw new Error("No account session. Run a2a login first.");
    return value;
  }
  async set(origin: string, cookie: string) { this.entry(origin).setPassword(cookie); }
  async delete(origin: string) { this.entry(origin).deletePassword(); }
}
