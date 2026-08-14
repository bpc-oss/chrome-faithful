import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORK_ENABLE_PARAMS,
  publicCdpEvent,
  selectCdpEvents
} from "../extension/cdp-events.js";

test("Network capture uses positive response-body buffers", () => {
  assert(NETWORK_ENABLE_PARAMS.maxTotalBufferSize > 0);
  assert(NETWORK_ENABLE_PARAMS.maxResourceBufferSize > 0);
  assert(NETWORK_ENABLE_PARAMS.maxPostDataSize > 0);
});

test("Network event output keeps requestId but redacts headers, query strings, and post data", () => {
  const event = {
    sequence: 4,
    method: "Network.responseReceived",
    source: { tabId: 7 },
    params: {
      requestId: "request-1",
      response: {
        url: "https://example.test/list?token=secret#fragment",
        status: 200,
        mimeType: "application/json",
        headers: { Cookie: "secret" }
      }
    }
  };
  const safe = publicCdpEvent(event);
  assert.equal(safe.params.requestId, "request-1");
  assert.equal(safe.params.response.url, "https://example.test/list");
  assert.equal("headers" in safe.params.response, false);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
  assert.deepEqual(publicCdpEvent(event, { includeSensitive: true }), event);
});

test("event pagination supports Network method-prefix and URL filters", () => {
  const buffered = [
    {
      sequence: 1,
      method: "Runtime.consoleAPICalled",
      params: {},
      source: { tabId: 7 }
    },
    {
      sequence: 2,
      method: "Network.responseReceived",
      params: {
        requestId: "a",
        response: { url: "https://example.test/content/list?token=secret", status: 200 }
      },
      source: { tabId: 7 }
    },
    {
      sequence: 3,
      method: "Network.responseReceived",
      params: {
        requestId: "b",
        response: { url: "https://example.test/metrics", status: 204 }
      },
      source: { tabId: 7 }
    }
  ];
  const result = selectCdpEvents(buffered, 3, {
    afterSequence: 0,
    methodPrefixes: ["Network."],
    urlIncludes: ["/content/"],
    limit: 10
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].params.requestId, "a");
  assert.equal(result.events[0].params.response.url, "https://example.test/content/list");
  assert.equal(result.cursor, 2);
});
