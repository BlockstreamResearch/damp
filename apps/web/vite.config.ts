import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ["buffer", "events", "stream"] })],
  base: process.env.GITHUB_ACTIONS ? "/simplicity-amp/" : "/",
  build: { target: "es2022" },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
