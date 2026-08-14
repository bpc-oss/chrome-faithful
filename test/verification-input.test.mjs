import test from "node:test";
import assert from "node:assert/strict";
import { bezierPath, addJitter, clampMonotonicX, dragDelays, humanizeDrag, mulberry32 } from "../src/verification/input.mjs";

test("mulberry32 is deterministic for a fixed seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.equal(a(), b());
  const first = a();
  assert.ok(first >= 0 && first < 1);
});

test("bezierPath starts at from and ends at to", () => {
  const path = bezierPath({ x: 10, y: 20 }, { x: 210, y: 80 }, { steps: 20, seed: 5 });
  assert.equal(path.length, 21);
  assert.ok(Math.abs(path[0].x - 10) < 1e-9 && Math.abs(path[0].y - 20) < 1e-9);
  assert.ok(Math.abs(path.at(-1).x - 210) < 1e-9 && Math.abs(path.at(-1).y - 80) < 1e-9);
});

test("addJitter preserves endpoints", () => {
  const path = bezierPath({ x: 0, y: 0 }, { x: 100, y: 0 }, { steps: 10, seed: 3 });
  const jittered = addJitter(path, { amount: 2, seed: 9 });
  assert.deepEqual(jittered[0], path[0]);
  assert.deepEqual(jittered.at(-1), path.at(-1));
});

test("clampMonotonicX never decreases x", () => {
  const path = [
    { x: 10, y: 5 },
    { x: 8, y: 6 },
    { x: 12, y: 7 },
    { x: 11, y: 4 },
    { x: 20, y: 5 }
  ];
  const clamped = clampMonotonicX(path);
  for (let i = 1; i < clamped.length; i += 1) {
    assert.ok(clamped[i].x >= clamped[i - 1].x, `x decreased at ${i}`);
  }
  assert.equal(clamped.at(-1).x, 20);
});

test("dragDelays returns one delay per interior transition with positive values", () => {
  const delays = dragDelays([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], { totalMs: 300, seed: 1 });
  assert.equal(delays.length, 2);
  for (const delay of delays) assert.ok(delay > 0);
});

test("humanizeDrag yields a monotonic-x path with delays", () => {
  const { points, delays } = humanizeDrag({ x: 5, y: 5 }, { x: 95, y: 5 }, { seed: 17 });
  assert.ok(points.length >= 2);
  assert.equal(delays.length, points.length - 1);
  assert.equal(points[0].x, 5);
  assert.equal(points.at(-1).x, 95);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].x >= points[i - 1].x);
  }
});

test("humanizeDrag is deterministic for a fixed seed", () => {
  const a = humanizeDrag({ x: 0, y: 0 }, { x: 50, y: 10 }, { seed: 99 });
  const b = humanizeDrag({ x: 0, y: 0 }, { x: 50, y: 10 }, { seed: 99 });
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.delays, b.delays);
});
