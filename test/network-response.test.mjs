import test from "node:test";
import assert from "node:assert/strict";

import {
  compactNetworkJsonGroups,
  groupNetworkJsonSummaries,
  selectNetworkJsonAssetCandidates,
  summarizeNetworkJsonBody
} from "../src/network-response.mjs";

test("summarizes selected response JSON fields without returning signed URLs", () => {
  const body = JSON.stringify({
    cursor: "next-1",
    has_more: true,
    data: {
      item_list: [
        { item_id: "123", status: 102, cover_url: ["https://example.test/a?token=secret"] },
        { item_id: "456", status: 103, cover_url: ["https://example.test/b?token=secret"] }
      ]
    }
  });
  const result = summarizeNetworkJsonBody({ body, base64Encoded: false }, {
    itemsPath: "data.item_list",
    itemFields: ["item_id", "status"],
    rootFields: ["cursor", "has_more"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.root, { cursor: "next-1", has_more: true });
  assert.deepEqual(result.items, [
    { item_id: "123", status: 102 },
    { item_id: "456", status: 103 }
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("example.test"), false);
});

test("rejects sensitive requested fields and oversized bodies", () => {
  const response = { body: JSON.stringify({ items: [{ item_id: "123", cover_url: "secret" }] }) };
  assert.throws(() => summarizeNetworkJsonBody(response, {
    itemsPath: "items",
    itemFields: ["cover_url"]
  }), /not allowed/);
  assert.throws(() => summarizeNetworkJsonBody(response, {
    itemsPath: "items",
    itemFields: ["item_id"],
    maxBodyBytes: 1
  }), /exceeds maxBodyBytes/);
});

test("selects private response assets by exact item id without returning them in summaries", () => {
  const response = {
    body: JSON.stringify({
      item_list: [{
        item_id: "7206854625335446790",
        author: { avatar_url: "https://p16-tiktokcdn.test/avt-user.jpeg" },
        video: {
          play_url: "https://v16-tiktokcdn.test/video.mp4",
          cover: {
            url_list: [
              "https://p16-tiktokcdn.test/cover-a.jpeg?token=secret",
              "https://p19-byteimg.test/cover-b.webp?token=secret"
            ]
          }
        }
      }]
    })
  };
  const result = selectNetworkJsonAssetCandidates(response, {
    itemsPath: "item_list",
    matchField: "item_id",
    matchValue: "7206854625335446790",
    allowedHostSuffixes: ["p16-tiktokcdn.test", "v16-tiktokcdn.test", "p19-byteimg.test"],
    excludeTerms: ["avatar", "avt-"]
  });
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.candidateCount, 3);
  assert.match(result.candidates[0], /cover-/);
  assert.equal(result.candidates.some((candidate) => candidate.includes("avt-user")), false);
});

test("reports an absent response item without exposing any asset candidate", () => {
  const result = selectNetworkJsonAssetCandidates({
    body: JSON.stringify({
      item_list: [{ item_id: "other", cover: "https://p16-tiktokcdn.test/secret.jpeg" }]
    })
  }, {
    itemsPath: "item_list",
    matchField: "item_id",
    matchValue: "missing",
    allowedHostSuffixes: ["p16-tiktokcdn.test"]
  });
  assert.equal(result.ok, false);
  assert.equal(result.matched, false);
  assert.deepEqual(result.candidates, []);
});

test("returns safe shape diagnostics when itemsPath is wrong", () => {
  const result = summarizeNetworkJsonBody({
    body: JSON.stringify({ cursor: "next", data: { items: [] }, signed_url: "secret" })
  }, {
    itemsPath: "data.item_list",
    itemFields: ["item_id"]
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.jsonKeys, ["cursor", "data", "signed_url"]);
  assert.equal("body" in result, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("describes nested response shapes without returning sensitive keys or values", () => {
  const result = summarizeNetworkJsonBody({
    body: JSON.stringify({
      extra: {
        total: 273,
        has_more: false,
        signed_url: "https://example.test/a?token=secret",
        credential_blob: "secret"
      },
      item_list: []
    })
  }, {
    itemsPath: "item_list",
    itemFields: ["item_id"],
    shapePaths: ["extra"]
  });
  assert.deepEqual(result.shapes, {
    extra: {
      type: "object",
      keys: ["total", "has_more"],
      redactedKeyCount: 2
    }
  });
  assert.equal(JSON.stringify(result).includes("example.test"), false);
  assert.equal(JSON.stringify(result).includes("credential_blob"), false);
});

test("rejects sensitive nested shape paths", () => {
  const response = { body: JSON.stringify({ item_list: [], signed_url: { total: 1 } }) };
  assert.throws(() => summarizeNetworkJsonBody(response, {
    itemsPath: "item_list",
    shapePaths: ["signed_url"]
  }), /not allowed/);
});

test("groups polling duplicates without losing unique response pages", () => {
  const pageA = summarizeNetworkJsonBody({
    body: JSON.stringify({ cursor: 50, item_list: [{ item_id: "a", status: 102 }] })
  }, {
    itemsPath: "item_list",
    itemFields: ["item_id", "status"],
    rootFields: ["cursor"]
  });
  const pageAWithVolatileBody = { ...pageA, bodySha256: "different-body-hash" };
  const pageB = summarizeNetworkJsonBody({
    body: JSON.stringify({ cursor: 70, item_list: [{ item_id: "b", status: 102 }] })
  }, {
    itemsPath: "item_list",
    itemFields: ["item_id", "status"],
    rootFields: ["cursor"]
  });
  const result = groupNetworkJsonSummaries([
    { requestId: "1", summary: pageA },
    { requestId: "2", summary: pageAWithVolatileBody },
    { requestId: "3", summary: pageB }
  ]);
  assert.equal(result.requestCount, 3);
  assert.equal(result.uniqueResponseCount, 2);
  assert.deepEqual(result.groups[0].requestIds, ["1", "2"]);
  assert.deepEqual(result.groups[1].requestIds, ["3"]);
});

test("compacts duplicate request and body hashes for event-reader output", () => {
  const compact = compactNetworkJsonGroups({
    ok: true,
    requestCount: 3,
    uniqueResponseCount: 1,
    groups: [{
      itemSetSha256: "set-hash",
      requestIds: ["1", "2", "3"],
      bodySha256s: ["body-a", "body-b"],
      bodySha256: "body-a",
      root: { cursor: 50 },
      count: 1,
      items: [{ item_id: "a" }]
    }],
    errors: []
  });
  assert.equal(compact.groups[0].representativeRequestId, "3");
  assert.equal(compact.groups[0].duplicateRequestCount, 3);
  assert.equal(compact.groups[0].representativeBodySha256, "body-b");
  assert.equal(compact.groups[0].bodyVariantCount, 2);
  assert.equal("requestIds" in compact.groups[0], false);
  assert.equal("bodySha256s" in compact.groups[0], false);
});
