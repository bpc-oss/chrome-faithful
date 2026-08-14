# Chrome Faithful for DeepSeek Harness

First-party DeepSeek Harness (DSH) bundle for Chrome Faithful. It mounts the
existing Chrome Faithful MCP server through DSH's official MCP client, retaining
all exact-profile routing, authentication, redaction, and browser-control
behavior without duplicating the 37 tools as native Cordis implementations.

## Compatibility

- DSH: `@deepseek-ai/dsh` `0.1.0-rc.6` or the same reviewed RC contract
- Node.js: `>=22.12.0`
- Chrome Faithful core: exactly the same version as this bundle

DSH is currently an RC. Revalidate this bundle when moving to a newer DSH RC;
the host owns `@deepseek-ai/dsh-mcp-client`, so this package deliberately does
not install another copy.

## Install

After both packages are publicly available, add the bundle to the target DSH
profile:

```sh
dsh plugin --profile web add @bpc-oss/dsh-plugin-chrome-faithful@0.4.0
```

Chrome Faithful core must be published first because the bundle pins the exact
core version. For private acceptance, pack both packages and install both local
tarballs into a disposable DSH profile; do not publish or mutate a live profile
merely to validate source changes.

## Configure

Create the private Chrome Faithful configuration outside the source tree as
described in the root project README. The existing compatibility path is:

```text
%LOCALAPPDATA%\AgentOS\agentos-chrome-cdp\config.json
```

Set `AGENTOS_CHROME_CONFIG` only when using a different absolute path. The
bundle passes that variable explicitly when present and embeds no secret.

On activation, DSH exposes namespaced tools such as:

```text
mcp__chrome_faithful__chrome_profiles
mcp__chrome_faithful__chrome_selftest
mcp__chrome_faithful__chrome_cdp
```

Initial MCP startup is fail-loud. Missing configuration, unresolved packages,
or duplicate MCP namespaces do not silently produce an active bundle with no
tools.

## Security boundary

This integration controls real, logged-in Chrome profiles. Tool results are
visible to the model and host configured in DSH. `chrome_cdp` with
`action=send` is unrestricted raw CDP and can read authenticated page content,
cookies, browser storage, tokens, URLs, and headers. Install this bundle only
in a fully trusted DSH profile and do not expose it to untrusted models, users,
plugins, or remote hosts.

The extension-to-bridge connection stays on authenticated localhost. Review
the project's [security model](https://github.com/bpc-oss/chrome-faithful/blob/main/SECURITY.md)
before enabling the integration.

## Verification status

Repository tests cover bundle composition, conditional environment evaluation,
package isolation, absolute launcher resolution, and startup failure behavior.
They are not proof of live DSH or live Chrome acceptance. A public release still
requires a separately authorized disposable-profile acceptance run.
