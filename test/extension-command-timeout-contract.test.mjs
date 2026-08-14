import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");

test("Chrome API calls are locally bounded before the bridge timeout", () => {
  assert.match(source, /const CHROME_API_TIMEOUT_MS = 25_000;/);
  assert.match(source, /Chrome API timed out:/);
});

test("a tab is marked attached only after required CDP domains initialize", () => {
  const runtimeIndex = source.indexOf('"Runtime.enable"');
  const pageIndex = source.indexOf('"Page.enable"');
  const networkIndex = source.indexOf('"Network.enable"');
  const attachedIndex = source.indexOf("attached.add(tabId)", runtimeIndex);
  assert.ok(runtimeIndex >= 0);
  assert.ok(pageIndex > runtimeIndex);
  assert.ok(networkIndex > pageIndex);
  assert.ok(attachedIndex > networkIndex);
});

test("timed-out CDP commands clear stale attachment state", () => {
  assert.match(
    source,
    /if \(\/Chrome API timed out\/i\.test\(error\?\.message \|\| ""\)\) \{\s+attached\.delete\(tabId\);/
  );
  assert.match(source, /chrome\.debugger\.detach/);
});
