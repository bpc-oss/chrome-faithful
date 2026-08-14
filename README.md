# Chrome Faithful

**Faithful control of your real, logged-in Chrome profiles.**

An MCP server + MV3 Chrome extension + authenticated localhost bridge that lets
AI agents drive the Chrome that already holds your logins, extensions, and
history. No copied profiles, no debug profile, no `--remote-debugging-port`,
no Edge, no global mouse/keyboard automation.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/bpc-oss/chrome-faithful/actions/workflows/ci.yml/badge.svg)](https://github.com/bpc-oss/chrome-faithful/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933)

**English** · [简体中文](README.zh-CN.md)

---

## Why this exists

Browser-control tools optimize for different jobs:

| Approach | What you get | What you lose |
|---|---|---|
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Google) | Excellent DevTools, performance, and CDP workflows; Chrome 144+ can `autoConnect` to a running local browser with user approval | Chrome must already be running, and when several profiles are active Chrome chooses the default profile rather than accepting an exact profile name |
| Playwright / Puppeteer MCP servers | Deterministic, isolated browsers that are ideal for CI and repeatable tests | Existing logins, extensions, history, and two-factor sessions are not present unless separately provisioned |
| Extension-based MCPs ([BrowserMCP](https://github.com/browsermcp/mcp), [real-browser-mcp](https://github.com/ofershap/real-browser-mcp)) | Control of an existing logged-in browser | A strong fit for live sessions; multi-profile setups may require separate server instances and ports, and normally expect Chrome to be running |

Chrome Faithful focuses on exact-profile, multi-profile control with a
fail-closed local bridge:

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
- **Raw CDP when you need it, with an explicit trust boundary.** `chrome_cdp`
  event reads redact Network headers, query strings, and post data; the bounded
  request/response projection actions reject sensitive selected fields. Its
  `send` action is deliberately unrestricted raw CDP and must be exposed only
  to a fully trusted MCP client: it can read authenticated page content,
  cookies, storage, tokens, URLs, and headers.
- **Structured verification handling.** Multi-signal challenge detection that
  distinguishes *resolved* / *pending-render* / *active challenge* states,
  click-first solving for the common "click once and it passes" cases, and an
  honest handoff when a challenge needs a human — see
  [Verification handling](#verification-handling).
- **Codex-compatible JS API.** `src/agent-browser.mjs` implements Codex's
  `agent.browsers` surface (tabs, locators, CUA, Playwright-style selectors,
  clipboard, dialogs, downloads) so JavaScript agents can use the same runtime.

## Architecture

```
┌─────────────┐   stdio    ┌──────────────────────┐   ws://127.0.0.1    ┌─────────────────────────┐
│ MCP client  │ ─────────► │ src/mcp-server.mjs   │ ──────────────────► │ src/bridge-server.mjs   │
│ (Claude,    │            │ MCP tools (38)       │  (Bearer secret)    │ authenticated localhost  │
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
- `src/mcp-server.mjs` — the MCP tool surface (38 tools).
- `src/agent-browser.mjs` — JavaScript `agent.browsers` compatibility adapter.
- `src/verification/` — challenge detection, hold state machine, handoff,
  overlay dismissal, humanized input, and the solve pipeline (checkbox /
  slider / click-first generic / capture-for-backend).
- `src/file-injection.mjs`, `src/page-asset.mjs`, `src/scroll-capture.mjs`,
  `src/scroll-asset-capture.mjs`, `src/network-request.mjs`,
  `src/network-response.mjs` — the feature modules.
- `scripts/` — Windows installers, acceptance harnesses, live-test harness,
  and codex parity tooling.

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

`chrome_cdp` with `action=send` is outside the safe-projection boundary. It is
equivalent to granting the MCP client DevTools access to the selected logged-in
profile. Do not enable this server for untrusted clients or shared MCP hosts.

See [SECURITY.md](SECURITY.md) for the full model and reporting policy.

The extension's broad capabilities are intentional and visible: `debugger`
provides DevTools-equivalent control; `history`, `downloads`, and clipboard
permissions back their corresponding tools. Host access is limited to
`http://127.0.0.1/*` for the local bridge. For deterministic, disposable CI
browsers, use Playwright or Puppeteer instead.

## DSH first-class integration

Chrome Faithful ships a first-party DeepSeek Harness bundle in
`packages/dsh-plugin-chrome-faithful/`. It uses DSH's host-provided MCP client
instead of duplicating the browser tools, so DSH gets the same exact-profile
routing and security behavior as every other client.

Supported baseline: `@deepseek-ai/dsh` `0.1.0-rc.6` and Node.js `>=22.12.0`.
DSH remains an RC, so every newer RC requires a composition recheck.

After the core and bundle packages are published, install into the intended
profile:

```sh
dsh plugin --profile web add @bpc-oss/dsh-plugin-chrome-faithful@0.4.0
```

The model sees stable names such as
`mcp__chrome_faithful__chrome_profiles`. The bundle embeds no secret and passes
`AGENTOS_CHROME_CONFIG` only when explicitly set. Initial configuration or
resolution failures stop activation instead of leaving a silent zero-tool
plugin. See the [DSH bundle README](packages/dsh-plugin-chrome-faithful/README.md)
for packaging, trust-boundary, and private-acceptance details.

### Local vision for text-only models

`chrome_visual_extract` captures the requested exact-profile tab only when
called, runs a local backend, and returns text JSON containing screenshot
dimensions/SHA-256 plus OCR text, confidence, and normalized coordinates. It
does not return or save the PNG. This makes the result useful to DSH models
even though DSH `0.1.0-rc.6` drops MCP image content.

The default backend is the shipped PP-OCRv5 mobile adapter. Chrome Faithful
does not bundle or install Python, PaddleOCR, PaddlePaddle, OpenCV, NumPy, or
model weights. Install those optional components yourself and configure both
absolute local model directories so PaddleOCR cannot fall back to downloading
weights:

```text
CHROME_FAITHFUL_PYTHON=C:\Python311\python.exe
CHROME_FAITHFUL_PPOCR_DET_MODEL_DIR=C:\Models\PP-OCRv5_mobile_det
CHROME_FAITHFUL_PPOCR_REC_MODEL_DIR=C:\Models\PP-OCRv5_mobile_rec
```

`CHROME_FAITHFUL_OCR_BACKEND` may instead be a shell-free
`cli:["executable","arg"]` specification or an exact
`http://127.0.0.1:<port>/...` / `http://[::1]:<port>/...` endpoint.
`CHROME_FAITHFUL_VLM_BACKEND` uses the same formats and is disabled by default;
it can point to a user-operated SmolVLM2, Moondream, or compatible local
adapter. Remote URLs, redirects, automatic downloads, and cloud fallback are
rejected. Normalized OCR coordinates are hints for existing `chrome_cua`
calls, not authorization to click.

## Quick start (Windows)

Prerequisites: Node.js >= 22.12, Chrome, PowerShell (only the installers and the
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
| Capture & evidence | `chrome_screenshot`, `chrome_visual_extract`, `chrome_cua_scroll_capture_v1/v2/v3`, `chrome_cua_scroll_capture_status_v1`, `chrome_cua_scroll_asset_capture_start/status/cancel_v2` |
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
verification module gives agents a structured loop instead of blind retries.

**Detection** (`chrome_verification_detect`) classifies three real-world
states:

| State | What it means | Action |
|---|---|---|
| `resolved` | A token is already populated (e.g. invisible challenge completed) | Not a blocker — proceed |
| active provider iframe (reCAPTCHA v2/v3, hCaptcha, Turnstile, GeeTest, vaptcha) | A visible challenge widget is present | Solve it |
| `pending-render` | A widget container exists but its challenge iframe never rendered — typically a network/provider handshake stall | Reload-and-retry guidance or human handoff |

Static markers (the ubiquitous reCAPTCHA badge) are explicitly excluded, so a
page that merely *loads* reCAPTCHA is never reported as a challenge.

**Solving** (`chrome_verification_solve`) picks the strategy by type:

1. **Checkbox / token wait** — reCAPTCHA v2 / hCaptcha / Turnstile: click the
   visible challenge control (provider iframe center preferred) and poll the
   hidden response token until populated.
2. **Humanized slider drag** — GeeTest / slider: locate the handle, compute the
   target (track end or a backend gap offset), drag with a seeded bezier
   trajectory (monotonic x, jitter, ease-in-out delays), then verify
   acceptance. A gap behind the handle fails closed instead of dragging
   backwards.
3. **Click-first generic** — text-signal / unknown challenges: click the
   obvious "Verify you are human" / "验证" / "继续" button (or challenge
   checkbox) once, wait briefly for a token, and only then escalate.
4. **Capture for backend** — image-select / audio challenges: save the
   challenge image region and/or audio URL and submit them to an external
   OCR/ASR backend.

**Hold state machine** (`chrome_verification_status` /
`chrome_verification_resume`) — per-profile
`idle → challenge_detected → waiting_for_human → cleared` with an auditable,
bounded transition log. `chrome_verification_solve` clears the hold on success,
hands off on failure, and rolls the hold back if the solver itself crashes.

**Humanized input** — seeded bezier trajectories with jitter, monotonic-x
slider drags, and ease-in-out timing (`src/verification/input.mjs`),
deterministic and testable.

**Recognition backends are external and optional.** Enable one via the
`AGENTOS_VERIFICATION_BACKEND` environment variable, e.g.
`cli:python scripts/verification/captcha-backend-adapter.py` (a reference JSON
adapter for the Python faster-whisper / OCR / opencv stack; it prefers the
Agent OS captcha connector when importable and falls back to standalone
faster-whisper / ddddocr / tesseract / opencv otherwise) or an HTTP endpoint.
Without a backend, detection, hold/resume, handoff, overlay dismissal, and
humanized interaction all still work. Enabling a backend sends the configured
process or endpoint a local capture path and/or a challenge audio URL plus the
requested action; an HTTP endpoint may therefore transfer challenge data or
credentials outside this project. Configure only an endpoint you trust and
are authorized to use.

Design: [docs/superpowers/specs/2026-08-14-verification-handling-design.md](docs/superpowers/specs/2026-08-14-verification-handling-design.md)

## Live testing

`scripts/verification/live-tests/` contains reproducible harnesses that drive
real Chrome profiles through the compliant bridge channel (task tabs only;
they are closed after each run):

- `live-verification-test.mjs [url] [profileName]` — generic detect → solve →
  re-detect loop against any URL.
- `live-cf-test.mjs [profileName]` — Cloudflare Turnstile with the official
  test sitekeys (`1x00000000000000000000AA` always-pass,
  `3x00000000000000000000FF` forced interactive) plus a click-to-pass
  simulation fixture. Serve fixtures with
  `python -m http.server 18999 --directory scripts/verification/live-tests`.
- `cf-diagnostic-probe.mjs [profileName]` — dumps widget markup / iframe /
  `window.turnstile` state for the "widget rendered but challenge iframe
  missing" stall.
- `final-regression.mjs [profileName]` — badge-only pages must not be
  detected; click-to-pass must still solve.

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
is pinned mechanically: `compat/` holds a repository-authored functional
surface contract, its adapter-map SHA-256, and the adapter map. It does not
redistribute bundled product documentation. `npm run check:parity` and
`test/codex-parity-contract.test.mjs` fail if any contract member is missing,
stubbed, or extra. See [compat/README.md](compat/README.md) and
[docs/CODEX_PARITY.md](docs/CODEX_PARITY.md).

The internal identifiers `agentos-chrome-cdp`, `AGENTOS_CHROME_CONFIG`, and the
existing AgentOS configuration path are retained for upgrade compatibility;
the public display name is Chrome Faithful.

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
driven by `scripts/live-acceptance.mjs`,
`scripts/differential-acceptance.mjs`, and the live-test harness above.

## Documentation

- [SECURITY.md](SECURITY.md) — safety model and vulnerability reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow
- [docs/CODEX_PARITY.md](docs/CODEX_PARITY.md) — Codex parity design
- [packages/dsh-plugin-chrome-faithful/](packages/dsh-plugin-chrome-faithful/) — first-party DSH bundle
- [docs/superpowers/specs/](docs/superpowers/specs/) — design specs
  (profile launch, resilient bridge ownership, verification handling)
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

[MIT](LICENSE). Bundled runtime code and development-only verification tools
retain their own MIT, Apache-2.0, or ISC terms — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
