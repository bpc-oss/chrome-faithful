import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const manifest = JSON.parse(await readFile(
  new URL("extension/generated/puppeteer-runtime.manifest.json", root),
  "utf8"
));
const bundle = await readFile(
  new URL("extension/generated/puppeteer-runtime.js", root)
);
const adapterSource = await readFile(
  new URL("src/extension-runtime/entry.mjs", root),
  "utf8"
);

test("pins the extension automation dependencies", () => {
  assert.equal(packageJson.dependencies["puppeteer-core"], "24.35.0");
  assert.equal(packageJson.devDependencies.esbuild, "0.28.1");
});

test("records the deterministic extension runtime hash", () => {
  assert.equal(
    createHash("sha256").update(bundle).digest("hex"),
    manifest.sha256
  );
  assert.equal(manifest.transport, "ExtensionTransport.connectTab");
});

test("exposes only connect and ExtensionTransport from Puppeteer", () => {
  assert.match(
    bundle.toString("utf8"),
    /globalThis\.__agentOsPuppeteer\s*=\s*Object\.freeze\(\{connect:/
  );
  assert.equal(manifest.browserLauncherExposed, false);
  assert.equal(manifest.browserLauncherInvoked, false);
});

test("contains no adapter path for a launcher or debugging port", () => {
  assert.doesNotMatch(adapterSource, /\blaunch\s*\(|remote-debugging-port|browserWSEndpoint/i);
  assert.equal(bundle.includes(Buffer.from("--remote-debugging-port")), false);
  assert.equal(manifest.remoteDebuggingPortIncluded, false);
});
