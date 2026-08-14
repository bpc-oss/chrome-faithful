// Human-like input primitives: deterministic seeded trajectories so behavior is
// reproducible in tests and auditable in production. All randomness is derived
// from an injectable seed (mulberry32 PRNG); no global state.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointOnCubic(t, from, c1, c2, to) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * from.x + b * c1.x + c * c2.x + d * to.x,
    y: a * from.y + b * c1.y + c * c2.y + d * to.y
  };
}

/**
 * Build a gentle S-curved cubic bezier path between two points.
 * `bend` scales the perpendicular control-point offset (0 = straight line).
 */
export function bezierPath(from, to, { steps = 24, bend = 0.25, seed = 1 } = {}) {
  const rand = mulberry32(seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const amount = bend * len;
  const wobble = () => (rand() - 0.5) * 0.6;
  const c1 = {
    x: from.x + dx * 0.33 + nx * amount * wobble(),
    y: from.y + dy * 0.33 + ny * amount * wobble()
  };
  const c2 = {
    x: from.x + dx * 0.66 + nx * amount * wobble(),
    y: from.y + dy * 0.66 + ny * amount * wobble()
  };
  const boundedSteps = Math.min(200, Math.max(2, Math.floor(Number(steps) || 24)));
  const points = [];
  for (let i = 0; i <= boundedSteps; i++) {
    points.push(pointOnCubic(i / boundedSteps, from, c1, c2, to));
  }
  return points;
}

/**
 * Add small positional noise to interior points. Endpoints are preserved so a
 * drag still starts and ends exactly on the target coordinates.
 */
export function addJitter(points, { amount = 1.2, seed = 7 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return points;
  const rand = mulberry32(seed);
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    return {
      x: point.x + (rand() - 0.5) * amount,
      y: point.y + (rand() - 0.5) * amount
    };
  });
}

/**
 * Clamp a path so x is monotonically non-decreasing. Slider challenges reject
 * horizontal backtracking; this guarantees the drag never moves the handle
 * leftwards while still allowing vertical wiggle.
 */
export function clampMonotonicX(points) {
  if (!Array.isArray(points) || points.length === 0) return points;
  let maxX = -Infinity;
  return points.map((point) => {
    const x = Math.max(maxX, point.x);
    maxX = x;
    return { x, y: point.y };
  });
}

/**
 * Per-point delays with an ease-in-out velocity profile: slow start, fast
 * middle, slow stop — a plausible human drag. The first point has no delay.
 * `totalMs` is split across the interior transitions.
 */
export function dragDelays(points, { totalMs = 450, seed = 3 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const rand = mulberry32(seed);
  const bounded = Math.min(5000, Math.max(10, Number(totalMs) || 450));
  const interior = points.length - 1;
  const base = bounded / interior;
  const delays = [];
  for (let i = 0; i < interior; i++) {
    const t = i / Math.max(1, interior - 1);
    const ease = 0.25 + 1.5 * Math.sin(Math.PI * t) * Math.sin(Math.PI * t);
    delays.push(Math.max(1, base * ease * (0.8 + rand() * 0.4)));
  }
  return delays;
}

/**
 * Full pipeline for a plausible human drag: bezier path, jitter, monotonic X,
 * and per-point delays. Returns { points, delays }.
 */
export function humanizeDrag(from, to, { steps = 28, bend = 0.3, jitter = 1.4, totalMs = 480, seed = 11 } = {}) {
  const path = clampMonotonicX(addJitter(bezierPath(from, to, { steps, bend, seed }), { amount: jitter, seed: seed + 1 }));
  return { points: path, delays: dragDelays(path, { totalMs, seed: seed + 2 }) };
}
