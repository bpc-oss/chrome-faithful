import { createHash } from "node:crypto";

const SAFE_REQUEST_FIELDS = new Set([
  "cursor", "count", "status", "type", "scene", "item_type", "content_type",
  "page", "page_size", "size", "offset", "limit", "sort", "order", "filter",
  "source", "is_limited", "enable_query"
]);

function assertSafeFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw new Error("fields must be a non-empty array");
  for (const field of fields) {
    if (typeof field !== "string" || !SAFE_REQUEST_FIELDS.has(field.toLowerCase())) {
      throw new Error(`request field is not allowed: ${field}`);
    }
  }
}

function scalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value)
    ? value
    : undefined;
}

export function summarizeNetworkRequestPostData(response, options = {}) {
  const postData = String(response?.postData || "");
  const raw = Buffer.from(postData, "utf8");
  const maxPostDataBytes = Math.min(1024 * 1024, Math.max(1, Number(options.maxPostDataBytes || 64 * 1024)));
  if (raw.length > maxPostDataBytes) {
    throw new Error(`Network request post data exceeds maxPostDataBytes (${raw.length} > ${maxPostDataBytes})`);
  }
  assertSafeFields(options.fields);

  let format;
  let parsed;
  try {
    parsed = JSON.parse(postData);
    format = "json";
  } catch {
    parsed = Object.fromEntries(new URLSearchParams(postData));
    format = "form";
  }
  const fields = Object.fromEntries(options.fields.flatMap((field) => {
    const value = scalar(parsed?.[field]);
    return value === undefined ? [] : [[field, value]];
  }));
  return {
    ok: true,
    postDataBytes: raw.length,
    postDataSha256: createHash("sha256").update(raw).digest("hex"),
    format,
    fields
  };
}
