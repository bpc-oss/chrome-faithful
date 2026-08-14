export const NETWORK_ENABLE_PARAMS = Object.freeze({
  maxTotalBufferSize: 20 * 1024 * 1024,
  maxResourceBufferSize: 2 * 1024 * 1024,
  maxPostDataSize: 64 * 1024
});

function safeUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function compactNetworkParams(method, params = {}) {
  if (method === "Network.responseReceived") {
    const response = params.response || {};
    return {
      requestId: params.requestId,
      loaderId: params.loaderId,
      timestamp: params.timestamp,
      type: params.type,
      response: {
        url: safeUrl(response.url),
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType,
        protocol: response.protocol,
        fromDiskCache: response.fromDiskCache,
        fromServiceWorker: response.fromServiceWorker,
        encodedDataLength: response.encodedDataLength
      }
    };
  }
  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    return {
      requestId: params.requestId,
      loaderId: params.loaderId,
      documentURL: safeUrl(params.documentURL),
      timestamp: params.timestamp,
      type: params.type,
      frameId: params.frameId,
      request: {
        url: safeUrl(request.url),
        method: request.method,
        hasPostData: request.hasPostData
      }
    };
  }
  if (method === "Network.loadingFinished") {
    return {
      requestId: params.requestId,
      timestamp: params.timestamp,
      encodedDataLength: params.encodedDataLength
    };
  }
  if (method === "Network.loadingFailed") {
    return {
      requestId: params.requestId,
      timestamp: params.timestamp,
      type: params.type,
      errorText: params.errorText,
      canceled: params.canceled,
      blockedReason: params.blockedReason
    };
  }
  return {
    requestId: params.requestId,
    loaderId: params.loaderId,
    timestamp: params.timestamp,
    type: params.type
  };
}

export function publicCdpEvent(event, options = {}) {
  if (!event.method?.startsWith("Network.")) return event;
  return {
    sequence: event.sequence,
    method: event.method,
    params: compactNetworkParams(event.method, event.params),
    source: event.source
  };
}

export function selectCdpEvents(buffered, currentSequence, options = {}) {
  const afterSequence = Number(options.afterSequence || 0);
  const limit = Math.min(1000, Math.max(1, Number(options.limit || 100)));
  const truncated = buffered.length > 0 && afterSequence > 0 && afterSequence < buffered[0].sequence - 1;
  let events = buffered.filter((event) => event.sequence > afterSequence);
  if (options.methods?.length) events = events.filter((event) => options.methods.includes(event.method));
  if (options.methodPrefixes?.length) {
    events = events.filter((event) => options.methodPrefixes.some((prefix) => event.method.startsWith(prefix)));
  }
  if (options.urlIncludes?.length) {
    events = events.filter((event) => {
      const url = event.params?.response?.url || event.params?.request?.url || event.params?.documentURL || "";
      return options.urlIncludes.some((part) => url.includes(part));
    });
  }
  if (options.target?.sessionId) events = events.filter((event) => event.source?.sessionId === options.target.sessionId);
  if (options.target?.targetId) {
    events = events.filter((event) =>
      event.params?.targetInfo?.targetId === options.target.targetId || event.params?.targetId === options.target.targetId);
  }
  const page = events.slice(0, limit).map((event) => publicCdpEvent(event, options));
  return {
    cursor: page.at(-1)?.sequence || currentSequence || 0,
    events: page,
    hasMore: events.length > page.length,
    truncated
  };
}
