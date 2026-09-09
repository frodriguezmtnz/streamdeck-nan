import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function validateRemoteAssets(release, expectedNames, allowMissing = false) {
  if (!release?.isDraft) throw new Error("refusing to mutate a published release");
  const names = release.assets?.map(({ name }) => name) ?? [];
  if (new Set(names).size !== names.length) throw new Error("release contains duplicate asset names");
  const unexpected = names.filter((name) => !expectedNames.includes(name));
  const missing = expectedNames.filter((name) => !names.includes(name));
  if (!allowMissing && (unexpected.length || missing.length)) {
    throw new Error(`release asset allowlist mismatch; unexpected=${unexpected.join(",") || "none"}; missing=${missing.join(",") || "none"}`);
  }
  return { unexpected, missing };
}

function view(tag) {
  return JSON.parse(execFileSync("gh", ["release", "view", tag, "--json", "isDraft,assets"], { encoding: "utf8" }));
}

export function reconcileDraftAssets(tag, expectedNames, mode) {
  const before = validateRemoteAssets(view(tag), expectedNames, mode === "clean");
  if (mode === "clean") {
    for (const name of before.unexpected) execFileSync("gh", ["release", "delete-asset", tag, name, "--yes"], { stdio: "inherit" });
    const cleaned = validateRemoteAssets(view(tag), expectedNames, true);
    if (cleaned.unexpected.length) throw new Error("failed to remove unexpected draft release assets");
  } else if (mode !== "exact") {
    throw new Error("mode must be clean or exact");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [tag, mode, ...expectedNames] = process.argv.slice(2);
  if (!tag || expectedNames.length !== 2) throw new Error("usage: release-assets.mjs <tag> <clean|exact> <plugin> SHA256SUMS");
  reconcileDraftAssets(tag, expectedNames, mode);
}
