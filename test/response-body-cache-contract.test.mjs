import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");

test("captures completed JSON XHR bodies before inspector eviction", () => {
  assert.match(source, /Network\.loadingFinished/);
  assert.match(source, /captureJsonResponseBody\(source, params\.requestId\)/);
  assert.match(source, /Network\.getResponseBody/);
  assert.match(source, /\["XHR", "Fetch"\]\.includes\(params\.type\)/);
  assert.match(source, /mimeType\.includes\("json"\)/);
});

test("serves cached response bodies transparently and bounds memory", () => {
  assert.match(source, /responseBodies\.get\(tabId\)\?\.get\(params\.requestId\)/);
  assert.match(source, /RESPONSE_BODY_MAX_ENTRIES = 512/);
  assert.match(source, /RESPONSE_BODY_MAX_TOTAL_BYTES = 40 \* 1024 \* 1024/);
  assert.match(source, /RESPONSE_BODY_MAX_ITEM_BYTES = 5 \* 1024 \* 1024/);
  assert.match(source, /responseBodies\.delete\(source\.tabId\)/);
});
