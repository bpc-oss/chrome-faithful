import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

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
  assert.equal(extension.version_name, packageJson.version);
  assert.equal(codex.version, packageJson.version);
  assert.equal(claude.version, packageJson.version);
  assert.equal(mcpb.version, packageJson.version);
});

test("public display metadata uses the Chrome Faithful brand", async () => {
  const [extension, codex, mcpb] = await Promise.all([
    readJson("extension/manifest.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson("mcpb/manifest.json")
  ]);

  assert.equal(extension.name, "Chrome Faithful");
  assert.equal(extension.action.default_title, "Chrome Faithful");
  assert.equal(codex.interface.displayName, "Chrome Faithful");
  assert.equal(mcpb.display_name, "Chrome Faithful");
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

test("npm package uses an explicit runtime allowlist", async () => {
  const packageJson = await readJson("package.json");

  assert.ok(Array.isArray(packageJson.files));
  assert.ok(packageJson.files.includes("src/"));
  assert.ok(packageJson.files.includes("extension/"));
  assert.ok(packageJson.files.includes("compat/"));
  assert.ok(packageJson.files.includes("mcpb/"));
  assert.equal(packageJson.files.some((entry) => /^(test|reports|docs\/superpowers)\/?/.test(entry)), false);
});

test("MCPB build installs the lockfile-defined production dependency tree", async () => {
  const source = await readFile(new URL("scripts/build-mcpb.mjs", root), "utf8");

  assert.match(source, /npm(?:\.cmd)?["']?/);
  assert.match(source, /\bci\b/);
  assert.match(source, /--omit=dev/);
  assert.doesNotMatch(source, /["']node_modules["']/);
});

test("CI grants read-only contents access and pins actions by commit", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const actionRefs = [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);

  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.ok(actionRefs.length > 0);
  assert.equal(actionRefs.every((ref) => /^[0-9a-f]{40}$/.test(ref)), true);
});

test("extension limits host access to its localhost bridge", async () => {
  const manifest = await readJson("extension/manifest.json");

  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
});

test("DSH bundle has a stable public launcher and exact core version", async () => {
  const [rootPackage, bundle] = await Promise.all([
    readJson("package.json"),
    readJson("packages/dsh-plugin-chrome-faithful/package.json")
  ]);
  const launcher = await readFile(
    new URL("packages/dsh-plugin-chrome-faithful/bin/chrome-faithful-mcp.mjs", root),
    "utf8"
  );

  assert.equal(rootPackage.exports["./mcp-server"], "./src/mcp-server.mjs");
  assert.equal(rootPackage.exports["./src/*"], "./src/*");
  assert.equal(bundle.name, "@bpc-oss/dsh-plugin-chrome-faithful");
  assert.equal(bundle.version, rootPackage.version);
  assert.equal(bundle.dependencies["chrome-faithful"], rootPackage.version);
  assert.equal(bundle.peerDependencies?.["@deepseek-ai/dsh-mcp-client"], undefined);
  assert.equal(bundle.dependencies?.["@deepseek-ai/dsh-mcp-client"], undefined);
  assert.equal(bundle.engines.node, rootPackage.engines.node);
  assert.equal(bundle.dsh.bundle.patch, "./cordis.patch.yml");
  assert.deepEqual(bundle.files, ["bin/", "cordis.patch.yml", "README.md", "LICENSE"]);
  assert.equal(bundle.exports["./mcp-server"], "./bin/chrome-faithful-mcp.mjs");
  assert.equal(bundle.bin["chrome-faithful-mcp"], "./bin/chrome-faithful-mcp.mjs");

  assert.match(launcher, /^#!\/usr\/bin\/env node\nimport "chrome-faithful\/mcp-server";\n$/);
  assert.doesNotMatch(launcher, /\b(?:spawn|exec|shell|catch|fallback)\b/i);
});

test("third-party notices cover every direct package dependency", async () => {
  const packageJson = await readJson("package.json");
  const notices = await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
  const directPackages = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {})
  ];

  for (const packageName of directPackages) {
    assert.match(notices, new RegExp(`^## ${packageName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "m"));
  }
  assert.doesNotMatch(notices, /deepseek-harness\/tree\/(?:main|master)\//);
  assert.equal(
    (notices.match(/deepseek-harness\/tree\/47f943859bef60e4160492346772ded9b24f765a\//g) ?? []).length,
    2
  );
});

async function dryRunPack(cwd) {
  const { stdout } = await execFileAsync(
    npmCommand,
    ["pack", "--dry-run", "--json"],
    { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
  );
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1);
  return result[0].files.map((entry) => entry.path).sort();
}

test("core and DSH bundle publish independent allowlisted artifacts", async () => {
  const [coreFiles, bundleFiles] = await Promise.all([
    dryRunPack(rootPath),
    dryRunPack(path.join(rootPath, "packages", "dsh-plugin-chrome-faithful"))
  ]);
  const forbidden = /^(?:test|reports|tmp|docs\/superpowers|config\/local(?:\.json)?)(?:\/|$)/;

  assert.equal(coreFiles.some((entry) => forbidden.test(entry)), false);
  assert.equal(coreFiles.some((entry) => entry.startsWith("packages/dsh-plugin-chrome-faithful/")), false);
  assert.equal(bundleFiles.some((entry) => forbidden.test(entry)), false);
  assert.deepEqual(bundleFiles, [
    "LICENSE",
    "README.md",
    "bin/chrome-faithful-mcp.mjs",
    "cordis.patch.yml",
    "package.json"
  ]);
});
