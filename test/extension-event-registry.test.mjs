import test from "node:test";
import assert from "node:assert/strict";

import { EventRegistry } from "../src/extension-runtime/event-registry.mjs";

test("records bounded events with monotonic cursors", () => {
  const registry = new EventRegistry({ maxEntries: 2 });
  registry.emit("console", { text: "one" });
  registry.emit("dialog", { type: "alert" });
  registry.emit("console", { text: "three" });
  const page = registry.read({ afterSequence: 0, limit: 10 });
  assert.deepEqual(page.events.map((event) => event.sequence), [2, 3]);
  assert.equal(page.cursor, 3);
});

test("wait resolves only for a newer matching event", async () => {
  const registry = new EventRegistry();
  registry.emit("dialog", { message: "old" });
  const pending = registry.wait("dialog", { afterSequence: 1, timeoutMs: 1000 });
  registry.emit("console", { text: "skip" });
  registry.emit("dialog", { message: "new" });
  assert.equal((await pending).payload.message, "new");
});

test("keeps event resources private and releases evicted resources", () => {
  const registry = new EventRegistry({ maxEntries: 1 });
  const dialog = { accept() {} };
  const first = registry.emit("dialog", { type: "confirm" }, dialog);
  assert.equal(registry.getResource(first.resourceId), dialog);
  registry.emit("console", { text: "evicts dialog" });
  assert.equal(registry.getResource(first.resourceId), undefined);
});

test("close rejects active and future waits", async () => {
  const registry = new EventRegistry();
  const pending = registry.wait("filechooser", { timeoutMs: 1000 });
  registry.close(new Error("detached"));
  await assert.rejects(pending, /detached/);
  await assert.rejects(
    registry.wait("filechooser", { timeoutMs: 1000 }),
    /detached/
  );
});
