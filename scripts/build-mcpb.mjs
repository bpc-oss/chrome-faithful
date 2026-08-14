import { cp, mkdir, rm } from "node:fs/promises";
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

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
// Windows: spawnSync cannot exec .cmd files directly (EINVAL); route through
// the shell. Args are hard-coded constants (no injection surface).
const install = spawnSync(
  process.platform === "win32"
    ? `${npmCommand} ci --omit=dev --ignore-scripts`
    : npmCommand,
  process.platform === "win32" ? [] : ["ci", "--omit=dev", "--ignore-scripts"],
  {
    cwd: path.join(stage, "server"),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32"
  }
);
if (install.error) throw install.error;
if (install.status !== 0) {
  throw new Error(`production dependency install failed with exit code ${install.status}`);
}
process.stdout.write(stage + "\n");
