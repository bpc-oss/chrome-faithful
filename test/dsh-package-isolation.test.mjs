import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...options
  });
}

async function pack(source, destination) {
  const { stdout } = await run(
    npmCommand,
    ["pack", path.resolve(root, source), "--pack-destination", destination, "--json"],
    { cwd: root }
  );
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1);
  return path.join(destination, result[0].filename);
}

test("paired tarballs resolve the bundle launcher without a .bin PATH", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "chrome-faithful-dsh-install-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const coreTarball = await pack(".", tempRoot);
  const bundleTarball = await pack("packages/dsh-plugin-chrome-faithful", tempRoot);
  const profileRoot = path.join(tempRoot, "profile");
  await mkdir(profileRoot, { recursive: true });
  await writeFile(
    path.join(profileRoot, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "chrome-faithful": pathToFileURL(coreTarball).href,
        "@bpc-oss/dsh-plugin-chrome-faithful": pathToFileURL(bundleTarball).href
      }
    }, null, 2) + "\n"
  );
  await run(
    npmCommand,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: profileRoot }
  );

  const requireFromProfile = createRequire(path.join(profileRoot, "package.json"));
  const launcher = requireFromProfile.resolve(
    "@bpc-oss/dsh-plugin-chrome-faithful/mcp-server"
  );
  const legacyCoreEntry = requireFromProfile.resolve("chrome-faithful/src/index.mjs");
  assert.equal(path.isAbsolute(launcher), true);
  assert.doesNotMatch(launcher, /node_modules[\\/]\.bin/);
  assert.match(legacyCoreEntry, /chrome-faithful[\\/]src[\\/]index\.mjs$/);

  const missingConfig = path.join(tempRoot, "missing-config.json");
  const child = await run(process.execPath, [launcher], {
    cwd: profileRoot,
    env: {
      ...process.env,
      PATH: path.dirname(process.execPath),
      AGENTOS_CHROME_CONFIG: missingConfig
    }
  }).then(
    (result) => ({ ...result, exitCode: 0 }),
    (error) => ({ stdout: error.stdout, stderr: error.stderr, exitCode: error.code })
  );

  assert.notEqual(child.exitCode, 0);
  assert.match(String(child.stderr), /Agent OS Chrome CDP config is unavailable at/);
  assert.match(String(child.stderr), new RegExp(missingConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("both CI jobs execute the DSH package isolation proof", async () => {
  const workflow = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  const isolationInvocations = workflow.match(/test\/dsh-package-isolation\.test\.mjs/g) || [];
  const hostInvocations = workflow.match(/test\/dsh-host-contract\.test\.mjs/g) || [];

  assert.equal(isolationInvocations.length, 2);
  assert.equal(hostInvocations.length, 2);
});
