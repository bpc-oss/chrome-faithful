# DSH First-Party Bundle Design

**Status:** Approved after independent review

**Date:** 2026-08-14

## Goal

Ship Chrome Faithful as a first-class DeepSeek Harness (DSH) integration
without forking the browser runtime or making DSH the only supported client.
The first release is an installable DSH bundle that mounts the existing MCP
server through DSH's official MCP client.

## Product boundary

Chrome Faithful remains the reusable browser-control core: the MV3 extension,
authenticated localhost bridge, exact-profile router, MCP server, and
JavaScript compatibility adapter stay provider-neutral. DSH becomes a
first-class distribution and installation surface rather than a replacement
implementation.

The first release does not add a DSH Web settings panel and does not register
37 duplicate native Cordis tools. Those would bind the project to unstable RC
interfaces and create two tool implementations with different security or
behavioral semantics.

## Package layout

Create an independently publishable package in
`packages/dsh-plugin-chrome-faithful/` named
`@bpc-oss/dsh-plugin-chrome-faithful`.

The package contains:

- `package.json`: DSH bundle manifest, exact package contents, public metadata,
  and dependencies.
- `cordis.patch.yml`: mounts one instance of DSH's official MCP client.
- `bin/chrome-faithful-mcp.mjs`: a stable stdio launcher, exported as
  `./mcp-server`, that resolves and
  imports the installed `chrome-faithful` MCP entry point.
- `README.md`: DSH-specific installation, configuration, security, and
  troubleshooting guidance.

The package depends on the exact matching `chrome-faithful` release, initially
`0.4.0`. It declares no dependency or peer dependency on
`@deepseek-ai/dsh-mcp-client`: that plugin is a DSH host capability, and DSH
profiles are installed with peer auto-install disabled. The supported host
floor is `@deepseek-ai/dsh` `0.1.0-rc.6`, whose published package includes
`@deepseek-ai/dsh-mcp-client` `^0.1.0-rc.6`. Each DSH RC upgrade requires this
composition contract to be revalidated before the documented host range is
changed.

The bundle declares the same Node.js floor as the core package:
`>=22.12.0`. Composition uses DSH's `process.execPath`, so the host runtime
must satisfy the core dependency's floor.

## Bundle composition

`cordis.patch.yml` inserts one plugin row with these stable values:

- row id: `chrome-faithful-mcp`
- `name`: `@deepseek-ai/dsh-mcp-client`
- `serverName`: `chrome_faithful`
- transport: `stdio`
- command: `!!js process.execPath`
- args: one absolute launcher path resolved from the profile `baseUrl` with
  `process.getBuiltinModule('node:module').createRequire(baseUrl).resolve(
  '@bpc-oss/dsh-plugin-chrome-faithful/mcp-server')`
- `toolCallTimeoutMs`: `60000`
- `failOnStartupError: true`
- environment: one expression that returns `{}` when
  `AGENTOS_CHROME_CONFIG` is absent and otherwise returns
  `{ AGENTOS_CHROME_CONFIG: process.env.AGENTOS_CHROME_CONFIG }`

DSH therefore exposes tools as
`mcp__chrome_faithful__chrome_<operation>`. The namespace is fixed so session
history and permission rules do not change between installs. The existing
`AGENTOS_CHROME_CONFIG` name and AgentOS configuration path remain compatibility
identifiers; no secret is stored in the bundle.

The bundle must not add a second bridge, open a remote-debugging port, copy a
Chrome profile, or weaken exact-profile selection.

## Launcher behavior

The launcher is a minimal ESM executable. It imports the exported Chrome
Faithful MCP entry point and lets that process own stdio for its complete
lifetime. It must not spawn through a shell, discover arbitrary executables,
rewrite environment variables, or catch and hide startup errors. A human-facing
`chrome-faithful-mcp` bin alias may be included, but bundle composition must not
depend on `node_modules/.bin` being present on `PATH`.

The root `chrome-faithful` package will export a stable
`./mcp-server` subpath. The launcher imports only that public subpath; it does
not depend on the root package's filesystem layout.

If the bundle launcher or core package cannot be resolved, DSH profile startup
fails loudly. If configuration is missing or invalid, the existing MCP server
fails closed with its current actionable error. `failOnStartupError: true`
prevents DSH from silently activating the bundle with no tools during the
initial connection. After a successful initial connection, DSH's MCP client
owns reconnect and duplicate-namespace handling.

## Versioning and publication

The DSH bundle version must equal the root Chrome Faithful version. Its
`chrome-faithful` dependency is that exact version, without a caret or tilde.
A root release-contract test enforces both equalities so a paired bundle cannot
silently load a newer core.

The root npm package remains `chrome-faithful`; the DSH package is separately
packable from its subdirectory. Both packages use explicit `files` allowlists.
Neither artifact includes tests, private configuration, live evidence,
generated scratch data, or internal implementation plans.

The repository stays private and no package is published as part of this
implementation. Making the repository public, pushing a branch, publishing to
npm, or installing into a live DSH profile remains a separate external action.
For a later release, publish the core first and the bundle second. During
private development, acceptance installs both locally packed tarballs together
and performs no registry lookup for the unpublished core version.

## Documentation and positioning

The English and Chinese root READMEs add DSH as a first-class quick-start path
while retaining generic MCP, Codex, and Claude instructions. Documentation
must distinguish:

- the DSH bundle, which provides installation and composition;
- DSH's official MCP client, which namespaces and invokes the tools;
- Chrome Faithful, which owns browser control and security behavior.

The DSH package README must disclose the fully trusted raw-CDP boundary, the
external configuration path, and the fact that DSH's configured model can see
tool results from the logged-in browser.

## Testing

Tests use Node's built-in test runner and do not require DSH or Chrome to be
installed. They must prove:

1. The bundle package has the required `dsh.bundle.patch` declaration and an
   explicit publication allowlist.
2. The bundle row mounts the official MCP client with the fixed namespace,
   stdio transport, `process.execPath`, absolute resolved launcher argument,
   timeout, `failOnStartupError: true`, and conditional configuration pass-through.
3. The launcher imports the public `chrome-faithful/mcp-server` subpath and
   contains no shell-spawn or fallback logic.
4. The root package exports `./mcp-server` to the existing server file.
5. Root and bundle versions match, and the bundle dependency equals that exact
   core version.
6. `npm pack --dry-run` for both package roots excludes tests, reports, scratch,
   private configuration, and `docs/superpowers`.
7. Existing static, parity, unit, deterministic-extension, package, and Windows
   installer gates remain green.
8. A two-tarball isolation test packs the core and bundle, installs them into a
   temporary profile-like package root with its `.bin` directory excluded from
   `PATH`, resolves the bundle's `./mcp-server` export through
   `createRequire(baseUrl)`, and starts it with an intentionally missing config.
   The expected actionable config error proves that launcher resolution reached
   the installed core. The path assertion runs on POSIX and uses Windows-safe
   path construction; the Windows CI job executes the same test.
9. The conditional `env` expression is first parsed and evaluated through DSH's
   YAML expression path and then passed through the published MCP-client schema,
   with the environment variable both absent and present. String or regex
   inspection alone is insufficient.
10. An isolated startup-failure fixture proves `failOnStartupError: true`
    rejects activation instead of leaving an active bundle with zero tools.
11. The bundle and core declare the same `>=22.12.0` Node.js floor.

Live DSH installation is not required for the source change because it would
modify an external user-owned profile. Before a public release, a separately
authorized acceptance run should install the packed bundle into a disposable
DSH profile, run `--dump-default-config`, verify the fail-on-startup path, list
namespaced tools, call `chrome_profiles`, and remove the profile or package
afterward.

## Acceptance criteria

- `@bpc-oss/dsh-plugin-chrome-faithful` is independently packable and contains
  only its declared release files.
- Its DSH bundle deterministically mounts the existing Chrome Faithful MCP
  server through the official MCP client.
- No browser-control code is duplicated.
- Existing consumers and internal compatibility identifiers continue to work.
- Automated tests enforce composition, version, security, and package-content
  contracts.
- The root bilingual documentation presents DSH as a first-class integration.
- Independent review finds no unresolved critical or high-severity issue.
