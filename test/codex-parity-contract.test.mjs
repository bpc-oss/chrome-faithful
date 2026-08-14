import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  summarizeContract,
  validateAdapterMap
} from "../scripts/check-codex-parity.mjs";

const contract = JSON.parse(await readFile(
  new URL("../compat/codex-26.721.41059-api.json", import.meta.url),
  "utf8"
));

function completeMap(value = "implemented") {
  return Object.fromEntries(Object.entries(contract.interfaces).map(([interfaceName, members]) => [
    interfaceName,
    Object.fromEntries(Object.keys(members).map((memberName) => [
      memberName,
      { module: `src/compat/${interfaceName}.mjs`, implementation: value }
    ]))
  ]));
}

test("freezes the complete Codex 26.721.41059 public browser contract", () => {
  assert.deepEqual(
    summarizeContract(contract),
    {
      interfaces: 22,
      interfaceMembers: 135,
      types: 58,
      members: summarizeContract(contract).members
    }
  );
});

test("accepts a complete concrete adapter map", () => {
  const result = validateAdapterMap(contract, completeMap());
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.extras, []);
});

test("rejects a missing member by exact interface and member name", () => {
  const adapterMap = completeMap();
  delete adapterMap.PlaywrightAPI.frameLocator;
  const result = validateAdapterMap(contract, adapterMap);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["PlaywrightAPI.frameLocator"]);
});

test("rejects no-op, stub, and unsupported mappings", () => {
  for (const implementation of ["noop", "no-op", "stub", "unsupported", "missing"]) {
    const adapterMap = completeMap();
    adapterMap.Tab.getJsDialog.implementation = implementation;
    const result = validateAdapterMap(contract, adapterMap);
    assert.equal(result.ok, false);
    assert.deepEqual(result.invalid, ["Tab.getJsDialog"]);
  }
});

test("rejects extra undeclared members", () => {
  const adapterMap = completeMap();
  adapterMap.Tab.notInCodex = {
    module: "src/compat/tab.mjs",
    implementation: "notInCodex"
  };
  const result = validateAdapterMap(contract, adapterMap);
  assert.equal(result.ok, false);
  assert.deepEqual(result.extras, ["Tab.notInCodex"]);
});
