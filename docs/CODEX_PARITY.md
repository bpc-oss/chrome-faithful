# Browser compatibility contract

Chrome Faithful implements an `agent.browsers`-style JavaScript surface in
`src/agent-browser.mjs`. The repository-authored baseline in `compat/` records
22 functional interfaces and 135 mapped members for compatibility testing.
It contains identifiers and counts needed by this implementation, not copied
declarations, comments, implementation code, or bundled product documentation.

The baseline label `26.721.41059` identifies the behavior snapshot used while
developing the adapter. It is not a claim of endorsement, source compatibility,
or byte-for-byte identity with another product's private internals.

## Required architecture

- Existing logged-in Chrome profiles only.
- One extension registration per exact `metadata.profileName`.
- Multiple profiles connected simultaneously and selected by the agent.
- `chrome.debugger` CDP, with no port 9222/debug profile/copy/Edge fallback.
- MV3 offscreen WebSocket transport with reconnect and heartbeat.
- Authenticated localhost multi-profile router.
- MCP surface for supported clients.
- JavaScript `agent.browsers` adapter for existing code.
- Page `File` + `DataTransfer` upload route.
- Exact-profile streaming of page-exposed media URLs to absolute local paths,
  with size bounds, MIME checks, and SHA-256 evidence.

## Static contract

- `compat/browser-surface-contract.json` records interface names and the
  expected member count.
- `compat/codex-adapter-map.json` maps each functional member identifier to a
  concrete implementation.
- `compat/codex-26.721.41059-manifest.json` pins the map hash and counts.
- `npm run check:parity` rejects count or interface drift, hash drift, and
  missing, no-op, stubbed, or unsupported mappings.
- `test/codex-compat-surface.test.mjs` exercises the concrete runtime objects;
  metadata alone is not accepted as parity evidence.

## Live release gates

| Gate | Required evidence |
|---|---|
| Multi-profile registration | `chrome_profiles` includes every exact profile supplied for acceptance |
| Exact binding | Commands sent to one profile never appear in another |
| Chrome API readiness | `chrome_selftest` passes tabs and `Runtime.evaluate` |
| Background control | Create, navigate, and read a non-focused tab |
| CDP | Runtime, Page, DOM, Input, and screenshot commands pass |
| Locator surface | Locator composition, iframe, state, trusted click, type, and press pass |
| Page/event surface | Dialogs, downloads, file chooser compatibility, DOM CUA, content export, logs, and session finalization pass |
| Lifecycle | Service-worker suspension does not drop the offscreen connection |
| Reconnect | Bridge restart reconnects selected profiles without extension reload |
| File injection | Page sees the original filename, byte size, input event, and change event |
| Page asset save | Exact-profile request context succeeds and saved MIME, bytes, and SHA-256 verify without leaking credentials |
| Consumer isolation | Acceptance uses only this repository's public adapter |

Static validation does not satisfy these live gates. Historical local runs or
unpublished report files are not public release evidence. A release should be
described as `not-live-verified` unless current, reviewable evidence covers the
target version and environment.

## Updating the contract

Derive changes from observable public behavior and tests. Update the
repository-authored surface, adapter implementation, manifest hash, and
concrete behavioral tests together. Do not copy installed documentation bundles
or private implementation material into this repository.
