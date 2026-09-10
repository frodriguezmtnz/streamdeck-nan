import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "com.refactor-ia.nan.sdPlugin";
const optionalWsAccelerators = new Set(["bufferutil", "utf-8-validate"]);
const runtimeLicenses = [
  ["@elgato/streamdeck", "2.1.0", "node_modules/@elgato/streamdeck/LICENSE"],
  ["@elgato/schemas", "0.4.15", "node_modules/.pnpm/@elgato+schemas@0.4.15/node_modules/@elgato/schemas/LICENSE"],
  ["@elgato/utils", "0.4.5", "node_modules/.pnpm/@elgato+utils@0.4.5/node_modules/@elgato/utils/LICENSE"],
  ["zod", "3.25.76", "node_modules/.pnpm/zod@3.25.76/node_modules/zod/LICENSE"],
  ["ws", "8.21.0", "node_modules/.pnpm/ws@8.21.0/node_modules/ws/LICENSE"],
];
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
}

function isStringLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function collectModuleSites(source) {
  const sourceFile = ts.createSourceFile("plugin.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = [];

  function add(kind, node, optional) {
    if (isStringLiteral(node)) {
      sites.push({ kind, specifier: node.text, optional });
    } else {
      sites.push({ kind, specifier: "<dynamic>", optional });
    }
  }

  function visit(node, optional = false) {
    if (ts.isTryStatement(node)) {
      ts.forEachChild(node.tryBlock, (child) => visit(child, node.catchClause !== undefined));
      if (node.catchClause) ts.forEachChild(node.catchClause, (child) => visit(child, false));
      if (node.finallyBlock) ts.forEachChild(node.finallyBlock, (child) => visit(child, false));
      return;
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add("import", node.moduleSpecifier, optional);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression) add("import-equals", expression, optional);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add("dynamic-import", node.arguments[0], optional);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add("require", node.arguments[0], optional);
      }
    }

    ts.forEachChild(node, (child) => visit(child, optional));
  }

  visit(sourceFile);
  return sites;
}

function unsupportedModuleSites(sites) {
  return sites.filter(({ kind, specifier, optional }) => {
    if (nodeBuiltins.has(specifier)) return false;
    if (optional && kind === "require" && optionalWsAccelerators.has(specifier)) return false;
    return true;
  });
}

async function packageAndExtract() {
  run(process.execPath, ["node_modules/rollup/dist/bin/rollup", "-c"]);
  run(process.execPath, ["scripts/pack-streamdeck.mjs"]);

  const artifacts = (await readdir(join(repositoryRoot, "dist"))).filter((name) => name.endsWith(".streamDeckPlugin"));
  assert.deepEqual(artifacts, ["com.refactor-ia.nan.streamDeckPlugin"]);

  const directory = await mkdtemp(join(tmpdir(), "streamdeck-standalone-package-"));
  const artifact = join(repositoryRoot, "dist", artifacts[0]);
  run("unzip", ["-qq", artifact, "-d", directory]);
  await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
  return { directory, plugin: join(directory, pluginName, "bin", "plugin.js") };
}

test("fresh package contains a standalone plugin bundle", async (t) => {
  const { directory, plugin } = await packageAndExtract();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const source = await readFile(plugin, "utf8");
  const sites = collectModuleSites(source);
  const unsupported = unsupportedModuleSites(sites);
  const sdkLeak = unsupported.find((site) => site.specifier === "@elgato/streamdeck");

  if (sdkLeak) {
    const resolution = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", 'await import(process.argv[1]);', plugin],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(resolution.status, 0, "the isolated harness unexpectedly resolved the leaked SDK import");
    assert.match(`${resolution.stdout}${resolution.stderr}`, /MODULE_NOT_FOUND/, "the isolated harness did not demonstrate the SDK resolution failure");
  }

  assert.deepEqual(unsupported, [], `unresolved packaged module sites: ${JSON.stringify(unsupported)}`);
  assert.ok(sites.some((site) => nodeBuiltins.has(site.specifier)), "Node builtins must remain external");

  const rootNotices = await readFile(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"));
  const packagedNotices = await readFile(join(directory, pluginName, "THIRD_PARTY_NOTICES.md"));
  assert.deepEqual(packagedNotices, rootNotices, "packaged third-party notices must exactly match the root notices");

  const rootNoticeText = rootNotices.toString("utf8");
  for (const [name, version, licensePath] of runtimeLicenses) {
    assert.ok(rootNoticeText.includes(`## ${name} ${version}`), `missing ${name} ${version} notice heading`);
    assert.ok(rootNoticeText.includes((await readFile(join(repositoryRoot, licensePath), "utf8")).replaceAll("\r\n", "\n").trimEnd()), `missing ${name} license text`);
  }
});
