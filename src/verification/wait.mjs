// Bounded, verification-aware polling helpers.

export class PollTimeoutError extends Error {
  constructor(message, lastValue) {
    super(message);
    this.name = "PollTimeoutError";
    this.lastValue = lastValue;
  }
}

/**
 * Poll `fn` until `predicate(value)` is true or `timeoutMs` elapses.
 * Returns the value that satisfied the predicate. Throws PollTimeoutError
 * with the last observed value on timeout. `intervalMs` is the base poll
 * interval; `backoff` multiplies it on consecutive failures (cap 5s).
 */
export async function pollUntil({ fn, predicate, timeoutMs = 30000, intervalMs = 500, backoff = 1.3, label = "condition" }) {
  const deadline = Date.now() + Math.min(300000, Math.max(1000, Number(timeoutMs) || 30000));
  let interval = Math.min(5000, Math.max(20, Number(intervalMs) || 500));
  let lastValue;
  for (;;) {
    let value;
    try {
      value = await fn();
      lastValue = value;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new PollTimeoutError(`${label} timed out after ${timeoutMs}ms (last error: ${error.message})`, lastValue);
      }
      await sleep(interval);
      interval = Math.min(5000, interval * backoff);
      continue;
    }
    if (predicate(value)) return value;
    if (Date.now() >= deadline) {
      throw new PollTimeoutError(`${label} timed out after ${timeoutMs}ms`, value);
    }
    await sleep(interval);
    interval = Math.min(5000, interval * backoff);
  }
}

/**
 * Poll a detection function until the challenge is gone (cleared) or the
 * window elapses. `check` must return { detected: boolean, ... }.
 */
export async function waitForChallengeCleared(check, { timeoutMs = 60000, intervalMs = 750, label = "challenge" } = {}) {
  const result = await pollUntil({
    fn: check,
    predicate: (value) => value?.detected === false,
    timeoutMs,
    intervalMs,
    label: `${label} clear`
  });
  return result;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
