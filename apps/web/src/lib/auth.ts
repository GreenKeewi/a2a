import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";

import { db } from "./db";
import * as authSchema from "./auth-schema";

function required(name: string, minimumLength = 1): string {
  const value = process.env[name];
  if (!value || value.length < minimumLength) throw new Error(`${name} is required`);
  return value;
}

const baseURL = required("BETTER_AUTH_URL");
const base = new URL(baseURL);
if (process.env.NODE_ENV === "production" && base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname)) {
  throw new Error("BETTER_AUTH_URL must use HTTPS in production");
}

export const auth = betterAuth({
  baseURL,
  secret: required("BETTER_AUTH_SECRET", 32),
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
  advanced: { database: { generateId: "uuid" } },
  emailAndPassword: { enabled: false },
  socialProviders: {
    google: {
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
    },
  },
  plugins: [organization(), nextCookies()],
});
