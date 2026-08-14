import assert from "node:assert/strict";
import test from "node:test";

test("public event options cannot enable sensitive CDP output", async () => {
  const module = await import("../src/cdp-policy.mjs").catch(() => ({}));

  assert.equal(typeof module.publicCdpEventOptions, "function");
  assert.deepEqual(
    module.publicCdpEventOptions({ afterSequence: 4, includeSensitive: true }),
    { afterSequence: 4, includeSensitive: false }
  );
});
