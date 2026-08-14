# Bilingual release documentation design

## Goal

Present Chrome Faithful 0.4.0 as a professional bilingual open-source release
without translating internal engineering material or overstating unverified
capabilities. English and Simplified Chinese readers should receive the same
product positioning, DSH setup guidance, security boundaries, and verified
OCR quality evidence.

## Scope

The public bilingual surface consists of:

- the root English and Simplified Chinese READMEs;
- the DSH bundle English README and a new Simplified Chinese counterpart; and
- a concise Simplified Chinese counterpart to the live PP-OCRv5 mobile
  acceptance report.

Security policy, contribution policy, internal specifications, handoff files,
and implementation comments remain outside this translation pass.

## Document structure

Use paired standalone documents rather than interleaving two languages in one
file. Each pair begins with a reciprocal language selector using repository-
relative links.

### Root README pair

Keep `README.md` and `README.zh-CN.md` independently readable and align their
public section order. Add a short evidence-led quality summary to the local
vision section in both files. The summary links to the corresponding live
acceptance report and states:

- 7/7 blocks detected;
- 99.43% raw character accuracy and 100% non-whitespace accuracy;
- 0.9754 mean and 0.9379 minimum confidence;
- valid normalized coordinates and reading order;
- identical output across three production-path calls; and
- approximately 3.0 to 3.25 seconds per end-to-end call on the accepted AMD
  Ryzen 9 9950X3D CPU host.

The summary must not generalize the measured AMD result to all CPUs.

### DSH bundle README pair

Retain `packages/dsh-plugin-chrome-faithful/README.md` as the npm-facing English
README and add `packages/dsh-plugin-chrome-faithful/README.zh-CN.md`. The two
files use matching sections for compatibility, installation, configuration,
security boundary, and verification status.

Both languages must preserve these exact contracts:

- DSH baseline `@deepseek-ai/dsh` `0.1.0-rc.6`;
- Node.js `>=22.12.0`;
- bundle and core versions match exactly at `0.4.0`;
- the core package is published before the bundle;
- the host owns the DSH MCP client dependency;
- all six forwarded environment variables remain explicit string values;
- raw `chrome_cdp` send is an unrestricted trusted-client boundary; and
- no Python runtime, model weights, secret, download, remote backend, or cloud
  fallback is bundled.

Add a short local OCR evidence paragraph in both files. It may call the default
PP-OCRv5 route live-accepted, but it must keep the optional VLM path described
as disabled by default and not quality-approved.

### Acceptance report pair

Keep `docs/visual-model-acceptance-2026-08-14.md` as the full English evidence
record and add `docs/visual-model-acceptance-2026-08-14.zh-CN.md` as a faithful,
concise Chinese counterpart. Preserve runtime versions, archive SHA-256 values,
production-path description, metrics, the sole whitespace difference, the AMD
oneDNN failure, and the `enable_mkldnn=False` disposition. Add reciprocal
language selectors.

## Editorial rules

- Lead with exact-profile control of real logged-in Chrome rather than generic
  browser automation claims.
- Use `Profile`, `DSH`, `MCP`, `CDP`, `PP-OCRv5`, and environment-variable names
  consistently across languages.
- Translate meaning, not command names, package identifiers, hashes, metrics,
  or security terminology.
- Keep headings and navigation compact; do not duplicate internal release
  history in public READMEs.
- Describe PP-OCRv5 mobile as verified only within the recorded acceptance
  environment.
- Describe SmolVLM2 and Moondream only as examples of user-operated optional
  adapters. Do not imply they were installed, benchmarked, or approved.
- Preserve the repository's private/unpublished state during this work.

## Verification

The implementation is acceptable when:

1. every language selector resolves to a tracked file;
2. the DSH README pair has matching public section headings and exact contract
   values;
3. the root README pair contains the same OCR evidence metrics and limitations;
4. the acceptance report pair contains identical hashes and quantitative
   results;
5. no statement upgrades the optional VLM path to verified status;
6. Markdown links and repository-local paths resolve;
7. `git diff --check`, project checks, and the full Node 22 test suite pass; and
8. an independent reviewer finds no material translation drift, unsupported
   release claim, or missing public-language link.

## Non-goals

- Translating every repository document.
- Changing runtime behavior, packaging, versions, dependencies, or security
  policy.
- Publishing packages, tags, GitHub releases, or changing repository
  visibility.
- Installing or evaluating an optional VLM.
