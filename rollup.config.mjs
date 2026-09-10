import typescript from "@rollup/plugin-typescript";
import { defineConfig } from "rollup";

export default defineConfig({
  input: "src/plugin.ts",
  output: {
    dir: "com.refactor-ia.nan.sdPlugin/bin",
    format: "esm",
    entryFileNames: "plugin.js",
  },
  plugins: [typescript()],
  external: ["@elgato/streamdeck", /^node:/],
});
