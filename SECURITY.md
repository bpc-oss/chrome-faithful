# Security

## Reporting a vulnerability

Please report vulnerabilities through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-vulnerabilities/privately-reporting-a-security-vulnerability)
for this repository. Do **not** open a public issue for a security problem.

When reporting, include:

- the affected version and platform,
- a minimal reproduction,
- whether the issue requires a local attacker or only affects a misconfigured
  setup.

## What this project controls

This project deliberately operates inside your real, logged-in Chrome profiles.
That is its purpose, so the security model exists to make that power *safe by
construction*, not to pretend the power is absent. The invariants below are
machine-checked where possible and are enforced by design:

1. **Exact profile selection.** A caller must select one exact
   `metadata.profileName`. There is no fallback to a generic profile.
2. **No duplicate live registrations.** Two extensions claiming the same
   profile name are rejected; routing is unambiguous.
3. **Localhost-only, authenticated bridge.** The bridge binds only
   `127.0.0.1` and every connection requires a generated 256-bit secret.
   Bootstrap uses one-use tokens; long-lived sessions use scoped grants.
4. **No debug profile, no port 9222, no Edge, no UI automation.** Chrome is
   launched as an ordinary process with the exact profile; the extension uses
   `chrome.debugger` inside that profile. Global mouse/keyboard automation is
   never used.
5. **Closed-schema configuration.** The bridge config (host, port, secret,
   timeouts, aliases) is validated against a closed schema and must live
   *outside* the source tree (`%LOCALAPPDATA%\AgentOS\agentos-chrome-cdp\` by
   default). A config inside the plugin tree is rejected.
6. **Evidence discipline.** Screenshots, page assets, and scroll-capture
   manifests are written through bounded temp files, validated, and atomically
   moved into place. The dedicated page-asset and Network projection APIs do
   not return signed URLs, cookies, tokens, or headers. Buffered Network event
   reads always remove headers, query strings, and post data.
7. **Transactional installers.** Client/extension installers back up prior
   state (DPAPI-encrypted, current-user + SYSTEM DACL on Windows), verify
   SHA-256 before every write, and roll back only targets proven to have been
   committed by that transaction.

## Fully trusted raw CDP boundary

`chrome_cdp` with `action=send` deliberately exposes unrestricted CDP for
advanced diagnostics and automation. A trusted caller can use it to read page
content, cookies, browser storage, tokens, URLs, request headers, and other
authenticated state available to `chrome.debugger`. This is not a redacted
interface. Treat every configured MCP client and host process as fully trusted,
and do not expose the bridge or MCP server to other users or machines.

Use `readEvents`, `readResponseJson*`, and `readRequestData` when a bounded,
redacted Network projection is sufficient.

## Extension permissions and optional backends

The `debugger` permission is the core control capability and should be treated
as equivalent to granting DevTools access to the selected profile. `history`,
`downloads`, `clipboardRead`, and `clipboardWrite` support their named tools.
The extension's only host permission is `http://127.0.0.1/*`, used for its
authenticated local bridge; it does not request a general web-origin host
permission.

Verification recognition backends are disabled unless
`AGENTOS_VERIFICATION_BACKEND` is set. When enabled, the configured process or
HTTP endpoint receives an action plus a local capture path and/or challenge
audio URL. An operator-selected HTTP service is outside this project's local
trust boundary and may receive challenge data or credentials. Use only a
backend you trust and are authorized to use.

## Scope notes

- Windows installers, DPAPI backups, and the `.cmd` launcher are
  Windows-specific; the extension, bridge, and MCP server are platform-neutral
  Node.js.
- The bundled `puppeteer-core` browser runtime is used only for in-page
  evaluation and `ExtensionTransport`; no browser is downloaded or launched by
  the library (see `THIRD_PARTY_NOTICES.md`).
