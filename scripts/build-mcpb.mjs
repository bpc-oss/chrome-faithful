import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "dist", "agentos-chrome-cdp-mcpb");
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, "server"), { recursive: true });
await cp(path.join(root, "mcpb", "manifest.json"), path.join(stage, "manifest.json"));
for (const name of ["src", "node_modules", "package.json", "package-lock.json"]) {
  await cp(path.join(root, name), path.join(stage, "server", name), {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes(".bin")
  });
}
process.stdout.write(stage + "\n");
