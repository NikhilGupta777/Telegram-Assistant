import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    // Resolve the package's own subpath imports (./vms.js etc.) to source.
    conditions: ["workspace"],
  },
});
