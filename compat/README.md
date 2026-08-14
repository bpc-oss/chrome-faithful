# Browser compatibility surface

This directory pins the functional `agent.browsers`-style surface implemented
by `src/agent-browser.mjs` without redistributing bundled plugin documentation:

- `browser-surface-contract.json` records repository-authored interface names
  and the expected member count. It contains no copied declarations, comments,
  implementation code, or private internals.
- `codex-adapter-map.json` maps every functional member identifier to its
  concrete implementation in this repository.
- `codex-26.721.41059-manifest.json` records the behavioral baseline and the
  SHA-256 of the adapter map.

`npm run check:parity` rejects count drift, interface drift, hash drift, and
missing/no-op/stub mappings. `test/codex-compat-surface.test.mjs` independently
exercises the concrete runtime objects, so the map is not accepted as evidence
by itself.

When the compatibility surface changes, update the repository-authored
contract and adapter implementation from observable public behavior, update the
manifest hash, and add or update concrete behavioral tests. Do not copy an
installed product's documentation bundle into this repository.
