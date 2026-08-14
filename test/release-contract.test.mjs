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
