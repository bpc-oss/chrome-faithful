# Chrome Faithful handoff

## Current state

- Provider-neutral Chrome Faithful core plus first-party DSH bundle is complete.
- Branch: `codex/dsh-bundle-implementation`; release-fix commit `e0f4a00` is on
  both `origin/main` and `origin/codex/dsh-bundle-implementation`.
- GitHub repository remains private. Nothing has been published to npm and no
  repository visibility change was made.
- A local-first DSH vision extension is approved and documented, but only its
  design (`933faf8`) and implementation plan (`80c6ad2`) exist locally. No
  visual implementation or model/runtime installation has started.
- DSH support targets `@deepseek-ai/dsh 0.1.0-rc.6`; revalidate composition for
  every DSH RC.

## Release closeout completed

- Rewrote every reachable commit author/committer identity from the personal
  email to `bpc-oss <bpc-oss@users.noreply.github.com>`, then force-updated the
  private remote with a lease. Local and `origin/main` old-email counts are 0.
- Stored the pre-rewrite recovery bundle outside the repository at
  `%LOCALAPPDATA%\AgentOS\backups\chrome-faithful-history\20260814T123100Z`.
  Bundle SHA-256:
  `1682b89a4670dd8d49952cb408daa2c5f9dc0480655e34d3095a2e6195171baf`.
- Fixed WSL-launched Windows Agent Lessons discovery when inherited `PATHEXT`
  omitted `.EXE`. Global Agent OS backup `20260814T122443Z` was created before
  the change. Fresh `validate`, `closeout`, and `stats` returned
  `VALIDATION_PASSED`, `CLOSEOUT_COMPLETED`, and `STATS_COMPLETED`.
- Kept Agent Lessons outputs `.agent-os/` and `docs/agent-lessons.md` untracked;
  they are private/generated evidence and must not be staged.
- Fixed Windows release contracts, DSH tarball isolation, PowerShell 7 ACL API
  compatibility, and private storage ownership normalization. Exact access
  rules remain current user plus `SYSTEM`; temporary directories owned by the
  built-in Administrators group are normalized to the current user.

## Verification evidence

- GitHub Actions run
  `https://github.com/bpc-oss/chrome-faithful/actions/runs/31804452839` at
  `e0f4a00`: Ubuntu and Windows jobs both passed. The Windows job passed DSH
  host/isolation, checks, parity, extension build/diff, full Node tests, and
  installer transactions.
- Node `v22.12.0`: 218/218 tests passed; `CHECK_OK`; parity passed with 22
  interfaces, 135 members, and contract hash `ab80319f...`.
- Windows PowerShell 5.1 and PowerShell 7 installer transaction suites both
  returned `PASS`, including apply/restore, absent target, fault rollback,
  Claude untouched, and production guard checks.
- Disposable DSH/Chrome acceptance receipt:
  `%LOCALAPPDATA%\AgentOS\reports\chrome-faithful\dsh-live-acceptance-20260814.json`.
  It records `PASS` with DSH `0.1.0-rc.6`, Chrome for Testing
  `152.0.7977.42`, 37 namespaced tools, startup failure rejection with 0 tools
  registered, a DSH-side `chrome_profiles` call, and verified exact-profile
  binding. The disposable DSH profile, packages, config, Chrome profile, and
  process were removed; the receipt remains.
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
- Implementation is waiting for the user's execution-mode choice: explicit
  subagent-driven work or inline execution in the current task.

## Remaining gates

- Independent closeout review of `c1c2922..e0f4a00`, history rewrite, Agent
  Lessons fix, live receipt, and CI is in progress. Resolve every finding before
  claiming release closeout complete.
- The visual design/plan commits are local only and intentionally were not
  pushed into the already-green release-fix CI run.
- GitHub Actions reports a non-failing platform annotation that pinned checkout
  and setup-node actions still declare Node 20 metadata while GitHub forces
  them to Node 24. Track upstream pinned releases; do not unpin actions.
