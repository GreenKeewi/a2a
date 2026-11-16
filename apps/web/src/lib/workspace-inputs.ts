import { z } from "zod";

export const createWorkspaceSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60).refine((value) => value !== "join"),
});
