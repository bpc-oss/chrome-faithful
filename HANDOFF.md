# Chrome Faithful handoff

## Current state

- Goal: keep the provider-neutral Chrome Faithful core and add a first-party
  DeepSeek Harness bundle without duplicating browser control logic.
- Branch: `codex/dsh-bundle-implementation`.
- Repository and remote remain private. Nothing in this branch has been pushed,
  published to npm, installed into a live DSH profile, or activated against a
  live Chrome profile.
- The bundle targets the reviewed DSH host contract beginning at
  `@deepseek-ai/dsh 0.1.0-rc.6`; DSH is still release-candidate software and the
  composition contract must be revalidated for every RC.

## Implemented

- Added stable core exports for `chrome-faithful` and
  `chrome-faithful/mcp-server`.
- Added independently packable
  `@bpc-oss/dsh-plugin-chrome-faithful@0.4.0` with an exact
  `chrome-faithful@0.4.0` dependency and Node `>=22.12.0` floor.
- Composed the host-provided `@deepseek-ai/dsh-mcp-client` through one Cordis
  patch using `process.execPath`, absolute launcher resolution,
  `failOnStartupError: true`, a conditional string-only environment map, and a
  60-second tool timeout.
- Added parsed/evaluated DSH contract tests and paired-tarball isolation tests
  that deliberately exclude profile `.bin` from `PATH`.
- Added bilingual first-class DSH documentation and independent npm package
  allowlists.
- Corrected both Windows installers after the public display-name rename had
  left their fail-closed manifest checks on the old name.

## Verification evidence

All Node checks used Node `v22.12.0` from this worktree.

- `npm ci --ignore-scripts`: pass; 149 packages, 0 vulnerabilities.
- `npm run check`: `CHECK_OK`.
- `npm run check:parity`: pass; 22 interfaces, 135 members, contract hash
  `ab80319...`.
- `npm run build:extension` plus
  `git diff --exit-code -- extension/generated/`: pass; generated runtime
  SHA-256 `13def5cda71c4f375cffa3ae4f550c0deee5497ee2b0f6f913dbfbee26f8868e`.
- `npm test`: 218 tests, 218 pass, 0 fail, 0 skipped.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `npm run build:mcpb`: pass.
- `node --test test/dsh-host-contract.test.mjs test/dsh-package-isolation.test.mjs`:
  4 tests, 4 pass. Both implicit and explicit missing-config branches reached
  the core through published DSH rc.6 Boot/Include/MCP Client, rejected
  activation, and left the supplied tool registry empty.
- Core dry-run package: 71 entries; DSH dry-run package: exactly `LICENSE`,
  `README.md`, `bin/chrome-faithful-mcp.mjs`, `cordis.patch.yml`, and
  `package.json`.
- Windows PowerShell `test/installer-transactions.test.ps1`: `PASS`, including
  extension/client apply-restore, absent-target restore, fault rollback,
  untouched Claude configuration, and the production guard in `finally`.
- `git diff --check`: pass.

## Decisions and remaining gates

- The existing extension, bridge, exact-profile routing, raw CDP trust boundary,
  and existing client integrations remain the core; the DSH package is only a
  composition bundle.
- No DSH-specific UI or duplicate browser implementation was added.
- A disposable live DSH/Chrome acceptance run remains not run because it would
  change a user-owned profile and requires a separately chosen disposable
  `DSH_HOME` and explicit activation scope.
- GitHub Actions on this branch cannot run until it is pushed; current evidence
  is local CI-equivalent evidence only.
- The repository's existing ten historical commits expose
  `bpc-oss@users.noreply.github.com`. Decide whether to preserve or rewrite private history
  before making the repository public; no history rewrite has been performed.
- Push, npm publication, repository visibility changes, live-profile install,
  and history rewriting remain external/destructive release actions and were
  intentionally not performed.
- Independent implementation review verdict: `APPROVED` at `c1c2922`. The
  reviewer reran Node 22 release/DSH tests, Windows installer transactions,
  audits, package inventories, and immutable source-link checks. No unresolved
  critical, high, medium, or low finding remains in the reviewed scope.

## Key commits

- `0493d9c` — package boundary and launcher.
- `94cdc78` — DSH composition contract.
- `a772247` — paired-tarball isolation and CI coverage.
- `297039e` — DSH documentation and packaging gates.
- `0e79adc` — Windows installer display-name contract repair.
- `c26462b` — published DSH rc.6 host proof, compatibility export, and notices.
- `c1c2922` — immutable DSH source notices and URL regression gate.
