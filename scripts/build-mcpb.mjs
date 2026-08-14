import { access, cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "dist", "agentos-chrome-cdp-mcpb");
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, "server"), { recursive: true });
await cp(path.join(root, "mcpb", "manifest.json"), path.join(stage, "manifest.json"));
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(path.join(root, name), path.join(stage, name));
}
for (const name of ["src", "package.json", "package-lock.json"]) {
  await cp(path.join(root, name), path.join(stage, "server", name), {
    recursive: true
  });
}
const ppocrTarget = path.join(stage, "server", "integrations", "ppocr");
await mkdir(path.dirname(ppocrTarget), { recursive: true });
await cp(path.join(root, "integrations", "ppocr"), ppocrTarget, { recursive: true });
await access(path.join(ppocrTarget, "ppocrv5_mobile.py"));

const npmExecPath = process.env.npm_execpath;
if (process.platform === "win32" && !npmExecPath) {
  throw new Error("build:mcpb must be started through npm so its JavaScript entry point is available");
}
const npmCommand = npmExecPath ? process.execPath : "npm";
const npmArgs = npmExecPath
  ? [npmExecPath, "ci", "--omit=dev", "--ignore-scripts"]
  : ["ci", "--omit=dev", "--ignore-scripts"];
const install = spawnSync(npmCommand, npmArgs, {
  cwd: path.join(stage, "server"),
  env: process.env,
  stdio: "inherit"
});
if (install.error) throw install.error;
if (install.status !== 0) {
  throw new Error(`production dependency install failed with exit code ${install.status}`);
}
process.stdout.write(stage + "\n");
