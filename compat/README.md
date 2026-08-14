# Codex compatibility fixtures

These files pin the `agent.browsers` API surface that `src/agent-browser.mjs`
implements, so parity is checked mechanically instead of by memory:

- `codex-26.721.41059-api.json` — a captured type-declaration contract of the
  Codex bundled chrome plugin's `agent.browsers` API (method signatures only,
  no code). Consumed by `scripts/check-codex-parity.mjs` and
  `test/codex-parity-contract.test.mjs`.
- `codex-26.721.41059-manifest.json` — provenance + SHA-256 of the contract
  above. `check-codex-parity.mjs` verifies the hash, so the contract must not
  be edited without updating this manifest.
- `codex-adapter-map.json` — maps every contract member to its implementation
  in this repository. Regenerate with:

  ```bash
  npm run generate:parity-map
  ```

## Regenerating for a newer Codex build

When you want to pin a newer Codex bundled chrome plugin build:

1. Locate the installed docs bundle, e.g.
   `~/.codex/plugins/cache/openai-bundled/chrome/<version>/docs/api.json`.
2. Replace `codex-26.721.41059-api.json` with the new contract and update the
   manifest's `version` and `sha256` (or run the parity check and let it report
   the expected hash).
3. Regenerate the adapter map, then run `npm run check:parity` and the full
   test suite to close gaps in `src/agent-browser.mjs`.
