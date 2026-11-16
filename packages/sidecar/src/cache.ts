import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

export const headerSchema = z.strictObject({
  id: z.uuid(), threadId: z.uuid(), type: z.enum(["blocker", "question", "handoff", "decision", "fyi"]),
  priority: z.enum(["low", "normal", "high"]), subject: z.string(), senderHandle: z.string(),
  createdAt: z.iso.datetime(), unread: z.boolean(),
});
export type InboxHeader = z.infer<typeof headerSchema>;
export const cacheSchema = z.strictObject({
  version: z.literal(1), headers: z.array(headerSchema).max(100), newestId: z.uuid().nullable(),
  briefing: z.unknown().nullable(), briefingVersion: z.number().int().nonnegative(),
  lastSyncedAt: z.iso.datetime().nullable(), connection: z.enum(["offline", "connecting", "online"]),
});
export type SidecarCache = z.infer<typeof cacheSchema>;

export function emptyCache(): SidecarCache {
  return { version: 1, headers: [], newestId: null, briefing: null, briefingVersion: 0, lastSyncedAt: null, connection: "offline" };
}

export async function readCache(path: string): Promise<SidecarCache> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") return emptyCache();
    throw error;
  }
  try { return cacheSchema.parse(JSON.parse(raw)); }
  catch {
    await rename(path, `${path}.corrupt.${Date.now()}`);
    return emptyCache();
  }
}

export async function writeCache(path: string, value: SidecarCache) {
  const parsed = cacheSchema.parse(value);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
