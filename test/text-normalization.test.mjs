import assert from "node:assert/strict";
import test from "node:test";

test("normalizes generated text to LF before hashing", async () => {
  const module = await import("../scripts/text-normalization.mjs").catch(() => ({}));

  assert.equal(typeof module.normalizeLf, "function");
  assert.equal(module.normalizeLf("first\r\nsecond\rthird\n"), "first\nsecond\nthird\n");
});
