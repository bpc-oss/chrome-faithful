# Chrome Faithful OSS Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chrome Faithful safe and credible to publish by closing the known CI, security-contract, provenance, metadata, packaging, permission, and documentation gaps without changing repository visibility or user-owned runtime configuration.

**Architecture:** Keep the existing MCP/bridge/extension architecture. Add small release-policy helpers and contract tests around it, make public CDP event reads fail closed while documenting raw CDP as a fully trusted capability, replace copied compatibility documentation with a repository-authored surface contract, and make release metadata/build inputs deterministic.

**Tech Stack:** Node.js 20 ESM, `node:test`, GitHub Actions, MV3 Chrome extension, PowerShell installer tests.

## Global Constraints

- Preserve exact-profile routing, localhost-only authenticated bridge behavior, transactional installers, and existing user configuration paths.
- Do not publish, push, rewrite remote history, enable external services, or change GitHub visibility in this implementation.
- Do not add runtime dependencies.
- Treat live Chrome acceptance as a separate release gate; unit/static checks cannot replace it.
- Keep verification backends opt-in and document when data can leave the machine.

---

### Task 1: Portable CI and deterministic generated runtime

**Files:**
- Create: `scripts/run-unit-tests.mjs`
- Create: `scripts/text-normalization.mjs`
- Modify: `scripts/build-extension-runtime.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Test: `test/release-contract.test.mjs`
- Test: `test/text-normalization.test.mjs`

**Interfaces:**
- Produces `normalizeLf(text: string): string`.
- Produces a portable test runner that enumerates only `test/*.test.mjs` and passes explicit paths to `node --test`.

- [ ] Write failing tests proving the package test command contains no shell glob and CRLF normalizes to LF.
- [ ] Run the focused tests and confirm the expected failures.
- [ ] Implement the explicit test runner and LF-normalized build banner.
- [ ] Update CI to run build before hash tests and fail on generated diff.
- [ ] Run focused and full unit tests.

### Task 2: Honest raw-CDP trust boundary

**Files:**
- Create: `src/cdp-policy.mjs`
- Modify: `src/mcp-server.mjs`
- Modify: `SECURITY.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Test: `test/cdp-policy.test.mjs`
- Test: `test/cdp-events.test.mjs`

**Interfaces:**
- Produces `publicCdpEventOptions(options): object`, which always forces `includeSensitive: false`.
- Raw `chrome_cdp` `send` remains available but is explicitly documented as a fully trusted capability able to read authenticated browser state.

- [ ] Write failing tests proving public event options cannot enable sensitive output.
- [ ] Run the focused tests and confirm the expected failure.
- [ ] Apply the policy to the MCP read-events route and remove `includeSensitive` from its public schema.
- [ ] Replace overbroad non-leakage claims with precise safe-projection versus raw-CDP boundaries.
- [ ] Run security-focused tests.

### Task 3: Remove copied compatibility fixture and unify release metadata

**Files:**
- Delete: `compat/codex-26.721.41059-api.json`
- Create: `compat/browser-surface-contract.json`
- Modify: `compat/README.md`
- Modify: `compat/codex-26.721.41059-manifest.json`
- Modify: `scripts/check-codex-parity.mjs`
- Modify: `scripts/generate-codex-adapter-map.mjs`
- Modify: `test/codex-parity-contract.test.mjs`
- Modify: `.codex-plugin/plugin.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `docs/CODEX_PARITY.md`
- Modify: `mcpb/manifest.json`
- Test: `test/release-contract.test.mjs`

**Interfaces:**
- The repository-authored compatibility contract contains only interface/member/type identifiers required by this implementation, with no copied declaration text or comments.
- All public manifests report version `0.4.0`; MCPB tool names equal the server registry.

- [ ] Write failing metadata/tool-set contract tests.
- [ ] Run them and confirm version/tool mismatches.
- [ ] Replace the copied fixture with the minimal surface contract and update parity tooling.
- [ ] Align all manifest versions and generate the complete MCPB tool list.
- [ ] Run parity and release-contract tests.

### Task 4: Reproducible, least-privilege packaging and CI

**Files:**
- Modify: `scripts/build-mcpb.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `THIRD_PARTY_NOTICES.md`
- Test: `test/release-contract.test.mjs`

**Interfaces:**
- MCPB staging installs locked production dependencies inside its own staging root instead of copying the developer's `node_modules`.
- npm package contents are constrained by a `files` allowlist.

- [ ] Add failing contract checks for a package allowlist, minimal Actions permissions, SHA-pinned Actions, and no source `node_modules` copy.
- [ ] Run the focused test and confirm failures.
- [ ] Implement locked production-only staging and the package allowlist.
- [ ] Pin Actions to immutable SHAs, add `contents: read`, and verify generated files after build.
- [ ] Run dry-run package/MCPB inspections and dependency audit.

### Task 5: Permission and verification-backend disclosure

**Files:**
- Modify: `extension/manifest.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SECURITY.md`
- Test: `test/release-contract.test.mjs`

**Interfaces:**
- Extension host permissions are restricted to the authenticated localhost bridge; `chrome.debugger` remains the explicit high-trust permission.
- Documentation states that remote OCR/ASR endpoints receive challenge assets and are only for authorized use.

- [ ] Add a failing least-host-permission contract test.
- [ ] Run it and confirm `<all_urls>` causes the failure.
- [ ] Remove the unused broad host permission and document every required high-impact permission.
- [ ] Add authorization, site-terms, and external-backend privacy boundaries.
- [ ] Run manifest/security tests.

### Task 6: Release evidence and closeout

**Files:**
- Create: `HANDOFF.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/CODEX_PARITY.md`

**Interfaces:**
- Handoff distinguishes verified source/unit evidence from unrun live/publication gates.

- [ ] Remove or qualify claims that depend on absent private reports.
- [ ] Record changed files, decisions, commands, evidence, residual blockers, and publication steps in `HANDOFF.md`.
- [ ] Run full Node checks, Windows installer tests, package dry-run, secret/history scan, and repository diff review.
- [ ] Request independent code/security review and resolve every important finding.
- [ ] Leave remote visibility and history rewrite as explicit, unexecuted owner actions.
