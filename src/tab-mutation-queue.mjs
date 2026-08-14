export class TabMutationQueue {
  constructor() {
    this.queues = new Map();
  }

  run(profileName, tabId, task) {
    const key = `${profileName}:${tabId}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    const queued = run.then(() => {}, () => {}).finally(() => {
      if (this.queues.get(key) === queued) this.queues.delete(key);
    });
    this.queues.set(key, queued);
    return run;
  }
}
