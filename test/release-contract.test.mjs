import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefixArgs = process.platform === "win32"
  ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];
const bilingualPaths = {
  rootEnglish: "README.md",
  rootChinese: "README.zh-CN.md",
  dshEnglish: "packages/dsh-plugin-chrome-faithful/README.md",
  dshChinese: "packages/dsh-plugin-chrome-faithful/README.zh-CN.md",
  acceptanceEnglish: "docs/visual-model-acceptance-2026-08-14.md",
  acceptanceChinese: "docs/visual-model-acceptance-2026-08-14.zh-CN.md"
};
const bilingualHeadings = {
  rootEnglish: [
    "2:Why this exists",
    "2:Architecture",
    "2:Safety model",
    "2:DSH first-class integration",
    "3:Local vision for text-only models",
    "2:Quick start (Windows)",
    "2:MCP tools",
    "2:Verification handling",
    "2:Live testing",
    "2:JavaScript integration",
    "2:Codex compatibility",
    "2:Testing",
    "2:Documentation",
    "2:Status",
    "2:License"
  ],
  rootChinese: [
    "2:为什么存在",
    "2:架构",
    "2:安全模型",
    "2:DSH 一等集成",
    "3:面向纯文本模型的本地视觉",
    "2:快速上手（Windows）",
    "2:MCP 工具",
    "2:验证处理",
    "2:实机测试",
    "2:JavaScript 集成",
    "2:Codex 兼容性",
    "2:测试",
    "2:文档",
    "2:状态",
    "2:许可证"
  ],
  dshEnglish: [
    "2:Compatibility",
    "2:Install",
    "2:Configure",
    "2:Security boundary",
    "2:Verification status"
  ],
  dshChinese: [
    "2:兼容性",
    "2:安装",
    "2:配置",
    "2:安全边界",
    "2:验证状态"
  ],
  acceptanceEnglish: [
    "2:Verdict",
    "2:Runtime",
    "2:Production-path evidence",
    "2:Compatibility finding and disposition",
    "2:Acceptance thresholds"
  ],
  acceptanceChinese: [
    "2:结论",
    "2:运行环境",
    "2:生产路径证据",
    "2:兼容性发现与处理",
    "2:验收阈值"
  ]
};
const forwardedVisualEnv = [
  "AGENTOS_CHROME_CONFIG",
  "CHROME_FAITHFUL_OCR_BACKEND",
  "CHROME_FAITHFUL_PYTHON",
  "CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR",
  "CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR",
  "CHROME_FAITHFUL_VLM_BACKEND"
];
const modelHashes = [
  "50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58",
  "566b9512b34e34a9f0db54d87b51fa5a0b9ed2cf1ab7e49728cc0b8b5a64f414"
];

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

function markdownHeadings(text) {
  return [...text.matchAll(/^(#{2,3}) (.+)$/gm)]
    .map((match) => `${match[1].length}:${match[2]}`);
}

function uniqueEnvironmentVariables(text) {
  return [...new Set(text.match(/\b(?:AGENTOS_CHROME_CONFIG|CHROME_FAITHFUL_(?:OCR_BACKEND|PYTHON|PPOCR_DET_MODEL_DIR|PPOCR_REC_MODEL_DIR|VLM_BACKEND))\b/g) ?? [])]
    .sort();
}

function assertBilingualReleaseContract(documents, bundleFiles) {
  assert.match(documents.rootEnglish, /\*\*English\*\* · \[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(documents.rootChinese, /\[English\]\(README\.md\) · \*\*简体中文\*\*/);
  assert.match(documents.dshEnglish, /\*\*English\*\* · \[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(documents.dshChinese, /\[English\]\(README\.md\) · \*\*简体中文\*\*/);
  assert.match(documents.acceptanceEnglish, /\*\*English\*\* · \[简体中文\]\(visual-model-acceptance-2026-08-14\.zh-CN\.md\)/);
  assert.match(documents.acceptanceChinese, /\[English\]\(visual-model-acceptance-2026-08-14\.md\) · \*\*简体中文\*\*/);

  for (const [key, headings] of Object.entries(bilingualHeadings)) {
    assert.deepEqual(markdownHeadings(documents[key]), headings, `${key} heading order`);
  }

  for (const key of ["rootEnglish", "rootChinese", "dshEnglish", "dshChinese"]) {
    assert.match(documents[key], /0\.4\.0/, `${key} release version`);
    assert.match(documents[key], />=22\.12\.0|≥ ?22\.12\.0/, `${key} Node floor`);
    assert.match(documents[key], /0\.1\.0-rc\.6/, `${key} DSH baseline`);
    assert.match(documents[key], /\b38\b/, `${key} tool count`);
  }

  for (const key of ["dshEnglish", "dshChinese"]) {
    assert.deepEqual(uniqueEnvironmentVariables(documents[key]), [...forwardedVisualEnv].sort());
    assert.match(documents[key], /chrome_cdp/);
    assert.match(documents[key], /unrestricted raw CDP|不受限的 raw CDP/);
    assert.match(documents[key], /DSH model consumption[^.]*was not evaluated|DSH 模型[^。]*未评测/i);
    assert.match(documents[key], /VLM[^.。]*(?:not approved|未批准)/i);
    assert.doesNotMatch(documents[key], /DSH (?:OCR|vision) accepted/i);
    assert.doesNotMatch(documents[key], /DSH (?:OCR|视觉).{0,8}(?:已验收|通过验收)/);
  }

  for (const key of ["rootEnglish", "rootChinese"]) {
    assert.match(documents[key], /DSH model consumption[^.]*not evaluated|DSH 模型[^。]*未评测/i);
    assert.match(documents[key], /VLM[^.。]*(?:not approved|未批准)/i);
  }

  for (const key of ["acceptanceEnglish", "acceptanceChinese"]) {
    for (const hash of modelHashes) assert.match(documents[key], new RegExp(hash));
    for (const metric of ["7/7", "6/7", "99.43%", "100%", "0.9754", "0.9379", "3233", "2996", "3245"]) {
      assert.match(documents[key], new RegExp(metric.replace(".", "\\.")), `${key} metric ${metric}`);
    }
    assert.match(documents[key], /enable_mkldnn=False/);
    assert.match(documents[key], /VLM[^.。]*(?:not approved|未批准)/i);
  }

  assert.deepEqual(bundleFiles, [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "bin/chrome-faithful-mcp.mjs",
    "cordis.patch.yml",
    "package.json"
  ]);
}

test("unit test command is shell-independent and excludes live harnesses", async () => {
  const packageJson = await readJson("package.json");

  assert.equal(packageJson.scripts.test, "node scripts/run-unit-tests.mjs");
  assert.doesNotMatch(packageJson.scripts.test, /[*?\[]/);
});

test("declared Node floor satisfies pinned production dependencies", async () => {
  const packageJson = await readJson("package.json");
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");

  assert.equal(packageJson.engines.node, ">=22.12.0");
  assert.doesNotMatch(workflow, /node-version:\s*20\b/);
});

test("all plugin manifests use the package release version", async () => {
  const [packageJson, extension, codex, claude, mcpb] = await Promise.all([
    readJson("package.json"),
    readJson("extension/manifest.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson(".claude-plugin/plugin.json"),
    readJson("mcpb/manifest.json")
  ]);

  assert.equal(extension.version, packageJson.version);
  assert.equal(extension.version_name, packageJson.version);
  assert.equal(codex.version, packageJson.version);
  assert.equal(claude.version, packageJson.version);
  assert.equal(mcpb.version, packageJson.version);
});

test("public display metadata uses the Chrome Faithful brand", async () => {
  const [extension, codex, mcpb] = await Promise.all([
    readJson("extension/manifest.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson("mcpb/manifest.json")
  ]);

  assert.equal(extension.name, "Chrome Faithful");
  assert.equal(extension.action.default_title, "Chrome Faithful");
  assert.equal(codex.interface.displayName, "Chrome Faithful");
  assert.equal(mcpb.display_name, "Chrome Faithful");
});

test("MCPB declares every server tool exactly once", async () => {
  const [serverSource, mcpb] = await Promise.all([
    readFile(new URL("src/mcp-server.mjs", root), "utf8"),
    readJson("mcpb/manifest.json")
  ]);
  const serverTools = [...serverSource.matchAll(/^\s{4}name: "(chrome_[^"]+)",$/gm)]
    .map((match) => match[1])
    .sort();
  const declaredTools = mcpb.tools.map((tool) => tool.name).sort();

  assert.equal(serverTools.length, 38);
  assert.equal(serverTools.includes("chrome_visual_extract"), true);
  assert.equal(new Set(declaredTools).size, declaredTools.length);
  assert.deepEqual(declaredTools, serverTools);
});

test("compatibility contract contains no copied declaration text", async () => {
  const copiedFixtureExists = await readFile(
    new URL("compat/codex-26.721.41059-api.json", root)
  ).then(() => true, () => false);
  const contract = await readJson("compat/browser-surface-contract.json").catch(() => null);

  assert.equal(copiedFixtureExists, false);
  assert.ok(contract);
  assert.doesNotMatch(JSON.stringify(contract), /"declarations"\s*:/);
  assert.doesNotMatch(JSON.stringify(contract), /documentation:/);
});

test("npm package uses an explicit runtime allowlist", async () => {
  const packageJson = await readJson("package.json");

  assert.ok(Array.isArray(packageJson.files));
  assert.ok(packageJson.files.includes("src/"));
  assert.ok(packageJson.files.includes("extension/"));
  assert.ok(packageJson.files.includes("compat/"));
  assert.ok(packageJson.files.includes("mcpb/"));
  assert.ok(packageJson.files.includes("integrations/ppocr/"));
  assert.equal(packageJson.files.some((entry) => /^(test|reports|docs\/superpowers)\/?/.test(entry)), false);
});

test("MCPB build installs the lockfile-defined production dependency tree", async () => {
  const source = await readFile(new URL("scripts/build-mcpb.mjs", root), "utf8");

  assert.match(source, /process\.env\.npm_execpath/);
  assert.match(source, /process\.execPath/);
  assert.match(source, /\bci\b/);
  assert.match(source, /--omit=dev/);
  assert.match(source, /path\.join\(root, "integrations", "ppocr"\)/);
  assert.match(source, /ppocrv5_mobile\.py/);
  assert.doesNotMatch(source, /npm\.cmd/);
  assert.doesNotMatch(source, /["']node_modules["']/);
});

test("CI grants read-only contents access and pins actions by commit", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const actionRefs = [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);

  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.equal((workflow.match(/npm run build:mcpb/g) || []).length, 2);
  assert.ok(actionRefs.length > 0);
  assert.equal(actionRefs.every((ref) => /^[0-9a-f]{40}$/.test(ref)), true);
});

test("extension limits host access to its localhost bridge", async () => {
  const manifest = await readJson("extension/manifest.json");

  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
});

test("DSH bundle has a stable public launcher and exact core version", async () => {
  const [rootPackage, bundle] = await Promise.all([
    readJson("package.json"),
    readJson("packages/dsh-plugin-chrome-faithful/package.json")
  ]);
  const launcher = await readFile(
    new URL("packages/dsh-plugin-chrome-faithful/bin/chrome-faithful-mcp.mjs", root),
    "utf8"
  );

  assert.equal(rootPackage.exports["./mcp-server"], "./src/mcp-server.mjs");
  assert.equal(rootPackage.exports["./src/*"], "./src/*");
  assert.equal(bundle.name, "@bpc-oss/dsh-plugin-chrome-faithful");
  assert.equal(bundle.version, rootPackage.version);
  assert.equal(bundle.dependencies["chrome-faithful"], rootPackage.version);
  assert.equal(bundle.peerDependencies?.["@deepseek-ai/dsh-mcp-client"], undefined);
  assert.equal(bundle.dependencies?.["@deepseek-ai/dsh-mcp-client"], undefined);
  assert.equal(bundle.engines.node, rootPackage.engines.node);
  assert.equal(bundle.dsh.bundle.patch, "./cordis.patch.yml");
  assert.deepEqual(bundle.files, ["bin/", "cordis.patch.yml", "README.md", "LICENSE"]);
  assert.equal(bundle.exports["./mcp-server"], "./bin/chrome-faithful-mcp.mjs");
  assert.equal(bundle.bin["chrome-faithful-mcp"], "./bin/chrome-faithful-mcp.mjs");

  assert.match(launcher, /^#!\/usr\/bin\/env node\nimport "chrome-faithful\/mcp-server";\n$/);
  assert.doesNotMatch(launcher, /\b(?:spawn|exec|shell|catch|fallback)\b/i);
});

test("third-party notices cover every direct package dependency", async () => {
  const packageJson = await readJson("package.json");
  const notices = await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
  const directPackages = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {})
  ];

  for (const packageName of directPackages) {
    assert.match(notices, new RegExp(`^## ${packageName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "m"));
  }
  assert.doesNotMatch(notices, /deepseek-harness\/tree\/(?:main|master)\//);
  assert.equal(
    (notices.match(/deepseek-harness\/tree\/47f943859bef60e4160492346772ded9b24f765a\//g) ?? []).length,
    2
  );
});

async function dryRunPack(cwd) {
  const { stdout } = await execFileAsync(
    npmCommand,
    [...npmPrefixArgs, "pack", "--dry-run", "--json"],
    { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }
  );
  const result = JSON.parse(stdout);
  assert.equal(result.length, 1);
  return result[0].files.map((entry) => entry.path).sort();
}

test("core and DSH bundle publish independent allowlisted artifacts", async () => {
  const [coreFiles, bundleFiles] = await Promise.all([
    dryRunPack(rootPath),
    dryRunPack(path.join(rootPath, "packages", "dsh-plugin-chrome-faithful"))
  ]);
  const forbidden = /^(?:test|reports|tmp|docs\/superpowers|config\/local(?:\.json)?)(?:\/|$)/;

  assert.equal(coreFiles.some((entry) => forbidden.test(entry)), false);
  assert.equal(coreFiles.includes("integrations/ppocr/ppocrv5_mobile.py"), true);
  assert.equal(coreFiles.includes("integrations/ppocr/README.md"), true);
  assert.equal(coreFiles.some((entry) => entry.startsWith("packages/dsh-plugin-chrome-faithful/")), false);
  assert.equal(bundleFiles.some((entry) => forbidden.test(entry)), false);
  assert.deepEqual(bundleFiles, [
    "LICENSE",
    "README.md",
    "bin/chrome-faithful-mcp.mjs",
    "cordis.patch.yml",
    "package.json"
  ]);
});

test("bilingual release documents preserve reciprocal links and locked facts", async () => {
  await Promise.all(Object.values(bilingualPaths).map((file) => execFileAsync(
    "git",
    ["ls-files", "--error-unmatch", file],
    { cwd: rootPath, windowsHide: true }
  )));
  const documents = Object.fromEntries(await Promise.all(
    Object.entries(bilingualPaths).map(async ([key, file]) => [
      key,
      await readFile(new URL(file, root), "utf8")
    ])
  ));
  const bundleFiles = await dryRunPack(
    path.join(rootPath, "packages", "dsh-plugin-chrome-faithful")
  );

  assertBilingualReleaseContract(documents, bundleFiles);

  const mutations = [
    ["language selector", (value) => ({
      ...value,
      rootEnglish: value.rootEnglish.replace("**English**", "English")
    })],
    ["heading order", (value) => ({
      ...value,
      rootChinese: value.rootChinese.replace("## 架构", "## 架构变更")
    })],
    ["release version", (value) => ({
      ...value,
      dshEnglish: value.dshEnglish.replaceAll("0.4.0", "0.4.1")
    })],
    ["Node floor", (value) => ({
      ...value,
      dshEnglish: value.dshEnglish.replaceAll(">=22.12.0", ">=22.11.0")
    })],
    ["DSH baseline", (value) => ({
      ...value,
      dshChinese: value.dshChinese.replaceAll("0.1.0-rc.6", "0.1.0-rc.7")
    })],
    ["tool count", (value) => ({
      ...value,
      rootChinese: value.rootChinese.replaceAll("38", "39")
    })],
    ["environment allowlist", (value) => ({
      ...value,
      dshEnglish: value.dshEnglish.replaceAll("CHROME_FAITHFUL_VLM_BACKEND", "CHROME_FAITHFUL_EXTRA_BACKEND")
    })],
    ["model hash", (value) => ({
      ...value,
      acceptanceChinese: value.acceptanceChinese.replaceAll(modelHashes[0], "0".repeat(64))
    })],
    ["OCR metric", (value) => ({
      ...value,
      acceptanceChinese: value.acceptanceChinese.replaceAll("99.43%", "99.42%")
    })],
    ["raw CDP boundary", (value) => ({
      ...value,
      dshEnglish: value.dshEnglish.replaceAll("unrestricted raw CDP", "raw CDP")
    })],
    ["DSH model boundary", (value) => ({
      ...value,
      dshEnglish: value.dshEnglish.replaceAll("was not evaluated", "was evaluated")
    })],
    ["VLM boundary", (value) => ({
      ...value,
      dshChinese: value.dshChinese.replaceAll("未批准", "已批准")
    })]
  ];

  for (const [name, mutate] of mutations) {
    assert.throws(
      () => assertBilingualReleaseContract(mutate(documents), bundleFiles),
      { name: "AssertionError" },
      name
    );
  }
  assert.throws(
    () => assertBilingualReleaseContract(
      documents,
      bundleFiles.filter((entry) => entry !== "README.zh-CN.md")
    ),
    { name: "AssertionError" },
    "bundle membership"
  );
});
