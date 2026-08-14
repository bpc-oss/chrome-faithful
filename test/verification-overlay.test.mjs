import test from "node:test";
import assert from "node:assert/strict";
import { dismissBenignOverlays, BENIGN_DISMISS_TEXT } from "../src/verification/overlay.mjs";

test("benign allowlist contains common cookie and onboarding texts", () => {
  for (const text of ["accept", "accept all", "got it", "skip", "知道了", "开始使用"]) {
    assert.ok(BENIGN_DISMISS_TEXT.includes(text), `missing ${text}`);
  }
});

test("dismisses candidates up to maxDismissals and reports remaining", async () => {
  const candidates = [
    { x: 10, y: 10, text: "accept all" },
    { x: 20, y: 20, text: "got it" },
    { x: 30, y: 30, text: "skip" },
    { x: 40, y: 40, text: "close" }
  ];
  const clicks = [];
  const result = await dismissBenignOverlays({
    evaluate: async () => candidates,
    click: async ({ x, y }) => { clicks.push({ x, y }); },
    maxDismissals: 2
  });
  assert.equal(result.dismissed.length, 2);
  assert.equal(result.remaining, 2);
  assert.deepEqual(clicks, [
    { x: 10, y: 10 },
    { x: 20, y: 20 }
  ]);
});

test("click failures are recorded without aborting the loop", async () => {
  const candidates = [
    { x: 10, y: 10, text: "accept" },
    { x: 20, y: 20, text: "ok" }
  ];
  const result = await dismissBenignOverlays({
    evaluate: async () => candidates,
    click: async ({ x }) => {
      if (x === 10) throw new Error("boom");
    },
    maxDismissals: 3
  });
  assert.equal(result.dismissed[0].dismissed, false);
  assert.equal(result.dismissed[0].error, "boom");
  assert.equal(result.dismissed[1].dismissed, true);
});

test("empty candidates produce no dismissals", async () => {
  const result = await dismissBenignOverlays({
    evaluate: async () => [],
    click: async () => {},
    maxDismissals: 3
  });
  assert.equal(result.dismissed.length, 0);
  assert.equal(result.remaining, 0);
});
