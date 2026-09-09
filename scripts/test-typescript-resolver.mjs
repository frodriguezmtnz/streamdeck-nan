import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedParents = [resolve(root, "src"), resolve(root, "test")];

function isInside(path, directory) {
  const value = relative(directory, path);
  return value === "" || (!value.startsWith("..") && !value.includes(":"));
}

export function typescriptFallback(specifier, parentURL) {
  if (!parentURL?.startsWith("file:") || !specifier.startsWith(".") || !specifier.endsWith(".js")) return undefined;
  const parent = fileURLToPath(parentURL);
  if (!allowedParents.some((directory) => isInside(parent, directory))) return undefined;
  const candidate = fileURLToPath(new URL(`${specifier.slice(0, -3)}.ts`, parentURL));
  if (!allowedParents.some((directory) => isInside(candidate, directory)) || !existsSync(candidate)) return undefined;
  return pathToFileURL(candidate).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      const candidate = typescriptFallback(specifier, context.parentURL);
      if (!candidate) throw error;
      return nextResolve(candidate, context);
    }
  },
});
