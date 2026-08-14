import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { savePageAsset } from "./page-asset.mjs";
import { runCuaScrollCapture } from "./scroll-capture.mjs";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function safeKey(value) {
  const key = String(value || "");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(key) || key === "." || key === "..") {
    throw new Error("Each captured asset key must contain only letters, numbers, dot, underscore, or dash");
  }
  return key;
}

function detectImageContentType(bytes) {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  const webp = bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (png) return "image/png";
  if (jpeg) return "image/jpeg";
  if (gif) return "image/gif";
  if (webp) return "image/webp";
  return "";
}

function assertImageSignature(bytes, contentType) {
  const type = String(contentType || "").toLowerCase();
  const detected = detectImageContentType(bytes);
  const valid = !type || type === detected || (type === "image/jpg" && detected === "image/jpeg");
  if (!valid) throw new Error(`Downloaded asset did not match an image signature (${type || "unknown MIME"})`);
  return true;
}

function normalizeRenderedClip(value) {
  if (!value || typeof value !== "object") return null;
  const clip = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height)
  };
  if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)
    || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0
    || clip.width > 16_384 || clip.height > 16_384
    || clip.width * clip.height > 100_000_000) {
    return null;
  }
  return clip;
}

async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.part-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rm(path, { force: true });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function lockOwnerIsAlive(lockPath) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(owner?.pid) || owner.pid < 1) return true;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  } catch {
    return true;
  }
}

async function acquireExclusiveLock(lockPath, label, metadata) {
  const token = randomUUID();
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({
          token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          ...metadata
        }, null, 2)}\n`);
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8"));
          if (current?.token === token) await rm(lockPath, { force: true });
        } catch {
          // Preserve an unreadable or replaced lock instead of deleting another job's ownership.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 0 && !(await lockOwnerIsAlive(lockPath))) {
        await rm(lockPath, { force: true });
        continue;
      }
      throw new Error(`An asset capture already owns ${label}`);
    }
  }
  throw new Error(`Unable to acquire asset capture lock: ${label}`);
}

export async function runScrollAssetCapture({
  router,
  tab,
  profileName,
  tabId,
  assetDirectory,
  manifestPath,
  assetField = "assets",
  maxAssetBytes = 20 * 1024 * 1024,
  assetTimeoutMs = 30_000,
  downloadConcurrency = 4,
  overwrite = false,
  resumeExisting = false,
  stopOnAssetFailure = false,
  requireTotalAssetParity = false,
  fallbackToRenderedClip = false,
  diagnostics = {},
  onProgress,
  savePageAssetImpl = savePageAsset,
  ...scrollOptions
}) {
  if (!isAbsolute(assetDirectory || "")) throw new Error("assetDirectory must be an absolute local path");
  if (!isAbsolute(manifestPath || "")) throw new Error("manifestPath must be an absolute local path");
  if (!Number.isInteger(downloadConcurrency) || downloadConcurrency < 1 || downloadConcurrency > 16) {
    throw new Error("downloadConcurrency must be an integer from 1 to 16");
  }
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1) {
    throw new Error("maxAssetBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(assetTimeoutMs) || assetTimeoutMs < 1 || assetTimeoutMs > 600_000) {
    throw new Error("assetTimeoutMs must be an integer from 1 to 600000");
  }
  const releaseManifestLock = await acquireExclusiveLock(`${manifestPath}.lock`, `manifestPath: ${manifestPath}`, {
    profileName,
    tabId: String(tabId)
  });
  let releaseTabLock;
  try {
    const targetHash = createHash("sha256")
      .update(`${profileName}\0${String(tabId)}`)
      .digest("hex");
    releaseTabLock = await acquireExclusiveLock(
      join(tmpdir(), "agentos-chrome-cdp", `${targetHash}.asset-capture.lock`),
      `exact profile/tab: ${profileName}/${String(tabId)}`,
      { profileName, tabId: String(tabId), manifestPath }
    );
    if (!overwrite && !resumeExisting && await pathExists(manifestPath)) {
      throw new Error("manifestPath already exists; use a fresh evidence directory");
    }
    await mkdir(assetDirectory, { recursive: true });

    const artifacts = new Map();
    const failures = new Map();
    let latestCheckpoint = null;
    let renderedCaptureQueue = Promise.resolve();

    function enqueueRenderedCapture(task) {
      const next = renderedCaptureQueue.then(task, task);
      renderedCaptureQueue = next.catch(() => {});
      return next;
    }

    function buildManifest(state, result) {
    return {
      ok: state === "completed" && result?.stopped === true
        && failures.size === 0 && artifacts.size === scrollOptions.expectedTotal,
      state,
      generatedAt: new Date().toISOString(),
      profileName,
      tabId: String(tabId),
      expectedTotal: scrollOptions.expectedTotal,
      stopped: result?.stopped ?? false,
      roundsCompleted: result?.roundsCompleted ?? latestCheckpoint?.round ?? 0,
      last: result?.last ?? latestCheckpoint,
      assetCount: artifacts.size,
      failureCount: failures.size,
      assets: [...artifacts.values()].sort((a, b) => a.key.localeCompare(b.key)),
      failures: [...failures.values()].sort((a, b) => a.key.localeCompare(b.key)),
      diagnostics,
      signedUrlsExposed: false
    };
    }

    async function captureAssets(value, round) {
      const observed = Array.isArray(value?.[assetField]) ? value[assetField] : [];
      const observedLimit = round === 0 && resumeExisting
        ? scrollOptions.expectedTotal
        : 100;
      if (observed.length > observedLimit) {
        throw new Error(`${round === 0 ? "initializeExpression" : "captureExpression"} returned too many assets in round ${round}`);
      }
      const unique = [];
      const seen = new Set();
      for (const item of observed) {
        const key = safeKey(item?.key);
        if (seen.has(key) || artifacts.has(key)) continue;
        seen.add(key);
        if (item?.decoded !== true || !Number.isFinite(item?.width) || item.width <= 0
          || !Number.isFinite(item?.height) || item.height <= 0) {
          failures.set(key, { key, error: "page_image_decode_or_dimensions_invalid" });
          continue;
        }
        let parsed;
        try {
          parsed = new URL(String(item?.sourceUrl || ""));
        } catch {
          failures.set(key, { key, error: "invalid_internal_source_url" });
          continue;
        }
        if (!["http:", "https:"].includes(parsed.protocol)) {
          failures.set(key, { key, error: "invalid_internal_source_protocol" });
          continue;
        }
        unique.push({
          key,
          sourceUrl: parsed.href,
          width: item.width,
          height: item.height,
          renderedClip: normalizeRenderedClip(item?.renderedClip)
        });
      }

      await mapLimit(unique, downloadConcurrency, async (item) => {
        const savePath = join(assetDirectory, `${item.key}.thumbnail`);
        try {
          if (resumeExisting && await pathExists(savePath)) {
            const bytes = await readFile(savePath);
            const contentType = detectImageContentType(bytes.subarray(0, 32));
            if (!contentType) throw new Error("Existing asset did not match a supported image signature");
            artifacts.set(item.key, {
              key: item.key,
              savedPath: savePath,
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              contentType,
              width: item.width,
              height: item.height,
              pageDecodeOk: true,
              fileSignatureOk: true,
              profileName,
              tabId: String(tabId),
              profileContext: true,
              sourceResolvedInsidePlugin: true,
              recoveredExisting: true
            });
            failures.delete(item.key);
            return;
          }
          let saved;
          let renderedClipFallback = false;
          try {
            saved = await savePageAssetImpl({
              router,
              profileName,
              tabId,
              sourceUrl: item.sourceUrl,
              savePath,
              expectedMimePrefix: "image/",
              overwrite,
              maxBytes: maxAssetBytes,
              timeoutMs: assetTimeoutMs
            });
          } catch (networkError) {
            if (!fallbackToRenderedClip || !item.renderedClip) throw networkError;
            const png = await enqueueRenderedCapture(async () => {
              const bytes = Buffer.from(await tab.screenshot({ clip: item.renderedClip }));
              if (bytes.length > maxAssetBytes) {
                throw new Error(`Rendered clip exceeded maxAssetBytes (${bytes.length} > ${maxAssetBytes})`);
              }
              assertImageSignature(bytes.subarray(0, 32), "image/png");
              await mkdir(dirname(savePath), { recursive: true });
              await writeFile(savePath, bytes, overwrite ? undefined : { flag: "wx" });
              return bytes;
            });
            saved = {
              savedPath: savePath,
              bytes: png.length,
              sha256: createHash("sha256").update(png).digest("hex"),
              contentType: "image/png"
            };
            renderedClipFallback = true;
          }
          const header = await readFile(savePath);
          assertImageSignature(header.subarray(0, 32), saved.contentType);
          artifacts.set(item.key, {
            key: item.key,
            savedPath: savePath,
            bytes: saved.bytes,
            sha256: saved.sha256,
            contentType: saved.contentType,
            width: item.width,
            height: item.height,
            pageDecodeOk: true,
            fileSignatureOk: true,
            profileName,
            tabId: String(tabId),
            profileContext: true,
            sourceResolvedInsidePlugin: true,
            renderedClipFallback,
            networkAssetFailedBeforeFallback: renderedClipFallback
          });
          failures.delete(item.key);
        } catch (error) {
          failures.set(item.key, { key: item.key, error: error?.message || String(error) });
        }
      });

      latestCheckpoint = {
        round,
        total: value?.total,
        newCount: value?.newCount,
        atBottom: value?.atBottom,
        assetsSaved: artifacts.size,
        assetFailures: failures.size
      };
      await writeJsonAtomic(manifestPath, buildManifest("running"));
      onProgress?.(latestCheckpoint);
      if (requireTotalAssetParity && Number.isInteger(value?.total)
        && value.total !== artifacts.size + failures.size) {
        throw new Error(
          `asset_capture_total_mismatch:${value.total}:${artifacts.size}:${failures.size}`
        );
      }
      if (stopOnAssetFailure && failures.size > 0) {
        throw new Error(`asset_capture_hard_failure:${failures.size}`);
      }
    }

    function sanitize(value) {
    const { [assetField]: _privateAssets, ...safe } = value || {};
    return { ...safe, assetsSaved: artifacts.size, assetFailures: failures.size };
    }

    let result;
    try {
      result = await runCuaScrollCapture({
      tab,
      ...scrollOptions,
      onInitial: (value) => captureAssets(value, 0),
      onCheckpoint: captureAssets,
      sanitizeInitial: sanitize,
      sanitizeCheckpoint: (value) => {
        return sanitize(value);
      }
      });
    } catch (error) {
      const manifest = {
        ...buildManifest("failed"),
        error: error?.message || String(error)
      };
      await writeJsonAtomic(manifestPath, manifest);
      throw error;
    }

    const manifest = buildManifest(
      result.stopped && failures.size === 0 && artifacts.size === scrollOptions.expectedTotal ? "completed" : "failed",
      result
    );
    await writeJsonAtomic(manifestPath, manifest);
    return { manifest, latestCheckpoint };
  } finally {
    if (releaseTabLock) await releaseTabLock();
    await releaseManifestLock();
  }
}

export function summarizeAssetCaptureManifest(manifest, { includeAssets = false } = {}) {
  if (includeAssets) return manifest;
  const { assets: _assets, failures: _failures, ...summary } = manifest || {};
  return {
    ...summary,
    assetsIncluded: false,
    failuresIncluded: false
  };
}
