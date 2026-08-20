import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const repositoryName = process.env.GITHUB_REPOSITORY?.split("/").pop();

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ["buffer", "events", "stream", "util"] })],
  base: repositoryName ? `/${repositoryName}/` : "/",
  build: { target: "es2022" },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
