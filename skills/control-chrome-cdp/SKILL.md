---
name: control-chrome-cdp
description: Start or control one exact existing Chrome profile through the Agent OS Chrome CDP bridge with Codex-compatible browser operations. Use for tasks that depend on logged-in Chrome state, including when no Chrome window is open, background tab control, raw CDP, screenshots, page-exposed media saving, or page File injection. Do not use Edge, port 9222, a copied/debug profile, OS file choosers, or global UI automation.
---

# Control Chrome CDP

1. Call `chrome_profiles`.
2. Match exactly one target by `metadata.profileName`; never choose a generic
   default when multiple profiles are connected.
3. If the exact target is not connected, call `chrome_profile_catalog`, resolve
   one exact existing profile by display name or profile-directory name, then
   call `chrome_profile_start`. This is the normal path when the requested
   profile—or all of Chrome—is closed. Do not ask the user to open Chrome first.
   Missing or ambiguous names are hard stops. After start returns, call
   `chrome_profiles` again and require the expected `metadata.profileName`.
4. Before creating a tab, call `chrome_session_v2` with `action=name`, give the
   task a descriptive name, and record the current tab IDs as the baseline.
   Tabs created through `chrome_tabs action=new` belong to this MCP session;
   baseline tabs do not.
5. List tabs, select an exact tab id in that profile, and call
   `chrome_selftest` before any page-changing tab action.
6. Reuse one task-created tab where the workflow requires continuous browser
   state.
7. Prefer locator operations. Use `chrome_cdp` only for operations the locator
   surface cannot express.
   When a selector matches multiple elements, pass `index` to
   `chrome_locator` (`0` for the first match, `1` for the second, `-1` for the
   last).
   Mutating locator actions automatically wait for visibility and are serialized
   within the same profile and tab. Still issue user-visible actions in logical
   order and read back each result before continuing.
   `fill` replaces existing input, textarea, or contenteditable content. Always
   read the value or text back before the next externally visible action.
   Locator waits/actions and screenshots enable CDP focus emulation, allowing
   virtualized page controls to render while Chrome remains in the background.
   For durable evidence, pass an absolute `.png` `savePath` to
   `chrome_screenshot`; it creates parent directories and returns the saved path
   and byte count together with the image.
8. For local file upload, use the JavaScript adapter's
   `injectFilesViaPageFile`; it creates page `File` objects through
   `DataTransfer`. Do not use a chooser or `DOM.setFileInputFiles`.
9. To save media already exposed by the current page, call
   `chrome_page_asset_v2` with the same `profileName` and `tabId`, a precise
   `sourceSelector`, `sourceIndex`, `sourceProperty` (`currentSrc`, `src`, or
   `href`), an absolute `savePath`, and the expected `video/` or `image/` MIME
   prefix. This selector-only entry point keeps signed URLs out of tool
   arguments, results, and conversation logs. `chrome_page_asset` remains for
   backward compatibility.
   Verify the returned byte count and SHA-256.
10. Surface bridge, profile, tab, and CDP errors directly. Do not ask the user to
   inspect the extension console for errors already available to the agent.
11. A successful bridge connection or Chrome process start is not readiness.
   Readiness requires exact profile re-registration plus the
   self-test's tab query and `Runtime.evaluate` result.
12. Finish every browser task with `chrome_session_v2 action=finalize` for each
    profile used. It closes only tabs created by this MCP session and preserves
    baseline/user tabs. If a task-created tab must intentionally remain open,
    mark it `handoff` or `deliverable` first; cleanup is caller-selected, not a
    plugin-wide policy. Report baseline, created, closed, and remaining tab IDs.
