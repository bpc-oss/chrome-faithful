export class EventRegistry {
  constructor({ maxEntries = 1000 } = {}) {
    this.maxEntries = maxEntries;
    this.sequence = 0;
    this.events = [];
    this.waiters = new Set();
    this.resources = new Map();
    this.closedError = null;
  }

  emit(name, payload = {}, resource = undefined) {
    if (this.closedError) return null;
    const sequence = ++this.sequence;
    const resourceId = resource == null ? undefined : `${name}:${sequence}`;
    if (resourceId) this.resources.set(resourceId, resource);
    const event = {
      sequence,
      name,
      timestamp: new Date().toISOString(),
      payload,
      ...(resourceId ? { resourceId } : {})
    };
    this.events.push(event);
    if (this.events.length > this.maxEntries) {
      const removed = this.events.splice(0, this.events.length - this.maxEntries);
      for (const entry of removed) {
        if (entry.resourceId) this.resources.delete(entry.resourceId);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.name !== name || event.sequence <= waiter.afterSequence) continue;
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
    return event;
  }

  read({ afterSequence = 0, names, limit = 100 } = {}) {
    const allowed = Array.isArray(names) && names.length ? new Set(names) : null;
    const boundedLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
    const matching = this.events.filter((event) =>
      event.sequence > Number(afterSequence || 0) &&
      (!allowed || allowed.has(event.name))
    );
    const events = matching.slice(0, boundedLimit);
    return {
      cursor: events.at(-1)?.sequence || this.sequence,
      events,
      hasMore: matching.length > events.length,
      truncated:
        this.events.length > 0 &&
        Number(afterSequence || 0) > 0 &&
        Number(afterSequence) < this.events[0].sequence - 1
    };
  }

  wait(name, { afterSequence = 0, timeoutMs = 30000 } = {}) {
    if (this.closedError) return Promise.reject(this.closedError);
    const existing = this.events.find((event) =>
      event.name === name && event.sequence > Number(afterSequence || 0)
    );
    if (existing) return Promise.resolve(existing);
    const boundedTimeout = Math.min(120000, Math.max(1, Number(timeoutMs) || 30000));
    return new Promise((resolve, reject) => {
      const waiter = {
        name,
        afterSequence: Number(afterSequence || 0),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for tab event ${name} after ${boundedTimeout}ms`));
        }, boundedTimeout)
      };
      this.waiters.add(waiter);
    });
  }

  getResource(resourceId) {
    return this.resources.get(resourceId);
  }

  releaseResource(resourceId) {
    return this.resources.delete(resourceId);
  }

  close(error = new Error("Tab session closed")) {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    this.resources.clear();
  }
}
