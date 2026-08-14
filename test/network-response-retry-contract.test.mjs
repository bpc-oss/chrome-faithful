import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/mcp-server.mjs", import.meta.url), "utf8");

test("Network JSON actions retry the responseReceived/loadingFinished race", () => {
  assert.match(source, /NETWORK_BODY_RETRY_ERRORS/);
  assert.match(source, /No data found/);
  assert.match(source, /attempt < 21/);
  assert.match(source, /setTimeout\(resolve, 100\)/);
  assert.match(source, /readNetworkResponseBody\(/);
});
