# Generic Chrome Profile Launch Design

## Goal

Allow an agent to start an existing local Chrome profile even when Chrome or
that profile is not currently running, then wait until the installed Agent OS
extension registers the exact profile with the bridge.

## Boundaries

- The feature is browser-generic. It contains no project, site, account, or
  publishing rules.
- It launches the original local Chrome profile. It never creates or copies a
  user-data directory and never enables remote debugging.
- The caller supplies only a profile display name, directory name, or exact
  account name and a bounded wait timeout. It cannot supply an executable,
  command-line flags, or a startup URL. When secure configuration bootstrap is
  required, the plugin itself may open only its resolved extension options URL.
- Profile resolution is exact and fail-closed. Missing and ambiguous names do
  not launch Chrome.
- Chrome starts on an internal, one-use extension bootstrap page when the
  profile is disconnected. Business navigation remains a separate, explicit
  browser action.
- A successful launch is not enough: the requested extension
  `metadata.profileName` must register before success is returned.

## Components

1. `chrome-profile-launcher.mjs`
   - Finds the ordinary Chrome executable and default user-data directory for
     the host OS, with optional trusted local-config overrides.
   - Reads Chrome `Local State` for internal exact resolution; the public MCP
     catalog returns only directory and display name.
   - Resolves a requested name against exact directory, display-name, GAIA-name,
     and user-name fields.
   - Reads only the resolved Profile's `Secure Preferences`, requires the
     extension ID and canonical unpacked path to match trusted local
     configuration, verifies the expected service worker/options manifest, and
     resolves exactly one binding. Display-name or manifest-name matching alone
     is never sufficient to receive a bridge secret.
   - Obtains an authenticated, origin-bound, one-use bootstrap token plus an
     opaque attempt ID and spawns ordinary Chrome with only
     `--profile-directory=<resolved>` and that extension's options URL.
   - Token consumption creates a second one-use registration grant. The options
     page keeps that grant in extension session storage only; the offscreen
     transport must present it with the exact profile name and extension ID.
     The launcher accepts success only from the authenticated receipt for its
     own attempt, never from a generic profile-list match.

2. MCP tools
   - `chrome_profile_catalog`: read-only local profile discovery.
   - `chrome_profile_start`: explicit local application launch plus bounded
     extension-registration wait.

3. Local configuration
   - `chromeProfileLauncher.extensionId` (or an exact per-directory override)
     and `extensionPath` identify the trusted unpacked extension allowed to
     receive bootstrap credentials. Optional `executablePath`, `userDataDir`,
     and `profileDirectoryOverrides` support non-default installations.
   - Defaults and examples remain project-neutral.

## Error Handling

- Missing Chrome, unreadable/invalid Local State, missing profile, ambiguous
  profile, untrusted or ambiguous extension identity, synchronous/asynchronous
  spawn failure, lost bootstrap ownership, rejected registration, and bounded
  registration timeout are distinct errors.
- Bootstrap attempts have explicit token-issued, grant-issued, registering,
  registered, rejected, expired, and cancelled states. Tokens and grants are
  consumed before registration work, so concurrent replay cannot win twice.
- Bridge calls, process-start acknowledgement, polling, and sleeps all share the
  caller's single deadline. Timeout performs only a best-effort attempt cancel;
  it never terminates shared Chrome.
- On timeout, the result names the resolved profile directory and expected
  extension ID but never exposes cookies, credentials, bootstrap tokens,
  bootstrap URLs, command lines, or Local State contents.
- The launcher does not terminate Chrome on timeout because Chrome may share an
  existing process with user windows.

## Verification

- Unit tests cover catalog parsing, exact/ambiguous resolution, trusted
  extension ID/path discovery, authenticated one-use token and registration
  grant, wrong-origin/profile/extension and replay failure, attempt-specific
  receipts, exact already-connected behavior, synchronous/asynchronous spawn
  failure, safe spawn arguments, and bounded registration timeout.
- Extension runtime tests execute the bootstrap code with Chrome API stubs and
  prove that fragments are cleared before fetch, grants never enter local
  storage, only the matching receipt closes the current options tab, and
  credentials never appear in status/output.
- Static checks reject remote-debugging and caller-controlled startup flags.
- Live acceptance starts a currently disconnected real profile, observes exact
  extension registration, runs self-test, and cleans only the acceptance tab
  when the caller requests cleanup.
