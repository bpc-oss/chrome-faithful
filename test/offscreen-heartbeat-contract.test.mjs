import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");

test("offscreen transport detects half-open bridge sockets and reconnects", () => {
  assert.match(source, /SERVER_MESSAGE_TIMEOUT_MS = 40_000/);
  assert.match(source, /lastServerMessageAt = Date\.now\(\)/);
  assert.match(source, /Date\.now\(\) - lastServerMessageAt > SERVER_MESSAGE_TIMEOUT_MS/);
  assert.match(source, /socket\.close\(\)/);
  assert.match(source, /reconnect\(0\)/);
});
