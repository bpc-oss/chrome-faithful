import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { normalizeLf } from "./text-normalization.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "extension", "generated");
const outputFile = path.join(outputDir, "puppeteer-runtime.js");
const metadataFile = path.join(outputDir, "puppeteer-runtime.manifest.json");
const puppeteerBrowserBundle = path.join(
  root,
  "node_modules",
  "puppeteer-core",
  "lib",
  "es5-iife",
  "puppeteer-core-browser.js"
);

await mkdir(outputDir, { recursive: true });
const puppeteerSource = normalizeLf(await readFile(puppeteerBrowserBundle, "utf8"));
const adapterSource = await readFile(
  path.join(root, "src", "extension-runtime", "entry.mjs"),
  "utf8"
);
if (/\blaunch\s*\(|remote-debugging-port|browserWSEndpoint/i.test(adapterSource)) {
  throw new Error("Extension runtime adapter must not expose a browser launcher or debugging port");
}
await build({
  entryPoints: [path.join(root, "src", "extension-runtime", "entry.mjs")],
  outfile: outputFile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  treeShaking: true,
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  charset: "utf8",
  logLevel: "warning",
  banner: {
    js: `${puppeteerSource}\nglobalThis.__agentOsPuppeteer = Object.freeze({connect: Puppeteer.connect, ExtensionTransport: Puppeteer.ExtensionTransport});`
  }
});

const bytes = await readFile(outputFile);
if (bytes.includes(Buffer.from("--remote-debugging-port"))) {
  throw new Error("Generated extension runtime contains a remote debugging port path");
}
const manifest = {
  entry: "src/extension-runtime/entry.mjs",
  output: "extension/generated/puppeteer-runtime.js",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  dependencies: {
    "puppeteer-core": "25.7.0",
    esbuild: "0.28.1"
  },
  transport: "ExtensionTransport.connectTab",
  browserLauncherExposed: false,
  browserLauncherInvoked: false,
  remoteDebuggingPortIncluded: false
};
await writeFile(metadataFile, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
