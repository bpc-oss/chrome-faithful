function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}

function requireIntegerRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
}

function evaluationValue(response, label) {
  if (response?.exceptionDetails) {
    throw new Error(`${label} failed: ${response.exceptionDetails.text || "Runtime.evaluate exception"}`);
  }
  if (!response?.result || !Object.prototype.hasOwnProperty.call(response.result, "value")) {
    throw new Error(`${label} must return a JSON-serializable value`);
  }
  return response.result.value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw new Error(reason?.message || String(reason || "asset_capture_cancelled"));
}

async function evaluate(tab, expression, label) {
  const response = await tab.transport.cdp(tab.id, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  return evaluationValue(response, label);
}

export async function runCuaScrollCapture({
  tab,
  x,
  y,
  deltaX = 0,
  deltaY,
  settleMs = 800,
  maxRounds = 100,
  initializeExpression,
  captureExpression,
  stopField = "done",
  expectedTotal,
  consecutiveNoNewAtBottom = 0,
  softBottomBounce = false,
  rewindBeforeInitialize = false,
  rewindRounds = 20,
  rewindDeltaY = 3000,
  rewindSettleMs = 100,
  onInitial,
  onCheckpoint,
  sanitizeInitial,
  sanitizeCheckpoint,
  signal
}) {
  requireFinite("x", x);
  requireFinite("y", y);
  requireFinite("deltaX", deltaX);
  requireFinite("deltaY", deltaY);
  requireIntegerRange("settleMs", settleMs, 0, 10000);
  requireIntegerRange("maxRounds", maxRounds, 1, 500);
  if (typeof captureExpression !== "string" || !captureExpression.trim()) {
    throw new Error("captureExpression is required");
  }
  if (initializeExpression != null && (typeof initializeExpression !== "string" || !initializeExpression.trim())) {
    throw new Error("initializeExpression must be a non-empty string");
  }
  if (typeof stopField !== "string" || !stopField.trim()) {
    throw new Error("stopField must be a non-empty string");
  }
  if (expectedTotal != null) requireIntegerRange("expectedTotal", expectedTotal, 1, 1000000);
  requireIntegerRange("consecutiveNoNewAtBottom", consecutiveNoNewAtBottom, 0, 100);
  if (consecutiveNoNewAtBottom > 0 && expectedTotal == null) {
    throw new Error("expectedTotal is required when consecutiveNoNewAtBottom is enabled");
  }
  if (typeof softBottomBounce !== "boolean") {
    throw new Error("softBottomBounce must be a boolean");
  }
  if (typeof rewindBeforeInitialize !== "boolean") {
    throw new Error("rewindBeforeInitialize must be a boolean");
  }
  requireIntegerRange("rewindRounds", rewindRounds, 1, 100);
  requireFinite("rewindDeltaY", rewindDeltaY);
  if (rewindDeltaY <= 0) throw new Error("rewindDeltaY must be greater than zero");
  requireIntegerRange("rewindSettleMs", rewindSettleMs, 0, 1000);

  if (rewindBeforeInitialize) {
    for (let rewindRound = 0; rewindRound < rewindRounds; rewindRound += 1) {
      throwIfAborted(signal);
      await tab.cua.scroll({ x, y, deltaX: 0, deltaY: -Math.abs(rewindDeltaY) });
      if (rewindSettleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, rewindSettleMs));
      }
    }
  }

  throwIfAborted(signal);
  let initial = initializeExpression
    ? await evaluate(tab, initializeExpression, "initializeExpression")
    : undefined;
  if (initial !== undefined && onInitial) await onInitial(initial);
  if (initial !== undefined && sanitizeInitial) initial = sanitizeInitial(initial);
  const checkpoints = [];
  let stopped = false;
  let noNewAtBottom = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    throwIfAborted(signal);
    await tab.cua.scroll({ x, y, deltaX, deltaY });
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    throwIfAborted(signal);
    let value = await evaluate(tab, captureExpression, `captureExpression round ${round}`);
    if (onCheckpoint) await onCheckpoint(value, round);
    if (sanitizeCheckpoint) value = sanitizeCheckpoint(value, round);
    if (consecutiveNoNewAtBottom > 0) {
      noNewAtBottom = value?.atBottom === true && value?.newCount === 0
        ? noNewAtBottom + 1
        : 0;
      const done = value?.total === expectedTotal && noNewAtBottom >= consecutiveNoNewAtBottom;
      value = { ...value, noNewAtBottom, done };
    }
    if (softBottomBounce && value?.atBottom === true && value?.newCount === 0
      && value?.total !== expectedTotal) {
      throwIfAborted(signal);
      await tab.cua.scroll({ x, y, deltaX: 0, deltaY: -Math.abs(deltaY) });
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      throwIfAborted(signal);
      await tab.cua.scroll({ x, y, deltaX: 0, deltaY: Math.abs(deltaY) });
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      value = { ...value, softBottomBounce: true };
    }
    checkpoints.push({ round, value });
    if (value && typeof value === "object" && value[stopField] === true) {
      stopped = true;
      break;
    }
  }

  return {
    ok: true,
    initial,
    roundsCompleted: checkpoints.length,
    stopped,
    stopField,
    expectedTotal,
    consecutiveNoNewAtBottom,
    last: checkpoints.at(-1)?.value,
    checkpoints
  };
}
