import { defineConfig } from "vitest/config";

export default defineConfig({
  // Sign-in waits for the user in the browser.
  test: { testTimeout: 300_000, hookTimeout: 300_000 },
});
