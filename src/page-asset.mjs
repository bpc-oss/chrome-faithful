import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function cdpValue(response) {
  return response?.result?.value ?? response?.result?.result?.value;
}

function cdpCookies(response) {
  return response?.cookies ?? response?.result?.cookies ?? response?.result?.result?.cookies ?? [];
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function savePageAsset({
  router,
  profileName,
  tabId,
  sourceUrl,
  sourceSelector,
  sourceIndex = 0,
  sourceProperty = "currentSrc",
  savePath,
  expectedMimePrefix,
  overwrite = false,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 120_000,
  privateSource = false,
  fetchImpl = fetch
}) {
  if (!profileName) throw new Error("profileName is required");
  if (tabId == null) throw new Error("tabId is required");
  if (!isAbsolute(savePath || "")) throw new Error("savePath must be an absolute local path");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("timeoutMs must be an integer from 1 to 3600000");
  }
  if (!!sourceUrl === !!sourceSelector) {
    throw new Error("Provide exactly one of sourceUrl or sourceSelector");
  }
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
    throw new Error("sourceIndex must be a non-negative safe integer");
  }
  if (!["currentSrc", "src", "href", "poster", "content"].includes(sourceProperty)) {
    throw new Error("sourceProperty must be currentSrc, src, href, poster, or content");
  }
  if (!overwrite && await pathExists(savePath)) {
    throw new Error("savePath already exists; set overwrite=true only after verifying the target");
  }

  const sourceExpression = sourceSelector
    ? `(() => {
        const elements = document.querySelectorAll(${JSON.stringify(sourceSelector)});
        const element = elements[${sourceIndex}];
        return {
          userAgent: navigator.userAgent,
          referer: location.href,
          sourceUrl: element ? String(element[${JSON.stringify(sourceProperty)}] || "") : ""
        };
      })()`
    : "({ userAgent: navigator.userAgent, referer: location.href })";
  const contextResponse = await router.request(profileName, "cdp.send", {
    tabId,
    cdpMethod: "Runtime.evaluate",
    cdpParams: {
      expression: sourceExpression,
      returnByValue: true
    }
  });
  const context = cdpValue(contextResponse);
  if (!context?.userAgent || !context?.referer) {
    throw new Error("Could not read the exact tab user agent and referer");
  }
  const resolvedSourceUrl = sourceSelector ? context.sourceUrl : sourceUrl;
  if (sourceSelector && !resolvedSourceUrl) {
    throw new Error(`No page asset found at sourceSelector index ${sourceIndex}`);
  }

  let parsedSource;
  try {
    parsedSource = new URL(resolvedSourceUrl);
  } catch {
    throw new Error("Resolved page asset must be a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(parsedSource.protocol)) {
    throw new Error("Resolved page asset must use HTTP or HTTPS");
  }

  const cookieResponse = await router.request(profileName, "cdp.send", {
    tabId,
    cdpMethod: "Network.getCookies",
    cdpParams: { urls: [resolvedSourceUrl] }
  });
  const cookies = cdpCookies(cookieResponse);
  const headers = {
    "User-Agent": context.userAgent,
    "Referer": context.referer,
    "Accept": "*/*"
  };
  if (cookies.length) {
    headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(resolvedSourceUrl, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) throw new Error(`Page asset timed out after ${timeoutMs}ms`);
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Page asset request failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Page asset response had no body");

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (expectedMimePrefix && !contentType.startsWith(expectedMimePrefix.toLowerCase())) {
    throw new Error(`Unexpected page asset content type: ${contentType || "missing"}`);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`Page asset exceeds maxBytes (${maxBytes})`);
  }

  await mkdir(dirname(savePath), { recursive: true });
  const temporaryPath = `${savePath}.part-${process.pid}-${randomUUID()}`;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error(`Page asset exceeds maxBytes (${maxBytes})`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(temporaryPath, { flags: "wx" }),
      { signal: controller.signal }
    );
    if (!overwrite && await pathExists(savePath)) {
      throw new Error("savePath was created during download; refusing to overwrite it");
    }
    if (overwrite) await rm(savePath, { force: true });
    await rename(temporaryPath, savePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (controller.signal.aborted) throw new Error(`Page asset timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return {
    ok: true,
    savedPath: savePath,
    bytes,
    sha256: hash.digest("hex"),
    contentType,
    sourceHost: parsedSource.host,
    finalHost: safeHost(response.url) || parsedSource.host,
    profileName,
    tabId: String(tabId),
    profileContext: true,
    sourceResolvedInsidePlugin: privateSource || !!sourceSelector,
    cookieCountUsed: cookies.length,
    refererHost: safeHost(context.referer)
  };
}
