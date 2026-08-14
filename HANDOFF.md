# Chrome Faithful handoff

## Current state

- Provider-neutral Chrome Faithful core plus first-party DSH bundle is complete.
- Branch: `codex/dsh-bundle-implementation`; sanitized release and vision-doc
  history through `7bc945b` is on both `origin/main` and
  `origin/codex/dsh-bundle-implementation`.
- GitHub repository remains private. Nothing has been published to npm and no
  repository visibility change was made.
- A local-first DSH vision extension is approved and documented on the remote
  (`eb50403` design, `6072a7a` implementation plan). No visual implementation
  or model/runtime installation has started.
- DSH support targets `@deepseek-ai/dsh 0.1.0-rc.6`; revalidate composition for
  every DSH RC.

## Release closeout completed

- Rewrote the personal email from reachable commit identities and file content,
  removed rewrite refs, expired reflogs, pruned unreachable objects, then
  force-updated the private remote with a lease. Local refs/reflogs and
  `origin/main` identity/content counts are all 0.
- Stored the pre-rewrite recovery bundle outside the repository at
  `%LOCALAPPDATA%\AgentOS\backups\chrome-faithful-history\20260814T123100Z`.
  Bundle SHA-256:
  `1682b89a4670dd8d49952cb408daa2c5f9dc0480655e34d3095a2e6195171baf`.
- Stored a second complete pre-redaction bundle at
  `%LOCALAPPDATA%\AgentOS\backups\chrome-faithful-history\20260814T133403Z`.
  Bundle SHA-256:
  `4b7408baba6d0c453870bde1693b9df28e8d72da7a44a4273738d0cfe1389e67`.
  Both backup directories have protected native ACLs limited to the current
  Windows user and `SYSTEM`; they intentionally retain the recovery history.
- Fixed WSL-launched Windows Agent Lessons discovery when inherited `PATHEXT`
  omitted `.EXE`. The initial global backup `20260814T122443Z` did not include
  the changed `bin\agent-lessons.ps1`, so it is not the restoration source for
  this fix. A scoped before/after/patch backup was stored at
  `%LOCALAPPDATA%\AgentOS\backups\agent-os-source\20260814T133650Z`; before,
  after, and patch SHA-256 values are
  `b5e4dadaa84ce59322ee33afae4701e49dc65f3032914cfc725d4a4e14b6ce6e`,
  `e82be3fb2f7385a1a141a3583f192e633f040a0157c3d1ccddbb4c6be8491f8c`,
  and `88b358bb5c5ac93176c3de90aed0ba771746a5048a23fff5da42bcbfa585c916`.
  A temporary, non-mutating reconstruction produced the exact
  after hash and byte-identical file. Fresh `validate`, `closeout`, and `stats`
  returned `VALIDATION_PASSED`, `CLOSEOUT_COMPLETED`, and `STATS_COMPLETED`.
- Kept Agent Lessons outputs `.agent-os/` and `docs/agent-lessons.md` untracked;
  they are private/generated evidence and must not be staged.
- Fixed Windows release contracts, DSH tarball isolation, PowerShell 7 ACL API
  compatibility, and private storage ownership normalization. Exact access
  rules remain current user plus `SYSTEM`; temporary directories owned by the
  built-in Administrators group are normalized to the current user.

## Verification evidence

- GitHub Actions run
  `https://github.com/bpc-oss/chrome-faithful/actions/runs/31805496905` at
  `7bc945b`: Ubuntu and Windows jobs both passed. The Windows job passed DSH
  host/isolation, checks, parity, extension build/diff, full Node tests, and
  installer transactions.
- Node `v22.12.0`: 218/218 tests passed; `CHECK_OK`; parity passed with 22
  interfaces, 135 members, and contract hash `ab80319f...`.
- Windows PowerShell 5.1 and PowerShell 7 installer transaction suites both
  returned `PASS`, including apply/restore, absent target, fault rollback,
  Claude untouched, and production guard checks.
- Disposable DSH/Chrome acceptance receipt:
  `%LOCALAPPDATA%\AgentOS\reports\chrome-faithful\dsh-live-acceptance-20260814-v2.json`
  (SHA-256 `7bedb2c95c8ebc70daf781bc5e5ecea16a99a027eb1d2e3cca1208aae3c9d88c`).
  It records `PASS` against `7bc945b` with DSH
  `0.1.0-rc.6`, Chrome for Testing `152.0.7977.42`, all 37 tool names and their
  digest, startup failure rejection with 0 tools registered, and exact DSH call
  `mcp__chrome_faithful__chrome_profiles` with `{}` arguments. The result found
  the sole `DSH Disposable` profile and verified binding to directory
  `Default`. Cleanup receipt `dsh-live-acceptance-20260814-v2-cleanup.json`
  (SHA-256 `a3ab83c341fce9caeeb3869292b5fad3167ed940a31a32dd315e3776c59f2a3e`)
  records the disposable root absent and 0 matching processes. Both receipts
  have protected native ACLs limited to the current Windows user and `SYSTEM`;
  WSL access to the primary receipt is denied.
- Live acceptance installed paired local tarballs. Because pnpm v10 otherwise
  tried the registry for the unpublished core child dependency, the disposable
  profile used a temporary workspace override binding the core to its local
  tarball. Published artifacts were not changed.
- Existing Chrome sessions and the live port 18755 service were not used or
  modified.

## DSH local vision decision

- Approved direction: default local PP-OCRv5 mobile text/coordinate extraction
  plus a disabled-by-default local VLM adapter for SmolVLM2, Moondream, or a
  compatible user-operated backend.
- Design:
  `docs/superpowers/specs/2026-08-14-dsh-local-vision-design.md`.
- Plan: `docs/superpowers/plans/2026-08-14-dsh-local-vision.md`.
- The core will reuse exact-profile screenshots and return bounded text-only
  JSON because DSH rc.6 discards MCP image blocks. No cloud upload, automatic
  model download, Python installation, or bundled weights are allowed.
- Implementation will proceed inline in the current task unless the user asks
  to split it into delegated work.

## Remaining gates

- Independent closeout re-review of the current sanitized history, scoped Agent
  Lessons restoration evidence, v2 live receipt, and final CI remains required.
- Vision design and plan are already remote; implementation remains a separate
  post-closeout change.
- GitHub Actions reports a non-failing platform annotation that pinned checkout
  and setup-node actions still declare Node 20 metadata while GitHub forces
  them to Node 24. Track upstream pinned releases; do not unpin actions.
