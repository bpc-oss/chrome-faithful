import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function summarizeContract(contract) {
  const interfaces = Object.keys(contract?.interfaces || {});
  const members = interfaces.flatMap((interfaceName) =>
    Object.keys(contract.interfaces[interfaceName] || {}).map((memberName) => ({
      interfaceName,
      memberName
    }))
  );
  return {
    interfaces: interfaces.length,
    interfaceMembers: members.length,
    types: Object.keys(contract?.types || {}).length,
    members
  };
}

export function validateAdapterMap(contract, adapterMap) {
  const summary = summarizeContract(contract);
  const missing = [];
  const invalid = [];
  for (const { interfaceName, memberName } of summary.members) {
    const entry = adapterMap?.[interfaceName]?.[memberName];
    if (!entry) {
      missing.push(`${interfaceName}.${memberName}`);
      continue;
    }
    if (
      typeof entry.module !== "string" ||
      !entry.module.trim() ||
      typeof entry.implementation !== "string" ||
      !entry.implementation.trim() ||
      /^(?:missing|noop|no-op|stub|unsupported)$/i.test(entry.implementation.trim())
    ) {
      invalid.push(`${interfaceName}.${memberName}`);
    }
  }
  const extras = [];
  for (const [interfaceName, members] of Object.entries(adapterMap || {})) {
    for (const memberName of Object.keys(members || {})) {
      if (!contract?.interfaces?.[interfaceName]?.[memberName]) {
        extras.push(`${interfaceName}.${memberName}`);
      }
    }
  }
  return {
    ok: missing.length === 0 && invalid.length === 0 && extras.length === 0,
    ...summary,
    missing,
    invalid,
    extras
  };
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function checkParity({
  contractPath = path.join(root, "compat", "codex-26.721.41059-api.json"),
  manifestPath = path.join(root, "compat", "codex-26.721.41059-manifest.json"),
  adapterMapPath = path.join(root, "compat", "codex-adapter-map.json")
} = {}) {
  const [rawContract, manifest, adapterMap] = await Promise.all([
    readFile(contractPath),
    loadJson(manifestPath),
    loadJson(adapterMapPath)
  ]);
  const contract = JSON.parse(rawContract.toString("utf8"));
  const contractSha256 = createHash("sha256").update(rawContract).digest("hex");
  const summary = summarizeContract(contract);
  const manifestMatches =
    contractSha256 === manifest.sha256 &&
    summary.interfaces === manifest.interfaces &&
    summary.interfaceMembers === manifest.interfaceMembers &&
    summary.types === manifest.types;
  const mapping = validateAdapterMap(contract, adapterMap);
  return {
    ok: manifestMatches && mapping.ok,
    baselineVersion: manifest.version,
    contractSha256,
    manifestMatches,
    expected: {
      contractSha256: manifest.sha256,
      interfaces: manifest.interfaces,
      interfaceMembers: manifest.interfaceMembers,
      types: manifest.types
    },
    actual: {
      interfaces: summary.interfaces,
      interfaceMembers: summary.interfaceMembers,
      types: summary.types
    },
    mapping
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkParity();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
