# Contributing to Chrome Faithful

Thanks for helping. This project controls *real, logged-in Chrome profiles*, so
reviewers care as much about safety invariants as about features.

## Ground rules

- **Never commit secrets.** `config/local.json` (and `config/*.bak-*`) hold
  machine-specific bridge secrets and are gitignored. Keep them out of every
  diff, screenshot, and paste.
- **Keep the safety model intact.** New tools must respect exact-profile
  selection, localhost-only authenticated routing, and the redaction rules for
  cookies / signed URLs / headers. See `SECURITY.md`.
- **Keep the generic boundary clean.** `npm run check` fails on
  project-specific tokens (private project names, personal handles) in
  public-facing files. Run it before pushing.
- **Small patches first.** Prefer existing libraries over new dependencies.

## Development setup

Node.js 22.12 or newer is required.

```bash
npm ci --ignore-scripts   # puppeteer-core is used as a library; no browser download
npm run check             # static gates (file presence, JSON validity, generic boundary)
npm test                  # mock/unit tests (node --test)
npm run build:extension   # regenerate extension/generated/puppeteer-runtime.js
npm run check:parity      # repository-authored browser compatibility contract
```

Installer transaction tests (Windows):

```powershell
pwsh -NoProfile -File test/installer-transactions.test.ps1
```

Static checks and mock tests are necessary but not sufficient. Live acceptance
requires two concurrently connected real profiles and is driven by
`scripts/live-acceptance.mjs` and `scripts/differential-acceptance.mjs` — see
the "Acceptance" section of `README.md`.

## Pull requests

1. Fork and create a feature branch.
2. Add or update tests for behavior changes. Security-related behavior gets a
   dedicated contract test (see `test/bootstrap-security.test.mjs`,
   `test/config-security.test.mjs`).
3. Run `npm run check` and `npm test` locally.
4. Open the PR with a short description of the change and the safety
   implications, if any.
