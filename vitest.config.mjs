import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.spec.js"],
        // Each spec file boots its own parse-server + in-memory MongoDB; give them room.
        testTimeout: 60000,
        hookTimeout: 120000,
        // Default pool (forks) gives each spec file its own process, which matters because
        // cloud code registers triggers in process-global state.
        pool: "forks",
    },
});
