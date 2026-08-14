import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function summarizeAdapterMap(adapterMap) {
  const interfaceNames = Object.keys(adapterMap || {});
  const members = interfaceNames.flatMap((interfaceName) =>
    Object.keys(adapterMap[interfaceName] || {}).map((memberName) => ({
      interfaceName,
      memberName
    }))
  );
  return {
    interfaces: interfaceNames.length,
    interfaceMembers: members.length,
    interfaceNames,
    members
  };
}

export function validateAdapterMap(surface, adapterMap) {
  const summary = summarizeAdapterMap(adapterMap);
  const invalid = [];
  for (const { interfaceName, memberName } of summary.members) {
    const entry = adapterMap[interfaceName][memberName];
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
  const expectedInterfaces = [...(surface?.interfaceNames || [])];
  const actualInterfaces = [...summary.interfaceNames];
  const surfaceMatches =
    JSON.stringify(actualInterfaces) === JSON.stringify(expectedInterfaces) &&
    summary.interfaceMembers === surface?.interfaceMembers;
  return {
    ok: surfaceMatches && invalid.length === 0,
    ...summary,
    expectedInterfaces,
    expectedInterfaceMembers: surface?.interfaceMembers,
    invalid
  };
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function checkParity({
  surfacePath = path.join(root, "compat", "browser-surface-contract.json"),
  manifestPath = path.join(root, "compat", "codex-26.721.41059-manifest.json"),
  adapterMapPath = path.join(root, "compat", "codex-adapter-map.json")
} = {}) {
  const [surface, manifest, rawAdapterMap] = await Promise.all([
    loadJson(surfacePath),
    loadJson(manifestPath),
    readFile(adapterMapPath)
  ]);
  const adapterMap = JSON.parse(rawAdapterMap.toString("utf8"));
  const adapterMapSha256 = createHash("sha256").update(rawAdapterMap).digest("hex");
  const mapping = validateAdapterMap(surface, adapterMap);
  const manifestMatches =
    adapterMapSha256 === manifest.sha256 &&
    surface.baselineVersion === manifest.version &&
    mapping.interfaces === manifest.interfaces &&
    mapping.interfaceMembers === manifest.interfaceMembers;
  return {
    ok: manifestMatches && mapping.ok,
    baselineVersion: manifest.version,
    adapterMapSha256,
    manifestMatches,
    expected: {
      adapterMapSha256: manifest.sha256,
      interfaces: manifest.interfaces,
      interfaceMembers: manifest.interfaceMembers
    },
    actual: {
      interfaces: mapping.interfaces,
      interfaceMembers: mapping.interfaceMembers
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
