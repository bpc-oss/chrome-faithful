import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  summarizeAdapterMap,
  validateAdapterMap
} from "../scripts/check-codex-parity.mjs";

const surface = JSON.parse(await readFile(
  new URL("../compat/browser-surface-contract.json", import.meta.url),
  "utf8"
));
const adapterMap = JSON.parse(await readFile(
  new URL("../compat/codex-adapter-map.json", import.meta.url),
  "utf8"
));

function clonedMap() {
  return structuredClone(adapterMap);
}

test("freezes the repository-authored browser compatibility surface", () => {
  const summary = summarizeAdapterMap(adapterMap);
  assert.equal(summary.interfaces, 22);
  assert.equal(summary.interfaceMembers, 135);
  assert.deepEqual(summary.interfaceNames, surface.interfaceNames);
});

test("accepts a complete concrete adapter map", () => {
  const result = validateAdapterMap(surface, clonedMap());
  assert.equal(result.ok, true);
  assert.deepEqual(result.invalid, []);
});

test("rejects a missing member through the pinned surface count", () => {
  const candidate = clonedMap();
  delete candidate.PlaywrightAPI.frameLocator;
  const result = validateAdapterMap(surface, candidate);
  assert.equal(result.ok, false);
  assert.equal(result.interfaceMembers, surface.interfaceMembers - 1);
});

test("rejects no-op, stub, and unsupported mappings", () => {
  for (const implementation of ["noop", "no-op", "stub", "unsupported", "missing"]) {
    const candidate = clonedMap();
    candidate.Tab.getJsDialog.implementation = implementation;
    const result = validateAdapterMap(surface, candidate);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ["Tab.getJsDialog"]);
  }
});

test("rejects extra undeclared members through the pinned surface count", () => {
  const candidate = clonedMap();
  candidate.Tab.notInSurface = {
    module: "src/agent-browser.mjs",
    implementation: "ChromeTab.notInSurface"
  };
  const result = validateAdapterMap(surface, candidate);
  assert.equal(result.ok, false);
  assert.equal(result.interfaceMembers, surface.interfaceMembers + 1);
});
