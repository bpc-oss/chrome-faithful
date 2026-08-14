import { createHash } from "node:crypto";

const SENSITIVE_FIELD = /(?:url|uri|token|cookie|header|signature|signed|cover|avatar|secret|credential|authorization)/i;

function pathParts(path) {
  if (typeof path !== "string" || !path.trim()) return [];
  return path.split(".").map((part) => part.trim()).filter(Boolean);
}

function getPath(value, path) {
  return pathParts(path).reduce((current, part) => current?.[part], value);
}

function assertSafeFields(fields, label) {
  if (!Array.isArray(fields)) throw new Error(`${label} must be an array`);
  for (const field of fields) {
    if (typeof field !== "string" || !field.trim()) throw new Error(`${label} contains an invalid field`);
    if (SENSITIVE_FIELD.test(field)) throw new Error(`${label} field is not allowed: ${field}`);
  }
}

function scalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
}

function selectFields(value, fields) {
  return Object.fromEntries(fields.flatMap((field) => {
    const selected = scalar(getPath(value, field));
    return selected === undefined ? [] : [[field, selected]];
  }));
}

function describePaths(value, paths) {
  return Object.fromEntries(paths.map((path) => {
    const selected = getPath(value, path);
    if (selected == null) return [path, { type: selected === null ? "null" : "missing" }];
    if (Array.isArray(selected)) return [path, { type: "array", length: selected.length }];
    if (typeof selected !== "object") return [path, { type: typeof selected }];
    const keys = Object.keys(selected);
    const safeKeys = keys.filter((key) => !SENSITIVE_FIELD.test(key)).slice(0, 100);
    return [path, {
      type: "object",
      keys: safeKeys,
      redactedKeyCount: keys.length - safeKeys.length
    }];
  }));
}

function parseNetworkJsonBody(response, options = {}) {
  const encoded = String(response?.body || "");
  const raw = response?.base64Encoded ? Buffer.from(encoded, "base64") : Buffer.from(encoded, "utf8");
  const maxBodyBytes = Math.min(25 * 1024 * 1024, Math.max(1, Number(options.maxBodyBytes || 10 * 1024 * 1024)));
  if (raw.length > maxBodyBytes) throw new Error(`Network response body exceeds maxBodyBytes (${raw.length} > ${maxBodyBytes})`);

  try {
    return { raw, parsed: JSON.parse(raw.toString("utf8")) };
  } catch {
    throw new Error("Network response body is not valid JSON");
  }
}

function assetRules(options) {
  if (!Array.isArray(options.allowedHostSuffixes) || !options.allowedHostSuffixes.length) {
    throw new Error("allowedHostSuffixes must be a non-empty array");
  }
  const allowedHostSuffixes = options.allowedHostSuffixes.map((value) => {
    const normalized = String(value || "").trim().replace(/^\./, "").toLocaleLowerCase();
    if (!normalized || !/^[a-z0-9.-]+$/.test(normalized)) {
      throw new Error(`Invalid allowed host suffix: ${value}`);
    }
    return normalized;
  });
  const excludeTerms = (options.excludeTerms || []).map((value) => {
    const normalized = String(value || "").trim().toLocaleLowerCase();
    if (!normalized || normalized.length > 200) {
      throw new Error("excludeTerms contains an invalid value");
    }
    return normalized;
  });
  return { allowedHostSuffixes, excludeTerms };
}

function collectAssetCandidates(value, path, candidates, seen, rules) {
  if (typeof value === "string") {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    const host = parsed.hostname.toLocaleLowerCase();
    if (!rules.allowedHostSuffixes.some((suffix) =>
      host === suffix || host.endsWith(`.${suffix}`))) return;
    const searchable = `${path} ${value}`.toLocaleLowerCase();
    if (rules.excludeTerms.some((term) => searchable.includes(term))) return;
    if (seen.has(value)) return;
    seen.add(value);
    const score =
      (/(?:cover|thumbnail|thumb|poster|image|origin)/i.test(path) ? 100 : 0) -
      (/(?:play|download|music|audio|video_url)/i.test(path) ? 50 : 0);
    candidates.push({ sourceUrl: value, score });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectAssetCandidates(entry, `${path}.${index}`, candidates, seen, rules));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    collectAssetCandidates(entry, path ? `${path}.${key}` : key, candidates, seen, rules);
  }
}

export function selectNetworkJsonAssetCandidates(response, options = {}) {
  const { raw, parsed } = parseNetworkJsonBody(response, options);
  const rules = assetRules(options);
  const items = getPath(parsed, options.itemsPath || "");
  if (!Array.isArray(items)) throw new Error(`itemsPath is not an array: ${options.itemsPath || "<root>"}`);
  if (typeof options.matchField !== "string" || !options.matchField.trim()) {
    throw new Error("matchField is required");
  }
  if (options.matchValue == null || String(options.matchValue) === "") {
    throw new Error("matchValue is required");
  }
  const item = items.find((entry) => String(getPath(entry, options.matchField)) === String(options.matchValue));
  if (!item) {
    return {
      ok: false,
      bodyBytes: raw.length,
      bodySha256: createHash("sha256").update(raw).digest("hex"),
      matched: false,
      candidateCount: 0,
      candidates: []
    };
  }
  const candidates = [];
  collectAssetCandidates(item, "", candidates, new Set(), rules);
  candidates.sort((left, right) => right.score - left.score);
  const maxCandidates = Math.min(100, Math.max(1, Number(options.maxCandidates || 20)));
  return {
    ok: candidates.length > 0,
    bodyBytes: raw.length,
    bodySha256: createHash("sha256").update(raw).digest("hex"),
    matched: true,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, maxCandidates).map(({ sourceUrl }) => sourceUrl)
  };
}

export function summarizeNetworkJsonBody(response, options = {}) {
  const { raw, parsed } = parseNetworkJsonBody(response, options);

  const itemFields = options.itemFields || [];
  const rootFields = options.rootFields || [];
  const shapePaths = options.shapePaths || [];
  assertSafeFields(itemFields, "itemFields");
  assertSafeFields(rootFields, "rootFields");
  assertSafeFields(shapePaths, "shapePaths");
  const itemsValue = getPath(parsed, options.itemsPath || "");
  if (!Array.isArray(itemsValue)) {
    return {
      ok: false,
      bodyBytes: raw.length,
      bodySha256: createHash("sha256").update(raw).digest("hex"),
      jsonKeys: Object.keys(parsed || {}).slice(0, 100),
      shapes: describePaths(parsed, shapePaths),
      error: `itemsPath is not an array: ${options.itemsPath || "<root>"}`
    };
  }
  const maxItems = Math.min(2000, Math.max(1, Number(options.maxItems || 1000)));
  if (itemsValue.length > maxItems) throw new Error(`Network response contains too many items (${itemsValue.length} > ${maxItems})`);
  return {
    ok: true,
    bodyBytes: raw.length,
    bodySha256: createHash("sha256").update(raw).digest("hex"),
    jsonKeys: Object.keys(parsed || {}).slice(0, 100),
    shapes: describePaths(parsed, shapePaths),
    root: selectFields(parsed, rootFields),
    count: itemsValue.length,
    items: itemsValue.map((item) => selectFields(item, itemFields))
  };
}

export function groupNetworkJsonSummaries(entries) {
  const groups = new Map();
  const errors = [];
  for (const entry of entries) {
    if (entry.error) {
      errors.push({ requestId: entry.requestId, error: entry.error });
      continue;
    }
    const summary = entry.summary;
    const itemSetSha256 = createHash("sha256")
      .update(JSON.stringify({
        ok: summary.ok,
        root: summary.root,
        count: summary.count,
        items: summary.items,
        error: summary.error,
        jsonKeys: summary.jsonKeys,
        shapes: summary.shapes
      }))
      .digest("hex");
    const group = groups.get(itemSetSha256) || {
      itemSetSha256,
      requestIds: [],
      bodySha256s: [],
      ...summary
    };
    group.requestIds.push(entry.requestId);
    if (summary.bodySha256 && !group.bodySha256s.includes(summary.bodySha256)) {
      group.bodySha256s.push(summary.bodySha256);
    }
    groups.set(itemSetSha256, group);
  }
  return {
    ok: errors.length === 0,
    requestCount: entries.length,
    uniqueResponseCount: groups.size,
    groups: [...groups.values()],
    errors
  };
}

export function compactNetworkJsonGroups(result) {
  return {
    ok: result.ok,
    requestCount: result.requestCount,
    uniqueResponseCount: result.uniqueResponseCount,
    groups: result.groups.map(({ requestIds, bodySha256s, bodySha256, ...group }) => ({
      ...group,
      representativeRequestId: requestIds.at(-1),
      duplicateRequestCount: requestIds.length,
      representativeBodySha256: bodySha256s.at(-1) || bodySha256,
      bodyVariantCount: bodySha256s.length
    })),
    errorCount: result.errors.length,
    errors: result.errors.slice(0, 20)
  };
}
