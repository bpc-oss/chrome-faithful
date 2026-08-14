# Chrome Faithful handoff

## Current state

- Provider-neutral Chrome Faithful core, first-party DSH bundle, and local-first
  visual extraction are implemented on `codex/dsh-bundle-implementation`.
- The public remote feature branch and `main` contain the reviewed visual
  implementation, live OCR fix, and bilingual release presentation through
  `1ea2482`; GitHub Actions run `31821231998` passed.
- GitHub release `v0.4.0` is public. This is a GitHub-only source release;
  neither npm package has been published.
- DSH support targets `@deepseek-ai/dsh 0.1.0-rc.6`; revalidate composition for
  every DSH RC.
- Agent Lessons outputs `.agent-os/` and `docs/agent-lessons.md` are private,
  generated, untracked, and must not be staged.

## Release and privacy closeout

- Rewrote the personal email from reachable identities and file content,
  removed rewrite refs, expired reflogs, pruned unreachable objects, and
  force-updated the private remote with a lease. Local refs/reflogs and remote
  identity/content counts are 0.
- The two complete recovery bundles retain pre-rewrite history outside the
  repository under
  `%LOCALAPPDATA%\AgentOS\backups\chrome-faithful-history\20260814T123100Z`
  and `20260814T133403Z`. Their plaintext SHA-256 values remain
  `1682b89a4670dd8d49952cb408daa2c5f9dc0480655e34d3095a2e6195171baf`
  and `4b7408baba6d0c453870bde1693b9df28e8d72da7a44a4273738d0cfe1389e67`.
- Bundles, old manifests, and DSH acceptance receipts are now stored only as
  DPAPI-CurrentUser ciphertext. Original plaintext names are absent from both
  logical and physical LocalCache paths. Native round-trip hashes match and
  both decrypted bundles pass Windows `git.exe bundle verify`; ciphertext,
  envelope metadata, and timestamp directories have protected ACLs limited to
  the current Windows user and `SYSTEM`.
- WSL can observe the ciphertext. A same-user WSL process can deliberately
  invoke native Windows DPAPI; this is the explicit residual boundary, not a
  claim that ciphertext metadata is hidden.
- Fixed WSL-launched Windows Agent Lessons discovery when inherited `PATHEXT`
  omitted `.EXE`. The initial global backup `20260814T122443Z` did not contain
  `bin\agent-lessons.ps1`; the valid scoped before/after/patch backup is
  `%LOCALAPPDATA%\AgentOS\backups\agent-os-source\20260814T133650Z` with
  hashes `b5e4dadaa84ce59322ee33afae4701e49dc65f3032914cfc725d4a4e14b6ce6e`,
  `e82be3fb2f7385a1a141a3583f192e633f040a0157c3d1ccddbb4c6be8491f8c`,
  and `88b358bb5c5ac93176c3de90aed0ba771746a5048a23fff5da42bcbfa585c916`.
  Non-mutating reconstruction was byte-exact; fresh `validate`, `closeout`, and
  `stats` returned `VALIDATION_PASSED`, `CLOSEOUT_COMPLETED`, and
  `STATS_COMPLETED`.
- Independent release/security review returned `APPROVED` after rechecking
  DPAPI round trips, hashes, native bundle verification, old-path absence,
  ACLs, private visibility, remote refs, and CI.

## DSH live acceptance and release baseline

- GitHub Actions run
  `https://github.com/bpc-oss/chrome-faithful/actions/runs/31807029760` at
  `5cb2209` passed Ubuntu and Windows jobs, including DSH host/isolation,
  checks, parity, extension generation/diff, full Node tests, and installer
  transactions.
- Disposable DSH/Chrome acceptance passed against the paired private tarballs,
  DSH `0.1.0-rc.6`, and Chrome for Testing `152.0.7977.42`. The DPAPI-protected
  v2 receipt has plaintext SHA-256
  `7bedb2c95c8ebc70daf781bc5e5ecea16a99a027eb1d2e3cca1208aae3c9d88c`.
  It records all 37 baseline tool names, fail-loud startup with 0 tools left
  registered, and the exact DSH call
  `mcp__chrome_faithful__chrome_profiles` with `{}` arguments resolving the
  sole `DSH Disposable` profile to directory `Default`.
- The cleanup receipt plaintext SHA-256 is
  `a3ab83c341fce9caeeb3869292b5fad3167ed940a31a32dd315e3776c59f2a3e`;
  it records the disposable root absent and 0 matching processes. Existing
  Chrome sessions and the live port 18755 service were not used or modified.

## Local vision implementation

- `chrome_visual_extract` is the 38th MCP tool. It reuses one exact-profile
  screenshot and returns text-only JSON: image dimensions/hash, OCR text,
  confidence, and normalized coordinates; screenshot bytes, base64, local
  paths, stderr, and raw backend errors are not returned.
- The default OCR route is the shipped PP-OCRv5 mobile adapter. It requires
  user-installed Python/PaddleOCR and explicit absolute local
  `PP-OCRv5_mobile_det` and `PP-OCRv5_mobile_rec` directories. It does not
  install packages, download weights, write screenshots, or call a remote API.
- Optional VLM mode is disabled until `CHROME_FAITHFUL_VLM_BACKEND` is set to a
  local CLI or explicit loopback HTTP endpoint. CLI spawning uses `shell:false`;
  HTTP accepts only exact `http://127.0.0.1:<port>` or
  `http://[::1]:<port>`, follows no redirects, and all transports enforce
  request, response, timeout, text, block-count, pixel, and final-result bounds.
- DSH forwards only six declared string environment variables. No model,
  Python runtime, PaddleOCR dependency, or VLM weights are bundled.
- Real PP-OCRv5 mobile quality acceptance passed through a disposable Chrome
  extension, bridge, MCP server, and `chrome_visual_extract`. The controlled
  mixed Chinese/English corpus detected 7/7 blocks, reached 99.43% raw and 100%
  non-whitespace character accuracy, had 0.9754 mean/0.9379 minimum
  confidence, valid normalized coordinates and reading order, and produced
  identical output across three 3.00--3.25 second calls. See
  `docs/visual-model-acceptance-2026-08-14.md`.
- PaddlePaddle 3.3.1's default oneDNN path failed on the acceptance AMD CPU.
  A single-variable diagnostic proved that `enable_mkldnn=False` restores
  inference; the adapter now selects that portable CPU path and its regression
  fixture requires it.

## Verification on the visual tree

- Node `v22.12.0`: 256/256 full tests passed with 0 failures/skips. The focused
  real DSH rc.6 host, package isolation, bundle, and release contracts passed
  20/20.
- `CHECK_OK`; parity passed with 22 interfaces, 135 members, and contract hash
  `ab80319f...`; deterministic extension generation produced no tracked diff.
- Windows PowerShell 5.1 and PowerShell 7 installer transaction suites both
  returned `PASS`, including apply/restore, absent target, fault rollback,
  Claude untouched, and production guard checks.
- `npm audit` for the full and production-only dependency graphs returned 0
  vulnerabilities. Dry-run package inventory contains the PP-OCR adapter and
  visual modules but no weights or runtime dependency tree.
- MCPB staging now copies and asserts the exact runtime PP-OCR adapter path;
  both CI jobs build MCPB. Actual local MCPB build and runtime-path inspection
  passed.
- Independent visual review found and the implementation fixed: actual MCP
  payload-size drift from pretty JSON, synchronous spawn diagnostic leakage,
  screenshot diagnostic leakage, missing pre-base64 screenshot byte bounds,
  incomplete timeout process cleanup, and the omitted MCPB adapter. Targeted
  re-review returned `APPROVED` with 37/37 independent checks and no remaining
  finding.
- GitHub Actions run
  `https://github.com/bpc-oss/chrome-faithful/actions/runs/31817305227` at
  `37309b0` passed both Ubuntu and Windows jobs. Two preceding Windows-only
  failures exposed and led to fixes for direct `.cmd` spawning during MCPB
  construction and PP-OCR output under a `cp1252` console; the final run
  exercises the portable npm launcher and binary UTF-8 OCR protocol.
- The default WSL Node is `v20.20.2`, below the declared `>=22.12.0` engine;
  its DSH host test fails at `Promise.withResolvers`. This is an environment
  rejection, not counted as a pass. All acceptance evidence uses Node 22.12.0.

## Bilingual release presentation

- Root, DSH bundle, and PP-OCRv5 acceptance documentation now have reciprocal
  English/Simplified Chinese presentation. Both root READMEs summarize the
  measured 7/7, 99.43%/100%, 0.9754/0.9379, and three-run latency evidence.
- The DSH README pair explicitly distinguishes direct production MCP OCR
  acceptance from untested DSH-model consumption. The optional VLM remains
  disabled by default, uninstalled, unevaluated, and not approved.
- The DSH npm allowlist now includes `README.md` and `README.zh-CN.md`. A dry-run
  pack produced exactly six files and both relative language links resolve
  inside that inventory.
- `test/release-contract.test.mjs` locks reciprocal selectors, heading order,
  versions, Node/DSH floors, 38 tools, the exact six-variable forwarding set,
  model hashes, unique evidence metrics, raw-CDP trust boundaries, and negative
  DSH/VLM claims. Deliberate replacement and additive contradiction mutations
  prevent false-green documentation drift.
- Node 22.12.0 full tests passed 257/257 with 0 failures/skips; `CHECK_OK` and
  parity 22 interfaces/135 members passed. Independent implementation review
  returned `APPROVED` after three finding-and-repair cycles closed package,
  semantic-boundary, readability, and additive-contradiction gaps.
- GitHub Actions run
  `https://github.com/bpc-oss/chrome-faithful/actions/runs/31821231998` at
  `1ea2482` passed Ubuntu and Windows, including MCPB and Windows installer
  transaction tests. The repository and bilingual GitHub release `v0.4.0` are
  public; npm publication remains deliberately out of scope.

## Remaining gates

- Optional VLM quality acceptance remains unrun. Keep it separate from the
  completed PP-OCRv5 mobile acceptance; do not download or enable a VLM or use
  a cloud fallback implicitly.
- GitHub Actions may emit a non-failing annotation because pinned checkout and
  setup-node revisions declare older Node metadata while GitHub forces Node 24.
  Track upstream pinned releases; do not unpin actions.
