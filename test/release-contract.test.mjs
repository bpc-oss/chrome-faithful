import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

test("unit test command is shell-independent and excludes live harnesses", async () => {
  const packageJson = await readJson("package.json");

  assert.equal(packageJson.scripts.test, "node scripts/run-unit-tests.mjs");
  assert.doesNotMatch(packageJson.scripts.test, /[*?\[]/);
});

test("declared Node floor satisfies pinned production dependencies", async () => {
  const packageJson = await readJson("package.json");
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");

  assert.equal(packageJson.engines.node, ">=22.12.0");
  assert.doesNotMatch(workflow, /node-version:\s*20\b/);
});

test("all plugin manifests use the package release version", async () => {
  const [packageJson, extension, codex, claude, mcpb] = await Promise.all([
    readJson("package.json"),
    readJson("extension/manifest.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson(".claude-plugin/plugin.json"),
    readJson("mcpb/manifest.json")
  ]);

  assert.equal(extension.version, packageJson.version);
  assert.equal(codex.version, packageJson.version);
  assert.equal(claude.version, packageJson.version);
  assert.equal(mcpb.version, packageJson.version);
});

test("MCPB declares every server tool exactly once", async () => {
  const [serverSource, mcpb] = await Promise.all([
    readFile(new URL("src/mcp-server.mjs", root), "utf8"),
    readJson("mcpb/manifest.json")
  ]);
  const serverTools = [...serverSource.matchAll(/^\s{4}name: "(chrome_[^"]+)",$/gm)]
    .map((match) => match[1])
    .sort();
  const declaredTools = mcpb.tools.map((tool) => tool.name).sort();

  assert.deepEqual(declaredTools, serverTools);
});

test("compatibility contract contains no copied declaration text", async () => {
  const copiedFixtureExists = await readFile(
    new URL("compat/codex-26.721.41059-api.json", root)
  ).then(() => true, () => false);
  const contract = await readJson("compat/browser-surface-contract.json").catch(() => null);

  assert.equal(copiedFixtureExists, false);
  assert.ok(contract);
  assert.doesNotMatch(JSON.stringify(contract), /"declarations"\s*:/);
  assert.doesNotMatch(JSON.stringify(contract), /documentation:/);
});
