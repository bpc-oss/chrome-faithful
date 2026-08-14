# Codex Chrome parity contract

Reference: the installed Codex Chrome plugin's `docs/api.json`, version
`26.721.41059`. The frozen contract contains 22 interfaces, 135 members, and
58 public types.

## Required architecture

- Existing logged-in Chrome profiles only.
- One extension registration per exact `metadata.profileName`.
- Multiple profiles connected simultaneously and selected by the agent.
- `chrome.debugger` CDP, with no port 9222/debug profile/copy/Edge fallback.
- MV3 offscreen WebSocket transport with reconnect and heartbeat.
- Authenticated localhost multi-profile router.
- MCP surface for Claude Desktop and WorkBuddy.
- JavaScript `agent.browsers` adapter for existing code.
- Page `File` + `DataTransfer` upload route.
- Exact-profile streaming of page-exposed media URLs to absolute local paths,
  with size bounds, MIME checks, and SHA-256 evidence.

## Live release gates

| Gate | Evidence |
|---|---|
| Multi-profile registration | `chrome_profiles` includes every exact profile supplied through `AGENTOS_ACCEPTANCE_PROFILES` |
| Exact binding | commands sent to one profile never appear in the other |
| Chrome API readiness | `chrome_selftest` passes tabs and Runtime.evaluate |
| Background control | create/navigate/read a non-focused tab |
| CDP | Runtime, Page, DOM, Input, and screenshot commands pass |
| Locator surface | all frozen locator members, including iframe, boolean composition, state, trusted click, type, and press pass |
| Page/event surface | dialogs, downloads, file chooser compatibility, DOM CUA, content export, logs, and session finalization pass |
| Lifecycle | service-worker suspension does not drop the offscreen connection |
| Reconnect | bridge restart reconnects both profiles without extension reload |
| File injection | page sees original filename, byte size, input and change events |
| Page asset save | selector/property is resolved inside the exact-profile tab; UA/referer/cookies fetch succeeds; saved MIME, bytes, and SHA-256 verify without signed-URL or credential leakage |
| Consumer isolation | acceptance uses only the plugin's public adapter and imports no external project runtime |

Static validation does not satisfy these gates. The plugin must report
`not-live-verified` until all gates pass on the user's actual profiles.

## 2026-07-27 parity acceptance

The `0.3.1` implementation maps every frozen `26.721.41059` interface member
to a concrete adapter implementation. The static checker rejects missing,
extra, stubbed, or unsupported mappings.

The live differential fixture passed 16 behavior checks in each selected exact
profile; see
`../reports/parity/live-acceptance-0.3.0.json`. It covers navigation,
self-test, the extension-transport Puppeteer session, locator read/write and
state, iframe locators, DOM CUA, element inspection and screenshots, trusted
dialogs, file chooser and download resources, binary clipboard round-trip and
restore, normalized console logs, navigation events, and content export.

The acceptance report pins source hashes and the installed extension version.
It proves the declared public behavior against the installed Codex contract;
it does not claim byte-for-byte identity with private Codex internals and does
not authorize production publishing.

## Historical 2026-07-25 acceptance

The historical live browser matrix passed on two selected exact profiles; see
`../reports/live-acceptance.json`. WorkBuddy and Claude Desktop each loaded the
then-current MCP server and indexed all 18 tools; see
`../reports/host-acceptance.json`.

This acceptance covers the API surface and runtime behaviors listed above. It
does not claim identity with Codex internals, and it does not authorize
production publishing.

That live matrix re-ran tabs, exact binding, self-test, background control,
locator actions, raw CDP plus events, screenshots, history, clipboard, and page
`File` injection in both profiles. Current acceptance scripts no longer import
or depend on any external project runtime.

The durable capture implementation also returns detached-start diagnostics,
retains its background promise after the MCP response, bounds each page-asset
request with an abortable timeout, and can rewind a bottom-positioned virtual
list through serialized tab-scoped CUA wheel events before a resume scan. These
behaviors prevent request timeout, one hung media response, or stale scroll
position from silently turning a partial history into complete evidence.

Claude Desktop successfully initialized the same server and completed
`tools/list` for all 18 tools after restart. Its configured inference gateway
returned HTTP 502 before the model could perform a second host-originated tool
invocation, so that provider outage is recorded separately from MCP/browser
acceptance rather than being reported as a plugin failure.
