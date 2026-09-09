import typescript from "@rollup/plugin-typescript";
import { defineConfig } from "rollup";

export default defineConfig({
  input: "src/plugin.ts",
  output: {
    dir: "com.barbatdev.ai-usage.sdPlugin/bin",
    format: "esm",
    entryFileNames: "plugin.js",
  },
  plugins: [typescript()],
  external: ["@elgato/streamdeck", /^node:/],
});
