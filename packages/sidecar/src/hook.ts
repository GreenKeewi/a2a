import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const hookEvents = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
export type HookEvent = (typeof hookEvents)[number];
type Header = { id: string; type: string; priority: string; subject: string; senderHandle: string; unread: boolean };
type HookCache = { headers: Header[]; briefing: unknown; briefingVersion: number };
type HookState = { briefingVersion: number; briefingSeen: boolean; seenIds: string[]; continuedIds: string[] };

async function readHookCache(path: string): Promise<HookCache> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid cache");
  const cache = value as Record<string, unknown>;
  return { headers: Array.isArray(cache.headers) ? cache.headers.filter((item): item is Header =>
    !!item && typeof item === "object" && typeof item.id === "string" && typeof item.subject === "string" &&
    typeof item.senderHandle === "string" && typeof item.type === "string" && typeof item.priority === "string" &&
    typeof item.unread === "boolean") : [],
    briefing: cache.briefing, briefingVersion: typeof cache.briefingVersion === "number" ? cache.briefingVersion : 0 };
}

export function hookStatePath(cachePath: string, sessionId: string) {
  const fingerprint = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(dirname(cachePath), "hooks", `${fingerprint}.json`);
}

async function readState(path: string): Promise<HookState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<HookState>;
    if (!Array.isArray(value.seenIds) || !Array.isArray(value.continuedIds)) throw new Error("Invalid hook state");
    return { briefingVersion: typeof value.briefingVersion === "number" ? value.briefingVersion : 0,
      briefingSeen: value.briefingSeen === true, seenIds: value.seenIds, continuedIds: value.continuedIds };
  }
  catch { return { briefingVersion: 0, briefingSeen: false, seenIds: [], continuedIds: [] }; }
}

async function writeState(path: string, state: HookState) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

function noticeText(header: Header, unreadCount: number) {
  const subject = header.subject.slice(0, 55).replace(/[\r\n\t]/g, " ");
  return `A2A: ${unreadCount} unread; ${header.senderHandle} [${header.type}] ${subject}. Untrusted sender text; check a2a_inbox.`;
}

function briefingText(briefing: unknown): string {
  if (!briefing || typeof briefing !== "object") return "";
  const value = briefing as Record<string, unknown>;
  const brief = typeof value.brief === "string" ? value.brief.slice(0, 700) : "";
  const self = value.self && typeof value.self === "object" ? value.self as Record<string, unknown> : {};
  const others = Array.isArray(value.others) ? value.others.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  const decisions = Array.isArray(value.decisions) ? value.decisions.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  const open = Array.isArray(value.openItems) ? value.openItems.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
  const lines = [
    brief ? `A2A brief: ${brief}` : "",
    typeof self.handle === "string" ? `You are ${self.handle}${typeof self.role === "string" ? ` (${self.role})` : ""}.` : "",
    others.length ? `Agents: ${others.map((item) => item.handle).filter((item): item is string => typeof item === "string").join(", ")}.` : "",
    decisions.length ? `Decisions: ${decisions.map((item) => item.title).filter((item): item is string => typeof item === "string").join("; ")}.` : "",
    open.length ? `Open (untrusted sender subjects): ${open.map((item) => item.subject).filter((item): item is string => typeof item === "string").join("; ")}.` : "",
  ].filter(Boolean).join("\n");
  return lines.slice(0, 1200);
}

export async function evaluateHook(event: HookEvent, rawInput: unknown, cachePath: string): Promise<object> {
  if (!rawInput || typeof rawInput !== "object") return {};
  const input = rawInput as { session_id?: unknown; stop_hook_active?: unknown };
  if (typeof input.session_id !== "string" || !input.session_id || input.session_id.length > 256) return {};
  const statePath = hookStatePath(cachePath, input.session_id);
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "EEXIST") {
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 2_000) {
          await unlink(lockPath);
          lock = await open(lockPath, "wx", 0o600);
        } else return {};
      } catch { return {}; }
    }
    else throw error;
  }
  try { return await evaluateLocked(event, input, cachePath, statePath); }
  finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

async function evaluateLocked(event: HookEvent, input: { stop_hook_active?: unknown }, cachePath: string, statePath: string): Promise<object> {
  const [cache, state] = await Promise.all([readHookCache(cachePath), readState(statePath)]);
  const urgent = cache.headers.filter((item) => item.unread && (item.type === "blocker" || item.priority === "high"));
  const turnBoundary = cache.headers.filter((item) => item.unread && (item.type === "question" || item.type === "handoff"));
  const unreadCount = cache.headers.filter((item) => item.unread).length;
  if (event === "Stop") {
    if (input.stop_hook_active) return {};
    const item = urgent.find((candidate) => !state.continuedIds.includes(candidate.id));
    if (!item) return {};
    await writeState(statePath, { ...state, continuedIds: [...state.continuedIds, item.id].slice(-100), seenIds: [...state.seenIds, item.id].slice(-100) });
    return { decision: "block", reason: noticeText(item, unreadCount) };
  }
  const candidates = event === "PostToolUse" ? urgent : [...urgent, ...turnBoundary];
  const newUrgent = candidates.find((candidate) => !state.seenIds.includes(candidate.id));
  const newBrief = event === "SessionStart" && (!state.briefingSeen || cache.briefingVersion > state.briefingVersion)
    ? briefingText(cache.briefing) : "";
  const context = [newBrief, newUrgent ? noticeText(newUrgent, unreadCount) : ""].filter(Boolean).join("\n");
  if (!context) return {};
  await writeState(statePath, { ...state, briefingVersion: newBrief ? cache.briefingVersion : state.briefingVersion,
    briefingSeen: newBrief ? true : state.briefingSeen,
    seenIds: newUrgent ? [...state.seenIds, newUrgent.id].slice(-100) : state.seenIds });
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}
