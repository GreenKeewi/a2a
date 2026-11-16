import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/lib/auth-schema.ts", "./src/lib/app-schema.ts"],
  out: "../../supabase/drizzle-generated",
});
