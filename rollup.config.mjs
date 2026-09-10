import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { builtinModules } from "node:module";
import { defineConfig } from "rollup";

const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export default defineConfig({
  input: "src/plugin.ts",
  output: {
    dir: "com.refactor-ia.nan.sdPlugin/bin",
    format: "esm",
    entryFileNames: "plugin.js",
  },
  plugins: [
    nodeResolve({ preferBuiltins: true }),
    commonjs({ ignoreTryCatch: true }),
    typescript(),
  ],
  external: (id) => nodeBuiltins.has(id),
});
