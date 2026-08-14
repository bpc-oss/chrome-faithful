# DSH First-Party Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently packable `@bpc-oss/dsh-plugin-chrome-faithful` bundle that mounts the existing Chrome Faithful MCP server through DSH's official MCP client.

**Architecture:** The provider-neutral core exports one stable MCP entry subpath. A small DSH bundle resolves its own launcher from the DSH profile root and configures the host-provided MCP client over stdio; no browser tool is reimplemented. Release-contract and two-tarball isolation tests prove composition, version, environment, and package boundaries without modifying a live DSH profile.

**Tech Stack:** Node.js 22.12+ ESM, `node:test`, DSH Cordis YAML bundle patches, npm package tarballs, GitHub Actions.

## Global Constraints

- Keep the existing MCP server, extension, bridge, exact-profile routing, and 37 tool implementations unchanged.
- The bundle version and exact `chrome-faithful` dependency are both `0.4.0`.
- Do not declare `@deepseek-ai/dsh-mcp-client` as a bundle dependency or peer dependency; target host `@deepseek-ai/dsh` `0.1.0-rc.6` or newer within the reviewed RC contract.
- Both packages require Node.js `>=22.12.0`.
- Bundle composition uses `process.execPath` plus an absolute launcher export resolved through `createRequire(baseUrl)`; it never relies on `.bin` being on `PATH`.
- Set `failOnStartupError: true`; configuration or resolution errors fail loudly.
- Do not publish, push, make the repository public, or install into a live user-owned DSH profile.

---

### Task 1: Stable core MCP export and bundle metadata

**Files:**
- Modify: `package.json`
- Create: `packages/dsh-plugin-chrome-faithful/package.json`
- Create: `packages/dsh-plugin-chrome-faithful/bin/chrome-faithful-mcp.mjs`
- Modify: `test/release-contract.test.mjs`

**Interfaces:**
- Produces: root package export `chrome-faithful/mcp-server` mapped to `./src/mcp-server.mjs`.
- Produces: bundle export `@bpc-oss/dsh-plugin-chrome-faithful/mcp-server` mapped to `./bin/chrome-faithful-mcp.mjs`.
- Produces: executable `chrome-faithful-mcp` mapped to the same launcher.

- [x] **Step 1: Write failing release-contract tests**

Add assertions that:

```js
assert.equal(rootPackage.exports["./mcp-server"], "./src/mcp-server.mjs");
assert.equal(bundle.name, "@bpc-oss/dsh-plugin-chrome-faithful");
assert.equal(bundle.version, rootPackage.version);
assert.equal(bundle.dependencies["chrome-faithful"], rootPackage.version);
assert.equal(bundle.peerDependencies?.["@deepseek-ai/dsh-mcp-client"], undefined);
assert.equal(bundle.dependencies?.["@deepseek-ai/dsh-mcp-client"], undefined);
assert.equal(bundle.engines.node, rootPackage.engines.node);
assert.equal(bundle.dsh.bundle.patch, "./cordis.patch.yml");
assert.deepEqual(bundle.files, ["bin/", "cordis.patch.yml", "README.md"]);
```

Read the launcher and assert it imports only `chrome-faithful/mcp-server` and
does not contain `spawn`, `exec`, `shell`, fallback paths, or exception hiding.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/release-contract.test.mjs`

Expected: failure because the root export and bundle files do not exist.

- [x] **Step 3: Add the minimal package metadata and launcher**

Root `package.json` adds:

```json
"exports": {
  ".": "./src/index.mjs",
  "./mcp-server": "./src/mcp-server.mjs"
}
```

Bundle `package.json` defines the exact metadata asserted above, public MIT
metadata, an exact `chrome-faithful: 0.4.0` dependency, and no MCP-client
dependency. Launcher content is exactly:

```js
#!/usr/bin/env node
import "chrome-faithful/mcp-server";
```

- [x] **Step 4: Run focused tests and static checks**

Run: `node --test test/release-contract.test.mjs && npm run check`

Expected: PASS and `CHECK_OK`.

- [x] **Step 5: Commit**

```bash
git add package.json packages/dsh-plugin-chrome-faithful test/release-contract.test.mjs
git commit -m "feat: add DSH bundle package boundary"
```

### Task 2: DSH bundle composition contract

**Files:**
- Create: `packages/dsh-plugin-chrome-faithful/cordis.patch.yml`
- Create: `scripts/dsh-bundle-contract.mjs`
- Create: `test/dsh-bundle-contract.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `loadDshBundlePatch({ patchPath, agentosChromeConfig })` returning the evaluated MCP-client row.
- Consumes: bundle launcher export from Task 1.

- [x] **Step 1: Write failing bundle contract tests**

Tests must evaluate the YAML `!!js` expressions, not inspect strings. Assert the
parsed row equals:

```js
{
  id: "chrome-faithful-mcp",
  name: "@deepseek-ai/dsh-mcp-client",
  config: {
    serverName: "chrome_faithful",
    transport: "stdio",
    command: process.execPath,
    args: [absoluteResolvedLauncher],
    env: {},
    toolCallTimeoutMs: 60000,
    failOnStartupError: true
  }
}
```

Run the same evaluation with `agentosChromeConfig` set and assert `env` becomes
exactly `{ AGENTOS_CHROME_CONFIG: value }`. Pass both results through the
published rc.6 MCP-client configuration schema or an exact local validator
mirroring `z.dict(z.string())`, transport discrimination, timeout, and boolean
requirements.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/dsh-bundle-contract.test.mjs`

Expected: failure because the patch and evaluator do not exist.

- [x] **Step 3: Implement the exact patch and evaluator**

The patch uses one `insert` row and these expressions:

```yaml
command: !!js process.execPath
args:
  - !!js >-
      process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@bpc-oss/dsh-plugin-chrome-faithful/mcp-server')
env: !!js >-
  process.env.AGENTOS_CHROME_CONFIG === undefined ? {} : { AGENTOS_CHROME_CONFIG: process.env.AGENTOS_CHROME_CONFIG }
```

Add exact dev dependency `yaml: 2.9.0`. The contract helper parses the complete
patch with `yaml`, preserves `!!js` nodes through an explicit custom tag, and
evaluates only those tagged scalar expressions in a `vm` context containing
explicit `process` and `baseUrl`. The helper then validates the resulting fixed
MCP-client configuration shape, including a string-only `env` dictionary.

- [x] **Step 4: Run focused tests and static checks**

Run: `node --test test/dsh-bundle-contract.test.mjs test/release-contract.test.mjs && npm run check`

Expected: PASS and `CHECK_OK`.

- [x] **Step 5: Commit**

```bash
git add packages/dsh-plugin-chrome-faithful/cordis.patch.yml scripts/dsh-bundle-contract.mjs test/dsh-bundle-contract.test.mjs package.json package-lock.json
git commit -m "feat: compose Chrome Faithful into DSH"
```

### Task 3: Paired-tarball isolation and startup failure proof

**Files:**
- Create: `test/dsh-package-isolation.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: core and bundle package manifests/exports from Task 1.
- Produces: platform-neutral proof that the installed bundle resolves the core without `.bin` on `PATH`.

- [x] **Step 1: Write the isolated package test**

The test creates a temporary directory and runs `npm pack --json` for the root
and bundle. It writes a profile-like temporary `package.json` whose two direct
dependencies are `file:` references to those tarballs, then runs
`npm install --ignore-scripts --no-audit --no-fund`. The packed bundle manifest
remains unchanged with exact dependency `chrome-faithful: 0.4.0`; npm must
satisfy it from the top-level file-installed core.

It resolves the launcher with:

```js
const requireFromProfile = createRequire(path.join(profileRoot, "package.json"));
const launcher = requireFromProfile.resolve("@bpc-oss/dsh-plugin-chrome-faithful/mcp-server");
```

Spawn `process.execPath` with the absolute launcher while `PATH` excludes
`node_modules/.bin` and `AGENTOS_CHROME_CONFIG` points to a guaranteed missing
temporary path. Assert non-zero exit and the existing bounded error text
`Agent OS Chrome CDP config is unavailable at` from `src/config.mjs`.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/dsh-package-isolation.test.mjs`

Expected: failure until the packed exports and paired file installation are
correctly exercised.

- [x] **Step 3: Make only the required packaging corrections**

Correct `files`, `exports`, executable mode, or test installation mechanics.
Do not introduce runtime fallback resolution.

- [x] **Step 4: Add the focused isolation test to both CI jobs**

Place it after `npm ci` and before the complete unit suite. It must execute on
Ubuntu and Windows with Node 22.

- [x] **Step 5: Run the focused test twice from clean temp roots**

Run: `node --test test/dsh-package-isolation.test.mjs` twice.

Expected: both passes; no repository file changes outside ignored npm cache and
temporary directories.

- [x] **Step 6: Commit**

```bash
git add test/dsh-package-isolation.test.mjs .github/workflows/ci.yml
git commit -m "test: verify isolated DSH bundle resolution"
```

### Task 4: DSH documentation and release packaging

**Files:**
- Create: `packages/dsh-plugin-chrome-faithful/README.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CONTRIBUTING.md`
- Modify: `package.json`
- Modify: `test/release-contract.test.mjs`

**Interfaces:**
- Consumes: package install and namespace contracts from Tasks 1-3.
- Produces: first-class DSH installation documentation and pack-content gates.

- [x] **Step 1: Write failing pack-content tests**

Use `npm pack --dry-run --json` for both package roots. Assert the bundle
contains exactly package metadata, launcher, patch, README, and npm-generated
license material; assert neither tarball includes `test/`, `reports/`, `tmp/`,
private config, or `docs/superpowers/`. Assert the root tarball excludes
`packages/dsh-plugin-chrome-faithful/` so the packages remain independent.

- [x] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/release-contract.test.mjs`

Expected: failure because DSH docs and the bundle pack gate are absent.

- [x] **Step 3: Write DSH-first documentation**

Bundle README includes:

- supported DSH floor `0.1.0-rc.6` and per-RC revalidation warning;
- `dsh plugin --profile <profile> add <package-or-tarball>` installation;
- external `AGENTOS_CHROME_CONFIG` setup and no embedded secret;
- namespaced tool example `mcp__chrome_faithful__chrome_profiles`;
- raw-CDP fully trusted boundary and logged-in browser data visibility;
- core-first publication/private paired-tarball rule;
- no claim of live DSH acceptance until separately authorized.

Root bilingual READMEs add DSH as a first-class quick-start before generic
client registration while preserving all existing client paths.

- [x] **Step 4: Update package allowlists and contributing commands**

Keep root and bundle artifacts independent. Add documented commands for the
bundle contract and paired-tarball tests.

- [x] **Step 5: Run documentation, package, and static gates**

Run:

```bash
npm run check
node --test test/release-contract.test.mjs test/dsh-bundle-contract.test.mjs test/dsh-package-isolation.test.mjs
npm pack --dry-run --json
npm pack --dry-run --json ./packages/dsh-plugin-chrome-faithful
git diff --check
```

Expected: all pass; both JSON pack inventories contain only declared files.

- [x] **Step 6: Commit**

```bash
git add packages/dsh-plugin-chrome-faithful README.md README.zh-CN.md CONTRIBUTING.md package.json test/release-contract.test.mjs
git commit -m "docs: add first-class DSH installation"
```

### Task 5: Full verification, handoff, and independent review

**Files:**
- Create or modify: `HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-14-dsh-first-party-bundle.md`

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: evidence-backed release-readiness state with explicit external gates.

- [x] **Step 1: Run the full Node 22 verification matrix**

Run under Node `>=22.12.0`:

```bash
npm ci --ignore-scripts
npm run check
npm run check:parity
npm run build:extension
git diff --exit-code -- extension/generated/
npm test
npm audit --omit=dev
npm run build:mcpb
node --test test/dsh-package-isolation.test.mjs
```

Expected: every command passes. Record literal suite counts and artifact
inventories; do not infer live Chrome or DSH acceptance.

- [x] **Step 2: Run Windows installer transactions**

Run:

```powershell
pwsh -NoProfile -File test/installer-transactions.test.ps1
```

Expected: all transaction tests pass, not skipped.

- [x] **Step 3: Update handoff and mark plan checkboxes accurately**

Record goal, commits, touched areas, commands/results, current branch, remaining
private-history email decision, absence of live DSH/Chrome acceptance, and the
separate authority required for push/public/npm/live-profile actions.

- [x] **Step 4: Request independent implementation review**

Reviewer inspects actual files and reruns focused evidence. Required output is
`APPROVED` or findings with severity, path, required fix, and verification.

- [x] **Step 5: Fix or disposition every finding and re-run affected gates**

No critical/high finding may remain. Medium/low findings must be fixed or
explicitly accepted as residual risk in `HANDOFF.md`.

- [x] **Step 6: Commit closeout documentation**

```bash
git add HANDOFF.md docs/superpowers/plans/2026-08-14-dsh-first-party-bundle.md
git commit -m "docs: record DSH integration verification"
```
