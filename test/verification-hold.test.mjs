import test from "node:test";
import assert from "node:assert/strict";
import { VerificationHold, HOLD_STATUS } from "../src/verification/hold.mjs";

function makeHold() {
  let tick = 1000;
  return new VerificationHold({ now: () => (tick += 1000) });
}

test("idle status is returned for an unknown profile", () => {
  const hold = makeHold();
  const status = hold.status("Profile Alpha");
  assert.equal(status.status, HOLD_STATUS.IDLE);
  assert.equal(hold.isHeld("Profile Alpha"), false);
});

test("report moves a profile to challenge_detected and isHeld", () => {
  const hold = makeHold();
  const challenge = { type: "turnstile", provider: "turnstile", confidence: 0.95 };
  const state = hold.report("Profile Alpha", challenge);
  assert.equal(state.status, HOLD_STATUS.CHALLENGE_DETECTED);
  assert.equal(state.challenge.type, "turnstile");
  assert.equal(hold.isHeld("Profile Alpha"), true);
});

test("handoff moves to waiting_for_human and records the reason", () => {
  const hold = makeHold();
  hold.report("Profile Beta", { type: "geetest" });
  const state = hold.handoff("Profile Beta");
  assert.equal(state.status, HOLD_STATUS.WAITING_FOR_HUMAN);
  assert.equal(hold.isHeld("Profile Beta"), true);
});

test("resume clears the hold and records a transition", () => {
  const hold = makeHold();
  hold.report("Profile Alpha", { type: "slider" });
  const cleared = hold.resume("Profile Alpha", { reason: "solved" });
  assert.equal(cleared.status, HOLD_STATUS.CLEARED);
  assert.equal(hold.isHeld("Profile Alpha"), false);
  const transitions = hold.recentTransitions();
  assert.equal(transitions[0].status, HOLD_STATUS.CLEARED);
  assert.equal(transitions[0].note, "solved");
});

test("transition log is bounded and newest first", () => {
  const hold = makeHold();
  for (let i = 0; i < 60; i += 1) {
    hold.report(`Profile ${i % 3}`, { type: "generic" });
    hold.resume(`Profile ${i % 3}`);
  }
  const all = hold.recentTransitions(100);
  assert.ok(all.length <= 50);
  const timestamps = all.map((t) => t.timestamp);
  assert.deepEqual(timestamps, [...timestamps].sort().reverse());
});

test("reset removes the profile state", () => {
  const hold = makeHold();
  hold.report("Profile Alpha", { type: "hcaptcha" });
  hold.reset("Profile Alpha");
  assert.equal(hold.status("Profile Alpha").status, HOLD_STATUS.IDLE);
});
