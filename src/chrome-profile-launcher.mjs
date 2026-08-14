import { access, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export class ChromeProfileLaunchError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ChromeProfileLaunchError";
    this.code = code;
    this.details = details;
  }
}

function pathForPlatform(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function platformDefaults({
  platform = process.platform,
  env = process.env,
  home = homedir()
} = {}) {
  const platformPath = pathForPlatform(platform);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    return {
      userDataDir: localAppData
        ? platformPath.join(localAppData, "Google", "Chrome", "User Data")
        : null,
      executableCandidates: [
        env.PROGRAMFILES && platformPath.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        env["PROGRAMFILES(X86)"] && platformPath.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
        localAppData && platformPath.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
      ].filter(Boolean)
    };
  }
  if (platform === "darwin") {
    return {
      userDataDir: platformPath.join(home, "Library", "Application Support", "Google", "Chrome"),
      executableCandidates: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    };
  }
  return {
    userDataDir: platformPath.join(home, ".config", "google-chrome"),
    executableCandidates: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/google-chrome"
    ]
  };
}

function launcherConfig(config = {}) {
  const value = config.chromeProfileLauncher || {};
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChromeProfileLaunchError(
      "chromeProfileLauncher config must be an object",
      "INVALID_LAUNCHER_CONFIG"
    );
  }
  return value;
}

function safeProfileDirectory(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

const AGENT_OS_EXTENSION_NAME = "Agent OS Chrome CDP";
const CHROME_EXTENSION_ID = /^[a-p]{32}$/;

function validAgentOsExtensionManifest(manifest) {
  const permissions = Array.isArray(manifest?.permissions) ? manifest.permissions : [];
  return manifest?.manifest_version === 3
    && manifest?.name === AGENT_OS_EXTENSION_NAME
    && manifest?.background?.service_worker === "service-worker.js"
    && manifest?.background?.type === "module"
    && manifest?.options_ui?.page === "options.html"
    && permissions.includes("debugger")
    && permissions.includes("storage")
    && permissions.includes("offscreen");
}

export async function readAgentOsExtensionBinding(catalog, profile, config = {}, dependencies = {}) {
  const fsReadFile = dependencies.readFile || readFile;
  const fsRealpath = dependencies.realpath || realpath;
  const effectivePlatform = dependencies.platform ?? process.platform;
  const platformPath = pathForPlatform(effectivePlatform);
  const local = launcherConfig(config);
  const configuredId = local.extensionIdOverrides?.[profile.directory] || local.extensionId;
  if (!configuredId) {
    throw new ChromeProfileLaunchError(
      "A trusted Agent OS Chrome extension ID is required for secure bootstrap",
      "TRUSTED_EXTENSION_ID_REQUIRED",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  if (!CHROME_EXTENSION_ID.test(configuredId)) {
    throw new ChromeProfileLaunchError(
      "Configured Agent OS Chrome extension ID is invalid",
      "INVALID_EXTENSION_ID"
    );
  }
  const configuredPath = local.extensionPathOverrides?.[profile.directory] || local.extensionPath;
  if (!configuredPath || !platformPath.isAbsolute(configuredPath)) {
    throw new ChromeProfileLaunchError(
      "A trusted absolute Agent OS Chrome extension path is required for secure bootstrap",
      "TRUSTED_EXTENSION_PATH_REQUIRED",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  let trustedPath;
  try {
    trustedPath = await fsRealpath(configuredPath);
  } catch {
    throw new ChromeProfileLaunchError(
      "The trusted Agent OS Chrome extension path is unavailable",
      "TRUSTED_EXTENSION_PATH_UNAVAILABLE",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  const profileRoot = platformPath.join(catalog.userDataDir, profile.directory);
  let settings;
  try {
    const parsed = JSON.parse(
      await fsReadFile(platformPath.join(profileRoot, "Secure Preferences"), "utf8")
    );
    settings = parsed?.extensions?.settings || {};
  } catch {
    throw new ChromeProfileLaunchError(
      `Chrome Secure Preferences is unavailable for profile ${profile.directory}`,
      "CHROME_SECURE_PREFERENCES_UNAVAILABLE",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  const entry = settings[configuredId];
  if (entry?.location !== 4 || typeof entry?.path !== "string" || !platformPath.isAbsolute(entry.path)) {
    throw new ChromeProfileLaunchError(
      `Trusted Agent OS Chrome extension is not installed in profile ${profile.directory}`,
      "CHROME_EXTENSION_NOT_FOUND",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  let installedPath;
  try {
    installedPath = await fsRealpath(entry.path);
  } catch {
    throw new ChromeProfileLaunchError(
      `Trusted Agent OS Chrome extension path is unavailable in profile ${profile.directory}`,
      "CHROME_EXTENSION_PATH_UNAVAILABLE",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  const normalizePath = (value) => effectivePlatform === "win32"
    ? value.toLocaleLowerCase()
    : value;
  if (normalizePath(installedPath) !== normalizePath(trustedPath)) {
    throw new ChromeProfileLaunchError(
      `Trusted Agent OS Chrome extension path does not match profile ${profile.directory}`,
      "CHROME_EXTENSION_PATH_MISMATCH",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  let buildId;
  try {
    const manifest = JSON.parse(
      await fsReadFile(platformPath.join(installedPath, "manifest.json"), "utf8")
    );
    if (!validAgentOsExtensionManifest(manifest)) throw new Error("manifest contract mismatch");
    if (typeof manifest.version_name !== "string") throw new Error("manifest build identifier is invalid");
    buildId = manifest.version_name.trim();
    if (!buildId || buildId.length > 128) throw new Error("manifest build identifier is invalid");
  } catch {
    throw new ChromeProfileLaunchError(
      `Trusted Agent OS Chrome extension manifest is invalid in profile ${profile.directory}`,
      "CHROME_EXTENSION_MANIFEST_INVALID",
      { resolvedProfileDirectory: profile.directory }
    );
  }
  return { extensionId: configuredId, buildId };
}

export async function readChromeProfileCatalog(config = {}, dependencies = {}) {
  const fsReadFile = dependencies.readFile || readFile;
  const defaults = platformDefaults(dependencies);
  const local = launcherConfig(config);
  const userDataDir = local.userDataDir || defaults.userDataDir;
  if (!userDataDir) {
    throw new ChromeProfileLaunchError(
      "Chrome user-data directory could not be determined",
      "CHROME_USER_DATA_UNAVAILABLE"
    );
  }
  const localStatePath = pathForPlatform(dependencies.platform).join(userDataDir, "Local State");
  let parsed;
  try {
    parsed = JSON.parse(await fsReadFile(localStatePath, "utf8"));
  } catch (error) {
    throw new ChromeProfileLaunchError(
      `Chrome Local State is unavailable or invalid: ${error.message}`,
      "CHROME_LOCAL_STATE_UNAVAILABLE",
      { localStatePath }
    );
  }
  const entries = Object.entries(parsed?.profile?.info_cache || {})
    .filter(([directory]) => safeProfileDirectory(directory))
    .map(([directory, value]) => ({
      directory,
      displayName: typeof value?.name === "string" ? value.name : "",
      gaiaName: typeof value?.gaia_name === "string" ? value.gaia_name : "",
      userName: typeof value?.user_name === "string" ? value.user_name : ""
    }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
  return { userDataDir, localStatePath, profiles: entries };
}

export function publicChromeProfileCatalog(catalog) {
  return {
    profiles: (catalog?.profiles || []).map(({ directory, displayName }) => ({
      directory,
      displayName
    }))
  };
}

export function resolveChromeProfile(catalog, requestedName, config = {}) {
  if (typeof requestedName !== "string" || !requestedName.trim()) {
    throw new ChromeProfileLaunchError(
      "profileName must be a non-empty string",
      "INVALID_PROFILE_NAME"
    );
  }
  const requested = requestedName.trim();
  const local = launcherConfig(config);
  const override = local.profileDirectoryOverrides?.[requested];
  if (override != null && !safeProfileDirectory(override)) {
    throw new ChromeProfileLaunchError(
      `Configured profile directory for ${requested} is invalid`,
      "INVALID_PROFILE_OVERRIDE"
    );
  }
  let matches = override
    ? catalog.profiles.filter((item) => item.directory === override)
    : catalog.profiles.filter((item) =>
      item.directory === requested
      || item.displayName === requested
      || item.gaiaName === requested);
  if (!matches.length && !override) {
    const folded = requested.toLocaleLowerCase();
    matches = catalog.profiles.filter((item) =>
      [item.directory, item.displayName, item.gaiaName, item.userName]
        .some((value) => typeof value === "string" && value.toLocaleLowerCase() === folded));
  }
  if (!matches.length) {
    throw new ChromeProfileLaunchError(
      `Chrome profile was not found: ${requested}`,
      "CHROME_PROFILE_NOT_FOUND",
      { requestedProfileName: requested }
    );
  }
  if (matches.length !== 1) {
    throw new ChromeProfileLaunchError(
      `Chrome profile name is ambiguous: ${requested}`,
      "CHROME_PROFILE_AMBIGUOUS",
      { requestedProfileName: requested, matchingDirectories: matches.map((item) => item.directory) }
    );
  }
  const profile = matches[0];
  const metadataNameFor = (candidate) => {
    const overrides = local.extensionProfileNameOverrides || {};
    if (Object.hasOwn(overrides, candidate.directory)) {
      const configuredOverride = overrides[candidate.directory];
      const override = typeof configuredOverride === "string"
        ? configuredOverride.trim()
        : "";
      if (!override || override.length > 256) {
        throw new ChromeProfileLaunchError(
          `Configured extension profile name for ${candidate.directory} is invalid`,
          "INVALID_EXTENSION_PROFILE_NAME_OVERRIDE"
        );
      }
      return { name: override, explicit: true };
    }
    const displayName = String(candidate.displayName || "").trim();
    return { name: displayName || candidate.directory, explicit: false };
  };
  const expected = metadataNameFor(profile);
  const duplicateDisplayDirectories = profile.displayName
    ? catalog.profiles
      .filter((candidate) => candidate.displayName === profile.displayName)
      .map((candidate) => candidate.directory)
    : [];
  const matchingMetadataDirectories = catalog.profiles
    .filter((candidate) => metadataNameFor(candidate).name === expected.name)
    .map((candidate) => candidate.directory);
  if (
    (duplicateDisplayDirectories.length > 1 && !expected.explicit)
    || matchingMetadataDirectories.length !== 1
    || matchingMetadataDirectories[0] !== profile.directory
  ) {
    throw new ChromeProfileLaunchError(
      `Chrome extension profile metadata name is ambiguous for directory ${profile.directory}`,
      "CHROME_METADATA_PROFILE_AMBIGUOUS",
      {
        requestedProfileName: requested,
        resolvedProfileDirectory: profile.directory,
        expectedMetadataProfileName: expected.name,
        matchingDirectories: matchingMetadataDirectories,
        duplicateDisplayDirectories
      }
    );
  }
  const expectedMetadataProfileName = expected.name;
  return { ...profile, expectedMetadataProfileName };
}

async function findChromeExecutable(config = {}, dependencies = {}) {
  const fsAccess = dependencies.access || access;
  const defaults = platformDefaults(dependencies);
  const local = launcherConfig(config);
  const candidates = [
    local.executablePath,
    ...defaults.executableCandidates
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fsAccess(candidate);
      return candidate;
    } catch {}
  }
  throw new ChromeProfileLaunchError(
    "A standard Google Chrome executable was not found",
    "CHROME_EXECUTABLE_NOT_FOUND"
  );
}

function launchDeadlineError(profileName, timeoutMs) {
  return new ChromeProfileLaunchError(
    `Chrome profile bootstrap did not complete within ${timeoutMs}ms`,
    "CHROME_PROFILE_REGISTRATION_TIMEOUT",
    { requestedProfileName: profileName, timeoutMs }
  );
}

async function withinLaunchDeadline(operation, {
  deadline,
  now,
  profileName,
  timeoutMs,
  setDeadlineTimeout = setTimeout,
  clearDeadlineTimeout = clearTimeout
}) {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) throw launchDeadlineError(profileName, timeoutMs);
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setDeadlineTimeout(
          () => reject(launchDeadlineError(profileName, timeoutMs)),
          Math.max(1, remainingMs)
        );
      })
    ]);
  } finally {
    clearDeadlineTimeout(timer);
  }
}

async function waitForSpawnAcknowledgement(child, timeoutMs) {
  if (!child || typeof child.once !== "function") return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const safeErrorListener = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("spawn", onSpawn);
      child.removeListener?.("error", onError);
      child.on?.("error", safeErrorListener);
      callback(value);
    };
    const onSpawn = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    const timer = setTimeout(
      () => finish(reject, new Error("Chrome process start acknowledgement timed out")),
      Math.max(1, timeoutMs)
    );
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export async function launchChromeProfile({
  router,
  config = {},
  profileName,
  timeoutMs = 30000
}, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const startedAt = now();
  const boundedTimeoutMs = Math.min(120000, Math.max(1000, Number(timeoutMs) || 30000));
  const deadline = startedAt + boundedTimeoutMs;
  const remaining = () => {
    const value = deadline - now();
    if (value <= 0) throw launchDeadlineError(profileName, boundedTimeoutMs);
    return value;
  };
  const withinDeadline = (operation) => withinLaunchDeadline(operation, {
    deadline,
    now,
    profileName,
    timeoutMs: boundedTimeoutMs,
    setDeadlineTimeout: dependencies.setDeadlineTimeout || setTimeout,
    clearDeadlineTimeout: dependencies.clearDeadlineTimeout || clearTimeout
  });
  const catalog = await withinDeadline(readChromeProfileCatalog(config, dependencies));
  const profile = resolveChromeProfile(catalog, profileName, config);
  const extension = await withinDeadline(
    readAgentOsExtensionBinding(catalog, profile, config, dependencies)
  );
  const executablePath = await withinDeadline(findChromeExecutable(config, dependencies));
  if (
    typeof router.issueBootstrapToken !== "function"
    || typeof router.bootstrapStatus !== "function"
    || typeof router.cancelBootstrap !== "function"
  ) {
    throw new ChromeProfileLaunchError(
      "Chrome bridge does not support secure profile bootstrap",
      "CHROME_BOOTSTRAP_UNAVAILABLE"
    );
  }
  const issued = await router.issueBootstrapToken({
    profileName: profile.expectedMetadataProfileName,
    extensionId: extension.extensionId,
    buildId: extension.buildId,
    profileDirectory: profile.directory
  }, { deadline });
  if (!issued?.attemptId || !issued?.token) {
    throw new ChromeProfileLaunchError(
      "Chrome bridge returned an invalid secure bootstrap attempt",
      "CHROME_BOOTSTRAP_UNAVAILABLE"
    );
  }
  const bootstrapUrl = `chrome-extension://${extension.extensionId}/options.html#port=${config.port}&bootstrap=${encodeURIComponent(issued.token)}`;
  const args = [`--profile-directory=${profile.directory}`];
  if (launcherConfig(config).userDataDir) {
    args.push(`--user-data-dir=${catalog.userDataDir}`);
  }
  args.push(bootstrapUrl);
  const spawnProcess = dependencies.spawn || spawn;
  let bootstrapRegistered = false;
  try {
    const child = spawnProcess(executablePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    await waitForSpawnAcknowledgement(child, remaining());
    child.unref?.();
  } catch (error) {
    await router.cancelBootstrap(issued.attemptId, { deadline: now() + 1000 }).catch(() => {});
    throw new ChromeProfileLaunchError(
      "Chrome profile launch failed",
      "CHROME_LAUNCH_FAILED",
      { requestedProfileName: profileName, resolvedProfileDirectory: profile.directory }
    );
  }
  const sleep = dependencies.sleep || ((delay) =>
    new Promise((resolve) => setTimeout(resolve, delay)));
  try {
    while (now() < deadline) {
      let receipt;
      try {
        receipt = await router.bootstrapStatus(issued.attemptId, { deadline });
      } catch (error) {
        if (error?.code === "BOOTSTRAP_STATE_LOST" || /attempt is unavailable/i.test(error?.message || "")) {
          throw new ChromeProfileLaunchError(
            "Secure Chrome bootstrap state became unavailable",
            "CHROME_BOOTSTRAP_STATE_LOST",
            { requestedProfileName: profileName, resolvedProfileDirectory: profile.directory }
          );
        }
        throw error;
      }
      if (
        receipt?.attemptId !== issued.attemptId
        || receipt?.profileName !== profile.expectedMetadataProfileName
        || receipt?.extensionId !== extension.extensionId
        || receipt?.buildId !== extension.buildId
      ) {
        throw new ChromeProfileLaunchError(
          "Chrome bridge returned a mismatched secure bootstrap receipt",
          "CHROME_BOOTSTRAP_RECEIPT_MISMATCH",
          { requestedProfileName: profileName, resolvedProfileDirectory: profile.directory }
        );
      }
      if (receipt.state === "REGISTERED") {
        if (
          receipt.bindingVerified !== true
          || receipt.verifiedProfileDirectory !== profile.directory
        ) {
          throw new ChromeProfileLaunchError(
            "Chrome bridge returned an unverified profile-directory bootstrap receipt",
            "CHROME_BOOTSTRAP_DIRECTORY_MISMATCH",
            { requestedProfileName: profileName, resolvedProfileDirectory: profile.directory }
          );
        }
        const connectedAfter = await router.list({ deadline });
        const live = connectedAfter.find((item) =>
          item.profileName === profile.expectedMetadataProfileName
          && item.extensionId === extension.extensionId
          && item.buildId === extension.buildId
          && item.bindingVerified === true
          && item.verifiedProfileDirectory === profile.directory
        );
        if (!live) {
          throw new ChromeProfileLaunchError(
            "Secure Chrome bootstrap registered but the exact extension connection is no longer live",
            "CHROME_BOOTSTRAP_CONNECTION_LOST",
            {
              requestedProfileName: profileName,
              resolvedProfileDirectory: profile.directory,
              expectedExtensionId: extension.extensionId,
              expectedBuildId: extension.buildId
            }
          );
        }
        bootstrapRegistered = true;
        return {
          ok: true,
          alreadyConnected: false,
          requestedProfileName: profileName,
          resolvedProfileDirectory: profile.directory,
          displayName: profile.displayName,
          connectedProfile: {
            profileName: receipt.profileName,
            extensionId: receipt.extensionId,
            buildId: receipt.buildId,
            bindingVerified: receipt.bindingVerified,
            verifiedProfileDirectory: receipt.verifiedProfileDirectory,
            version: live.version
          },
          elapsedMs: now() - startedAt
        };
      }
      if (["REJECTED", "FAILED", "EXPIRED", "CANCELLED"].includes(receipt.state)) {
        throw new ChromeProfileLaunchError(
          `Secure Chrome bootstrap registration ended in state ${receipt.state}`,
          "CHROME_BOOTSTRAP_REGISTRATION_REJECTED",
          {
            requestedProfileName: profileName,
            resolvedProfileDirectory: profile.directory,
            failureCode: receipt.failureCode || receipt.state
          }
        );
      }
      await sleep(Math.min(250, remaining()));
    }
    throw launchDeadlineError(profileName, boundedTimeoutMs);
  } finally {
    if (!bootstrapRegistered) {
      await router.cancelBootstrap(issued.attemptId, { deadline: now() + 1000 }).catch(() => {});
    }
  }
}
