import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Database fixtures create cluster-wide roles; run files serially to avoid role creation races.
  test: { testTimeout: 20_000, fileParallelism: false },
});
