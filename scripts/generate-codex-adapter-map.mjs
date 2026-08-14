import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await readFile(path.join(root, "compat", "codex-26.721.41059-api.json"), "utf8"));

const owner = {
  Agent: "createAgent",
  Browsers: "createAgent.browsers",
  Browser: "ChromeBrowser",
  BrowserUser: "ChromeBrowser.user",
  Tabs: "ChromeBrowser.tabs",
  Tab: "ChromeTab",
  ContentAPI: "ChromeTab.content",
  CUAAPI: "ChromeTab.cua",
  DomCUAAPI: "ChromeTab.dom_cua",
  PlaywrightAPI: "ChromeTab.playwright",
  PlaywrightFrameLocator: "FrameLocator",
  PlaywrightLocator: "Locator",
  PlaywrightDownload: "BrowserDownload",
  PlaywrightFileChooser: "BrowserFileChooser",
  TabClipboardAPI: "ChromeTab.clipboard",
  TabDevAPI: "ChromeTab.dev",
  AlertDialog: "browserDialog.alert",
  BeforeUnloadDialog: "browserDialog.beforeunload",
  ConfirmDialog: "browserDialog.confirm",
  PromptDialog: "browserDialog.prompt",
  BrowserDocumentation: "BrowserDocumentationStore",
  Documentation: "createAgent.documentation"
};

const map = Object.fromEntries(Object.entries(contract.interfaces).map(([interfaceName, members]) => [
  interfaceName,
  Object.fromEntries(Object.keys(members).map((memberName) => [
    memberName,
    {
      module: interfaceName === "PlaywrightDownload" || interfaceName === "PlaywrightFileChooser" ||
        interfaceName.endsWith("Dialog")
        ? "src/extension-runtime/entry.mjs + src/agent-browser.mjs"
        : "src/agent-browser.mjs",
      implementation: `${owner[interfaceName]}.${memberName}`
    }
  ]))
]));

await writeFile(
  path.join(root, "compat", "codex-adapter-map.json"),
  `${JSON.stringify(map, null, 2)}\n`,
  "utf8"
);
