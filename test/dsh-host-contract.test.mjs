import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "packages", "dsh-plugin-chrome-faithful");
const patchPath = path.join(bundlePath, "cordis.patch.yml");
const requireFromRoot = createRequire(path.join(root, "package.json"));

function makeToolRegistry() {
  const registered = new Set();
  return {
    registered,
    register(definition) {
      registered.add(definition.name);
      return () => registered.delete(definition.name);
    }
  };
}

async function assertFailLoudHostActivation({ explicitConfig }) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "chrome-faithful-dsh-host-"));
  const previousConfig = process.env.AGENTOS_CHROME_CONFIG;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  try {
    const profileRoot = path.join(tempRoot, "profile");
    const scopeRoot = path.join(profileRoot, "node_modules", "@bpc-oss");
    await mkdir(scopeRoot, { recursive: true });
    await cp(bundlePath, path.join(scopeRoot, "dsh-plugin-chrome-faithful"), { recursive: true });
    await symlink(root, path.join(profileRoot, "node_modules", "chrome-faithful"), "junction");
    const configPath = path.join(profileRoot, "cordis.yml");
    await writeFile(configPath, "[]\n");
    process.env.LOCALAPPDATA = path.join(tempRoot, "isolated-localappdata");
    if (explicitConfig) {
      process.env.AGENTOS_CHROME_CONFIG = path.join(tempRoot, "missing-config.json");
    } else {
      delete process.env.AGENTOS_CHROME_CONFIG;
    }

    const tools = makeToolRegistry();
    const patches = loadOverlayPatches("chrome-faithful-host-test", patchPath);
    const hostBaseUrl = pathToFileURL(path.join(root, "package.json")).href;
    await assert.rejects(
      boot(
        "chrome-faithful-host-test",
        configPath,
        patches,
        (ctx) => ctx.provide("tools", tools),
        hostBaseUrl
      ),
      /mcp-client\(chrome_faithful\): initial connection or tool synchronization failed/
    );
    assert.deepEqual([...tools.registered], [], "failed activation must leave no MCP tools");
  } finally {
    if (previousConfig === undefined) delete process.env.AGENTOS_CHROME_CONFIG;
    else process.env.AGENTOS_CHROME_CONFIG = previousConfig;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("published DSH rc.6 host rejects missing implicit Chrome config", async () => {
  const hostPackage = requireFromRoot("@deepseek-ai/dsh-app-boot/package.json");
  const mcpPackage = requireFromRoot("@deepseek-ai/dsh-mcp-client/package.json");
  assert.equal(hostPackage.version, "0.1.0-rc.6");
  assert.equal(mcpPackage.version, "0.1.0-rc.6");
  await assertFailLoudHostActivation({ explicitConfig: false });
});

test("published DSH rc.6 host rejects missing explicit Chrome config", async () => {
  await assertFailLoudHostActivation({ explicitConfig: true });
});
