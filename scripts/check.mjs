import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  ".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".mcp.json",
  "extension/manifest.json", "extension/service-worker.js", "extension/offscreen.js",
  "src/bridge-server.mjs", "src/mcp-server.mjs", "src/agent-browser.mjs", "src/file-injection.mjs"
];
for (const file of requiredFiles) await stat(path.join(root, file));
for (const file of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".mcp.json", "extension/manifest.json", "package.json"]) {
  JSON.parse(await readFile(path.join(root, file), "utf8"));
}
const source = await readFile(path.join(root, "src", "file-injection.mjs"), "utf8");
if (source.includes("DOM.setFileInputFiles") && !source.includes("never calls DOM.setFileInputFiles")) {
  throw new Error("Forbidden DOM.setFileInputFiles route found");
}
for (const token of ["DataTransfer", "new File", "Runtime.evaluate"]) {
  if (!source.includes(token)) throw new Error(`File injection is missing ${token}`);
}
const adapter = await readFile(path.join(root, "src", "agent-browser.mjs"), "utf8");
for (const token of ["createAgent", "metadata", "profileName", "capabilities", "playwright", "screenshot", "tabs"]) {
  if (!adapter.includes(token)) throw new Error(`Compatibility adapter is missing ${token}`);
}
const genericBoundaryFiles = [
  "README.md",
  "docs/CODEX_PARITY.md",
  "extension/options.html",
  "scripts/Install-AgentOsChromeExtension.ps1",
  "scripts/differential-acceptance.mjs",
  "scripts/live-acceptance.mjs",
  "scripts/mcp-smoke.mjs",
  "skills/control-chrome-cdp/SKILL.md"
];
const projectSpecificTokens = [
  "PRIVATE_PROJECT",
  "E:\\\\PRIVATE_PROJECT",
  "TikTok",
  "YouTube",
  "Douyin",
  "PersonalHandle",
  "PersonalName"
];
for (const file of genericBoundaryFiles) {
  const content = await readFile(path.join(root, file), "utf8");
  for (const token of projectSpecificTokens) {
    if (content.includes(token)) {
      throw new Error(`Generic plugin boundary contains project-specific token ${JSON.stringify(token)} in ${file}`);
    }
  }
}
process.stdout.write("CHECK_OK\n");
