# Bilingual Release Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a professional paired English/Simplified Chinese public documentation surface for Chrome Faithful 0.4.0, with machine-enforced release facts and honest OCR, DSH, VLM, and security boundaries.

**Architecture:** Keep each language in a standalone tracked Markdown file with reciprocal relative links. Extend the existing release-contract test into a source-and-tarball documentation gate whose pure validator is exercised against both real documents and deliberate in-memory mutations. Make only one package-inventory change: include the Chinese DSH README in the bundle allowlist.

**Tech Stack:** Markdown, Node.js 22.12+, `node:test`, `node:assert/strict`, npm dry-run packing, Git.

## Global Constraints

- Root package and DSH bundle version remain exactly `0.4.0`.
- DSH baseline remains `@deepseek-ai/dsh` `0.1.0-rc.6`; Node.js remains `>=22.12.0`.
- The public tool count remains exactly 38.
- DSH forwards exactly these six string variables: `AGENTOS_CHROME_CONFIG`, `CHROME_FAITHFUL_OCR_BACKEND`, `CHROME_FAITHFUL_PYTHON`, `CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR`, `CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR`, `CHROME_FAITHFUL_VLM_BACKEND`.
- Direct production MCP OCR is accepted; DSH model consumption of visual output is not evaluated.
- The optional VLM path remains disabled by default, uninstalled, unevaluated, and not approved.
- Raw `chrome_cdp` send remains an unrestricted trusted-client boundary.
- Do not change runtime behavior, dependencies, security policy, repository visibility, tags, releases, or npm publication.
- Preserve untracked `.agent-os/` and `docs/agent-lessons.md`; never stage them.

---

### Task 1: Add the bilingual release contract

**Files:**
- Modify: `test/release-contract.test.mjs`

**Interfaces:**
- Consumes: six Markdown source files and the existing `dryRunPack(cwd)` helper.
- Produces: a pure `assertBilingualReleaseContract(documents, bundleFiles)` validator used by the real-source and deliberate-mutation tests.

- [ ] **Step 1: Write the failing real-source contract test**

Add constants for the six document paths and a helper that reads them into an object. Add an initial test that expects all documents and both DSH READMEs in the dry-run bundle:

```js
const bilingualPaths = {
  rootEnglish: "README.md",
  rootChinese: "README.zh-CN.md",
  dshEnglish: "packages/dsh-plugin-chrome-faithful/README.md",
  dshChinese: "packages/dsh-plugin-chrome-faithful/README.zh-CN.md",
  acceptanceEnglish: "docs/visual-model-acceptance-2026-08-14.md",
  acceptanceChinese: "docs/visual-model-acceptance-2026-08-14.zh-CN.md"
};

test("bilingual release documents preserve reciprocal links and locked facts", async () => {
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
});
```

- [ ] **Step 2: Run the focused test and verify the missing Chinese files fail**

Run: `npx --yes node@22.12.0 --test test/release-contract.test.mjs`

Expected: FAIL because the Chinese DSH README and Chinese acceptance report do not exist and the bundle dry-run inventory lacks `README.zh-CN.md`.

- [ ] **Step 3: Implement the pure fact validator and mutation probes**

In the same test file, define exact paired-heading arrays, reciprocal selectors, the six-variable set, both model hashes, and the accepted metric strings. The validator must use `assert.deepEqual`, `assert.match`, and `assert.doesNotMatch`; it must not accept fuzzy version or metric matches.

```js
const forwardedVisualEnv = [
  "AGENTOS_CHROME_CONFIG",
  "CHROME_FAITHFUL_OCR_BACKEND",
  "CHROME_FAITHFUL_PYTHON",
  "CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR",
  "CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR",
  "CHROME_FAITHFUL_VLM_BACKEND"
];

function markdownHeadings(text) {
  return [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
}

function assertBilingualReleaseContract(documents, bundleFiles) {
  assert.match(documents.rootEnglish, /\*\*English\*\* · \[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(documents.rootChinese, /\[English\]\(README\.md\) · \*\*简体中文\*\*/);
  assert.deepEqual(bundleFiles.includes("README.zh-CN.md"), true);
  assert.match(documents.dshEnglish, /DSH model consumption[^.]*not evaluated/i);
  assert.match(documents.dshChinese, /DSH 模型[^。]*未评测/);
  assert.match(documents.dshEnglish, /VLM[^.]*not approved/i);
  assert.match(documents.dshChinese, /VLM[^。]*未批准/);
  assert.doesNotMatch(documents.dshEnglish, /DSH (?:OCR|vision) accepted/i);
  assert.doesNotMatch(documents.dshChinese, /DSH (?:OCR|视觉).{0,8}(?:已验收|通过验收)/);
}
```

Expand this function to assert:

- reciprocal selectors for all three pairs;
- exact English/Chinese public heading-order mappings;
- `0.4.0`, `>=22.12.0`, `0.1.0-rc.6`, and 38 tools in both relevant languages;
- the exact six-variable set extracted from both DSH documents;
- both model SHA-256 strings;
- `7/7`, `6/7`, `99.43%`, `100%`, `0.9754`, `0.9379`, `3233`, `2996`, and `3245` in both acceptance reports;
- raw-CDP trusted-client warnings; and
- the two negative acceptance boundaries.

Add an in-memory mutation table that changes one protected fact at a time and requires the validator to throw:

```js
for (const [name, key, from, to] of mutations) {
  const changed = { ...documents, [key]: documents[key].replace(from, to) };
  assert.throws(
    () => assertBilingualReleaseContract(changed, bundleFiles),
    { name: "AssertionError" },
    name
  );
}
```

The table must cover one mutation from each fact class: selector, heading order, version, Node floor, DSH RC, tool count, environment-variable set, model hash, OCR metrics, raw-CDP warning, DSH-model boundary, and VLM boundary.

- [ ] **Step 4: Run the focused test and confirm it still fails only for missing implementation files**

Run: `npx --yes node@22.12.0 --test test/release-contract.test.mjs`

Expected: FAIL on absent `packages/dsh-plugin-chrome-faithful/README.zh-CN.md` or `docs/visual-model-acceptance-2026-08-14.zh-CN.md`, not because the mutation probes silently pass.

- [ ] **Step 5: Commit the red contract**

```bash
git add test/release-contract.test.mjs
git commit -m "test: lock bilingual release documentation"
```

---

### Task 2: Implement the paired public documents and package inventory

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `packages/dsh-plugin-chrome-faithful/README.md`
- Create: `packages/dsh-plugin-chrome-faithful/README.zh-CN.md`
- Modify: `packages/dsh-plugin-chrome-faithful/package.json`
- Modify: `docs/visual-model-acceptance-2026-08-14.md`
- Create: `docs/visual-model-acceptance-2026-08-14.zh-CN.md`

**Interfaces:**
- Consumes: the exact evidence in `docs/visual-model-acceptance-2026-08-14.md`, package manifests, and `cordis.patch.yml`.
- Produces: six reciprocal public documents and a DSH tarball containing both package READMEs.

- [ ] **Step 1: Add reciprocal selectors and root OCR evidence summaries**

Keep the existing root selectors. In each root local-vision section, add one compact paragraph with the exact accepted metrics and a relative link to the same-language report. The English wording must include:

```markdown
Live quality acceptance of the direct production MCP path detected 7/7 blocks,
reached 99.43% raw and 100% non-whitespace character accuracy, and returned
0.9754 mean / 0.9379 minimum confidence with valid coordinates, reading order,
and identical output across three 3.00--3.25 second calls on the accepted AMD
Ryzen 9 9950X3D host. This did not evaluate DSH model consumption or an
optional VLM. See the [acceptance report](docs/visual-model-acceptance-2026-08-14.md).
```

The Chinese paragraph must preserve every number and limitation and link to `docs/visual-model-acceptance-2026-08-14.zh-CN.md`.

- [ ] **Step 2: Create the Chinese DSH README and align the English boundary**

Add reciprocal selectors immediately below each DSH title. Translate the five public sections in the same order: Compatibility/兼容性, Install/安装, Configure/配置, Security boundary/安全边界, Verification status/验证状态.

Both files must explicitly say:

```text
Direct extension -> bridge -> MCP server -> chrome_visual_extract OCR quality passed.
DSH model consumption of chrome_visual_extract output was not evaluated.
The optional VLM was disabled, uninstalled, unevaluated, and not approved.
```

Preserve all commands, identifiers, six environment-variable names, versions, and the unrestricted raw-CDP warning verbatim where they are machine tokens.

- [ ] **Step 3: Create the paired Chinese acceptance report**

Add selectors under both report titles. Translate Verdict, Runtime, Production-path evidence, Compatibility finding and disposition, and Acceptance thresholds. Preserve the two hashes, all metric values, the whitespace-only difference, AMD CPU scope, and the `enable_mkldnn=False` fix exactly.

- [ ] **Step 4: Add the Chinese DSH README to the explicit bundle allowlist**

Change only the documentation portion of `packages/dsh-plugin-chrome-faithful/package.json`:

```json
"files": [
  "bin/",
  "cordis.patch.yml",
  "README.md",
  "README.zh-CN.md",
  "LICENSE"
]
```

Update the existing exact array assertion and dry-run inventory in `test/release-contract.test.mjs` to include `README.zh-CN.md`.

- [ ] **Step 5: Run the focused release contract**

Run: `npx --yes node@22.12.0 --test test/release-contract.test.mjs`

Expected: all release-contract tests PASS, including deliberate mutations and the six-file tarball inventory.

- [ ] **Step 6: Commit the bilingual implementation**

```bash
git add README.md README.zh-CN.md \
  packages/dsh-plugin-chrome-faithful/README.md \
  packages/dsh-plugin-chrome-faithful/README.zh-CN.md \
  packages/dsh-plugin-chrome-faithful/package.json \
  docs/visual-model-acceptance-2026-08-14.md \
  docs/visual-model-acceptance-2026-08-14.zh-CN.md \
  test/release-contract.test.mjs
git commit -m "docs: complete bilingual release presentation"
```

---

### Task 3: Verify, review, and close out

**Files:**
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: completed bilingual documents and release contract.
- Produces: current verification evidence and an independently reviewed handoff.

- [ ] **Step 1: Run focused documentation and package gates**

```bash
npx --yes node@22.12.0 --test test/release-contract.test.mjs
npm --prefix packages/dsh-plugin-chrome-faithful pack --dry-run --json
git diff --check
```

Expected: tests pass; the bundle inventory contains `README.md` and `README.zh-CN.md`; no whitespace errors.

- [ ] **Step 2: Run full project verification**

```bash
npx --yes node@22.12.0 scripts/check.mjs
npx --yes node@22.12.0 scripts/check-codex-parity.mjs
npx --yes node@22.12.0 scripts/run-unit-tests.mjs
```

Expected: `CHECK_OK`, parity remains 22 interfaces / 135 members, and the full suite reports zero failures or skips.

- [ ] **Step 3: Request independent implementation review**

The reviewer must inspect the actual documents, package dry-run, and mutation probes. Required verdict is `APPROVED`; findings must be fixed and re-reviewed. Review must check translation naturalness as well as factual parity, especially the DSH-model and VLM negative boundaries.

- [ ] **Step 4: Update the handoff and run Agent Lessons closeout**

Record changed files, exact commands/results, independent verdict, package inventory change, and remaining npm-rendering risk in `HANDOFF.md`. Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Administrator\.agent-os\bin\agent-lessons.ps1" closeout -Project .
```

Expected: `CLOSEOUT_COMPLETED`; do not run `adopt`.

- [ ] **Step 5: Commit closeout documentation**

```bash
git add HANDOFF.md
git commit -m "docs: close out bilingual release presentation"
```

- [ ] **Step 6: Push only after all local and independent gates pass**

Confirm the repository is still private, then fast-forward the feature branch and `main`. Wait for the exact pushed commit's Ubuntu and Windows GitHub Actions jobs to pass. Do not change repository visibility, create a release/tag, or publish npm packages.
