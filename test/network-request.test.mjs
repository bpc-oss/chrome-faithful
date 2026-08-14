import test from "node:test";
import assert from "node:assert/strict";

import { summarizeNetworkRequestPostData } from "../src/network-request.mjs";

test("projects only allowlisted JSON request fields", () => {
  const result = summarizeNetworkRequestPostData({
    postData: JSON.stringify({
      cursor: 50,
      count: 10,
      status: 102,
      msToken: "secret",
      signature: "secret"
    })
  }, {
    fields: ["cursor", "count", "status"]
  });
  assert.deepEqual(result.fields, { cursor: 50, count: 10, status: 102 });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal("postData" in result, false);
});

test("projects form data and rejects non-allowlisted fields", () => {
  const result = summarizeNetworkRequestPostData({
    postData: "cursor=70&count=10&type=photo&token=secret"
  }, {
    fields: ["cursor", "count", "type"]
  });
  assert.deepEqual(result.fields, { cursor: "70", count: "10", type: "photo" });
  assert.throws(() => summarizeNetworkRequestPostData({
    postData: "token=secret"
  }, {
    fields: ["token"]
  }), /not allowed/);
});
