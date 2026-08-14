import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperUrl = pathToFileURL(path.join(root, "scripts", "dsh-bundle-contract.mjs"));
const patchPath = path.join(root, "packages", "dsh-plugin-chrome-faithful", "cordis.patch.yml");
const bundlePath = path.join(root, "packages", "dsh-plugin-chrome-faithful");

async function loadHelper() {
  const loaded = await import(helperUrl.href).catch(() => null);
  assert.ok(loaded, "DSH bundle contract helper must exist");
  return loaded;
}

async function makeProfileRoot() {
  const profileRoot = await mkdtemp(path.join(tmpdir(), "chrome-faithful-dsh-contract-"));
  await writeFile(path.join(profileRoot, "package.json"), '{"private":true}\n');
  const scope = path.join(profileRoot, "node_modules", "@bpc-oss");
  await mkdir(scope, { recursive: true });
  await symlink(bundlePath, path.join(scope, "dsh-plugin-chrome-faithful"), "junction");
  return profileRoot;
}

test("evaluates the DSH bundle row with no optional config", async () => {
  const { loadDshBundlePatch } = await loadHelper();
  const profileRoot = await makeProfileRoot();
  const result = await loadDshBundlePatch({
    patchPath,
    baseUrl: path.join(profileRoot, "package.json"),
    environment: {}
  });

  assert.deepEqual(result, {
    id: "chrome-faithful-mcp",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "chrome_faithful",
      transport: "stdio",
      command: process.execPath,
      args: [path.join(bundlePath, "bin", "chrome-faithful-mcp.mjs")],
      env: {},
      toolCallTimeoutMs: 60000,
      failOnStartupError: true
    }
  });
});

test("evaluates and validates the explicit config environment branch", async () => {
  const { loadDshBundlePatch, validateDshMcpConfig } = await loadHelper();
  const profileRoot = await makeProfileRoot();
  const configPath = path.join(profileRoot, "external-config.json");
  const result = await loadDshBundlePatch({
    patchPath,
    baseUrl: path.join(profileRoot, "package.json"),
    environment: { AGENTOS_CHROME_CONFIG: configPath }
  });

  assert.deepEqual(result.config.env, { AGENTOS_CHROME_CONFIG: configPath });
  assert.deepEqual(validateDshMcpConfig(result.config), result.config);
  assert.throws(
    () => validateDshMcpConfig({ ...result.config, env: { AGENTOS_CHROME_CONFIG: undefined } }),
    /environment values must be strings/
  );
});
