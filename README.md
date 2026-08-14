# Chrome Faithful

**Faithful control of your real, logged-in Chrome profiles.**

An MCP server + MV3 Chrome extension + authenticated localhost bridge that lets
AI agents drive the Chrome that already holds your logins, extensions, and
history. No copied profiles, no debug profile, no `--remote-debugging-port`,
no Edge, no global mouse/keyboard automation.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/bpc-oss/chrome-faithful/actions/workflows/ci.yml/badge.svg)](https://github.com/bpc-oss/chrome-faithful/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933)

---

## Why this exists

Most browser MCP servers take one of two shortcuts, and both lose your browser:

| Approach | What you get | What you lose |
|---|---|---|
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Google) | DevTools-oriented attach over CDP | Chrome 136+ blocks remote debugging on the **default profile**; extension support requires a separate `--user-data-dir`, so your real logins are gone |
| Playwright / Puppeteer MCP servers | A fresh headless browser | Your logins, cookies, extensions, history, and two-factor sessions — everything that makes a browser *yours* |
| Extension-based MCPs ([BrowserMCP](https://github.com/browsermcp/mcp), [real-browser-mcp](https://github.com/ofershap/real-browser-mcp)) | Control of the real browser | Closest approach, but typically single-session, requires Chrome to already be running, and ships a thinner security model |

Chrome Faithful is the version with no trade-offs:

- **Exact multi-profile routing.** Every profile registers with its exact
  `profileName`; duplicate registrations are rejected, so concurrent agents
  cannot interleave inside one profile.
- **Launches a closed profile.** If the target profile — or all of Chrome — is
  closed, it starts the *exact* profile with ordinary Chrome and waits for the
  exact extension registration before reporting success. No `--user-data-dir`
  hacks.
- **Security depth.** The bridge binds only `127.0.0.1` and requires a
  generated 256-bit secret. Bootstrap uses one-use tokens; sessions use scoped
  grants. Configuration is closed-schema and must live outside the source
  tree. Installers are transactional with SHA-256-verified, DPAPI-encrypted
  backups (Windows).
- **File upload the honest way.** Files are injected as page
  `File`/`DataTransfer` objects — not `DOM.setFileInputFiles`, not an OS file
  chooser.
- **Media export without leaking URLs.** `chrome_page_asset` streams
  page-exposed media using the tab's user agent, referer, and matching profile
  cookies; signed URLs, cookies, and headers never appear in MCP arguments or
  results.
- **Durable virtual-list capture.** Scroll capture with asset parity,
  fail-closed manifests, exclusive cross-process locks, and resume that rewinds
  the tab through serialized wheel events — built for infinite-scroll feeds.
- **Works minimized.** Locator waits/actions and screenshots use CDP focus
  emulation, so virtualized controls keep rendering even when the Chrome
  window is minimized or obscured.
- **Raw CDP when you need it.** `chrome_cdp` with redacted network projections;
  request/response bodies stay inside the plugin and token/cookie/header
  fields are rejected from results.
- **Codex-compatible JS API.** `src/agent-browser.mjs` implements Codex's
  `agent.browsers` surface (tabs, locators, CUA, Playwright-style selectors,
  clipboard, dialogs, downloads) so JavaScript agents can use the same runtime.

## Architecture

```
┌─────────────┐   stdio    ┌──────────────────────┐   ws://127.0.0.1    ┌─────────────────────────┐
│ MCP client  │ ─────────► │ src/mcp-server.mjs   │ ──────────────────► │ src/bridge-server.mjs   │
│ (Claude,    │            │ MCP tools            │  (Bearer secret)    │ authenticated localhost  │
│  Codex, …)  │            └──────────────────────┘                     │ multi-profile router    │
└─────────────┘                                                        └───────────┬─────────────┘
                                                                                    │ chrome.debugger
                                                                    ┌───────────────▼──────────────┐
                                                                    │ MV3 extension in EACH exact  │
                                                                    │ profile (offscreen doc owns  │
                                                                    │ the WebSocket)               │
                                                                    └──────────────────────────────┘
```

- `extension/` — MV3 extension loaded once per controllable profile. Uses
  `chrome.debugger`; an **offscreen document** owns the persistent WebSocket so
  MV3 service-worker suspension never drops the connection.
- `src/bridge-server.mjs` — authenticated, localhost-only, multi-profile router
  with resilient failover.
- `src/chrome-profile-launcher.mjs` — exact local Profile discovery and
  ordinary Chrome startup with bounded extension-registration confirmation.
- `src/mcp-server.mjs` — the MCP tool surface (37 tools).
- `src/agent-browser.mjs` — JavaScript `agent.browsers` compatibility adapter.
- `src/file-injection.mjs`, `src/page-asset.mjs`, `src/scroll-capture.mjs`,
  `src/scroll-asset-capture.mjs`, `src/network-request.mjs`,
  `src/network-response.mjs` — the feature modules.
- `scripts/` — Windows installers, acceptance harnesses, and codex parity tooling.

## Safety model

1. A caller must select one exact `metadata.profileName`.
2. Duplicate live registrations for one profile name are rejected.
3. The bridge binds only `127.0.0.1` and requires a generated secret.
4. There is no fallback to a generic profile, port 9222, Edge, or UI automation.
5. If the target is disconnected, callers use `chrome_profile_catalog` /
   `chrome_profile_start`; a process start succeeds only after the exact
   extension `profileName` registers.
6. A live self-test must pass tabs and `Runtime.evaluate` before browser work.
7. Profile and tab failures are returned to the calling agent with no
   user-side console inspection required.

See [SECURITY.md](SECURITY.md) for the full model and reporting policy.

## Quick start (Windows)

Prerequisites: Node.js >= 20, Chrome, PowerShell (only the installers and the
`.cmd` launcher are Windows-specific; the extension, bridge, and MCP server are
platform-neutral).

```powershell
npm ci --ignore-scripts
```

1. **Load the extension** in every Chrome profile you want agents to control:
   `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
   select `extension/`. Note the 32-character extension ID and the loaded
   absolute path.
2. **Create the bridge config** outside the source tree, at
   `%LOCALAPPDATA%\AgentOS\agentos-chrome-cdp\config.json`, using
   `config/local.example.json` as the non-secret schema reference. The secret
   must be a generated 256-bit value, e.g.:

   ```powershell
   [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
   ```

   The schema is closed: `host` (must be `127.0.0.1`), `port`, `secret`,
   `commandTimeoutMs`, `profileAliases` — plus optional bridge/launcher
   overrides. The server refuses a config that lives inside the source tree.
3. **Start the bridge**: `npm run bridge`.
4. **Register the MCP server** with your client, pointing `node` at the
   absolute path of `src/mcp-server.mjs` (or use `bin\invoke-chrome-cdp.cmd`,
   which auto-starts the bridge). The in-repo `.mcp.json` uses paths relative
   to the repo root — that form works for Codex project configs; other clients
   generally want an absolute path.
5. **Verify**: call `chrome_profiles`, then `chrome_selftest`, then open a tab
   with `chrome_tabs` / navigate with `chrome_tabs`.

For multi-profile client wiring, secret rotation, DPAPI-encrypted backups, and
transactional rollback, the PowerShell installers automate it:

```powershell
.\scripts\Install-AgentOsChromeExtension.ps1 -Target <absolute-loaded-extension-path>
.\scripts\Install-AgentOsChromeCdp.ps1 -Clients @('CodeBuddy') -ExtensionId $ExtensionId -ExtensionPath $ExtensionPath -ChromeProfileDirectories $ProfileDirs -ChromeUserDataDir $ChromeUserData
```

Run them without `-Apply` first — the default is a dry-run preview.

## MCP tools

| Group | Tools |
|---|---|
| Profiles & sessions | `chrome_profiles`, `chrome_profile_catalog`, `chrome_profile_start`, `chrome_selftest`, `chrome_session_v2` |
| Tabs & navigation | `chrome_tabs`, `chrome_session_v2` (finalize), `chrome_page_event_v2` |
| Interaction | `chrome_playwright_v2`, `chrome_locator`, `chrome_cua`, `chrome_dom_cua_v2` |
| Raw CDP & network | `chrome_cdp`, `chrome_network_asset_v1` |
| Capture & evidence | `chrome_screenshot`, `chrome_cua_scroll_capture_v1/v2/v3`, `chrome_cua_scroll_capture_status_v1`, `chrome_cua_scroll_asset_capture_start/status/cancel_v2` |
| Assets & content | `chrome_page_asset`, `chrome_page_asset_v2`, `chrome_content_v2` (pdf/md/xlsx/csv/docx/pptx) |
| Verification | `chrome_verification_detect`, `chrome_verification_status`, `chrome_verification_resume`, `chrome_verification_solve`, `chrome_verification_solve_checkbox`, `chrome_verification_solve_slider`, `chrome_verification_capture`, `chrome_verification_dismiss_overlays` |
| Utilities | `chrome_file_inject`, `chrome_history`, `chrome_clipboard` |

Notable behaviors: locator calls wait up to 30 s for visibility and are
serialized per profile+tab; `fill` uses replacement semantics; `chrome_locator`
accepts a zero-based `index` (`-1` = last) for multi-match selectors;
screenshots accept an optional document-coordinate `clip` and absolute
`savePath` and still return the PNG.

## Verification handling

Because Chrome Faithful drives your *real* profile, most bot checks never
trigger. When a platform still presents a human-verification challenge, the
verification module gives agents a structured loop instead of blind retries:

1. `chrome_verification_detect` — multi-signal detection and classification
   (reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, GeeTest, slider,
   image-select, and text signals). Optionally records a per-profile hold.
2. `chrome_verification_solve` — picks the matching strategy automatically:
   checkbox click + token wait (reCAPTCHA v2 / hCaptcha / Turnstile),
   humanized slider drag (GeeTest / slider), or capture for an external
   OCR/ASR backend (image-select / generic). Clears the hold on success,
   produces a human handoff message otherwise.
3. `chrome_verification_status` / `chrome_verification_resume` — per-profile
   hold state machine (`idle → challenge_detected → waiting_for_human →
   cleared`) with an auditable transition log.
4. `chrome_verification_capture` — saves the challenge image region and/or the
   audio URL and submits them to the configured backend for an answer.
5. `chrome_verification_dismiss_overlays` — dismisses benign cookie/onboarding
   overlays with a strict allowlist.

Interaction is humanized throughout: seeded bezier trajectories with jitter,
monotonic-x slider drags, ease-in-out timing (`src/verification/input.mjs`).
Recognition brains (audio transcription, image OCR, slider gap detection) are
**external and optional** — enable one via the `AGENTOS_VERIFICATION_BACKEND`
environment variable, e.g.
`cli:python scripts/verification/captcha-backend-adapter.py` (reference JSON
adapter for the Python faster-whisper / OCR / opencv stack) or an HTTP
endpoint. Without a backend, detection, hold/resume, handoff, overlay
dismissal, and humanized interaction all still work.

Design: [docs/superpowers/specs/2026-08-14-verification-handling-design.md](docs/superpowers/specs/2026-08-14-verification-handling-design.md)

## JavaScript integration

```js
import { startBridge, createAgent } from "./src/index.mjs";

const bridge = await startBridge();
const agent = createAgent(bridge.router);
const targets = await agent.browsers.list();
const browser = await agent.browsers.get(targets[0].id);
const tab = await browser.tabs.new();
await tab.goto("https://example.com/");
```

## Codex compatibility

`src/agent-browser.mjs` implements the Codex `agent.browsers` surface. Parity
is pinned mechanically: `compat/` holds the captured API contract, its
SHA-256, and the adapter map; `npm run check:parity` and
`test/codex-parity-contract.test.mjs` fail if any contract member is missing,
stubbed, or extra. See [compat/README.md](compat/README.md) and
[docs/CODEX_PARITY.md](docs/CODEX_PARITY.md).

## Testing

```text
npm run check          # static gates (structure, JSON validity, generic boundary)
npm test               # mock/unit tests, incl. security contract tests
npm run check:parity   # Codex agent.browsers parity contract
npm run build:extension
```

Installer transaction tests (Windows): `pwsh -NoProfile -File
test/installer-transactions.test.ps1`.

Static checks and mock tests are necessary but not sufficient. Release
acceptance additionally requires two concurrently connected real profiles,
per-profile `selftest`, background tab navigation, locator click/fill, raw CDP,
screenshot, history, clipboard round-trip with restoration, dry page-File
injection, reconnect, and proof that only acceptance-owned tabs were closed —
driven by `scripts/live-acceptance.mjs` and
`scripts/differential-acceptance.mjs`.

## Documentation

- [SECURITY.md](SECURITY.md) — safety model and vulnerability reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow
- [docs/CODEX_PARITY.md](docs/CODEX_PARITY.md) — Codex parity design
- [docs/superpowers/specs/](docs/superpowers/specs/) — design specs
  (profile launch, resilient bridge ownership)
- [skills/control-chrome-cdp/SKILL.md](skills/control-chrome-cdp/SKILL.md) —
  agent-facing operating skill
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) — bundled third-party code

## Status

Experimental. Windows-first: the installers, DPAPI backups, and `.cmd` launcher
are Windows-only; the extension, bridge, and MCP server are platform-neutral
Node.js and should run anywhere Chrome does, but only Windows is exercised
today. The bridge **controls your real logged-in profiles** — review the safety
model, use exact profiles, and never paste your bridge secret.

## License

[MIT](LICENSE). Bundled third-party code is Apache-2.0 (puppeteer-core browser
runtime) and MIT (esbuild) — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
