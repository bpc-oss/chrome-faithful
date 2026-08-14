import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPluginRoot = await realpath(pluginRoot);

const REQUIRED_KEYS = new Set([
  "host",
  "port",
  "secret",
  "commandTimeoutMs",
  "profileAliases"
]);
const OPTIONAL_KEYS = new Set([
  "bridgeElectionTimeoutMs",
  "profileReconnectTimeoutMs",
  "chromeProfileLauncher"
]);

export function defaultConfigPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "AgentOS", "agentos-chrome-cdp", "config.json");
}

function isInsideOrEqual(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function loadConfig(explicitPath = process.env.AGENTOS_CHROME_CONFIG) {
  const requestedPath = path.resolve(explicitPath || defaultConfigPath());
  let configPath;
  try {
    configPath = await realpath(requestedPath);
  } catch {
    throw new Error(`Agent OS Chrome CDP config is unavailable at ${requestedPath}`);
  }
  if (isInsideOrEqual(configPath, canonicalPluginRoot)) {
    throw new Error("bridge configuration must be stored outside the plugin source tree");
  }

  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new Error(`Agent OS Chrome CDP config cannot be read at ${requestedPath}`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("Agent OS Chrome CDP config is not valid JSON");
  }
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Bridge config must be a JSON object");
  }
  const keys = Object.keys(config);
  if (
    [...REQUIRED_KEYS].some((key) => !Object.hasOwn(config, key))
    || keys.some((key) => !REQUIRED_KEYS.has(key) && !OPTIONAL_KEYS.has(key))
  ) {
    throw new Error("Bridge configuration failed its closed schema checks");
  }
  if (config.host !== "127.0.0.1") throw new Error("Bridge host must be 127.0.0.1");
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error("Bridge port must be an integer from 1024 to 65535");
  }
  if (
    typeof config.secret !== "string"
    || !/^[A-Za-z0-9+/]{43}=$/.test(config.secret)
    || Buffer.from(config.secret, "base64").length !== 32
  ) {
    throw new Error("Bridge secret must be a generated 256-bit value");
  }
  if (
    !Number.isInteger(config.commandTimeoutMs)
    || config.commandTimeoutMs < 1000
    || config.commandTimeoutMs > 300000
  ) {
    throw new Error("Bridge command timeout is outside the supported range");
  }
  if (
    config.profileAliases == null
    || typeof config.profileAliases !== "object"
    || Array.isArray(config.profileAliases)
    || Object.values(config.profileAliases).some((value) => typeof value !== "string")
  ) {
    throw new Error("Bridge profile aliases must be a string map");
  }
  for (const key of ["bridgeElectionTimeoutMs", "profileReconnectTimeoutMs"]) {
    if (
      Object.hasOwn(config, key)
      && (!Number.isInteger(config[key]) || config[key] < 500 || config[key] > 300000)
    ) {
      throw new Error("Bridge reconnect timeout is outside the supported range");
    }
  }
  if (
    Object.hasOwn(config, "chromeProfileLauncher")
    && (
      config.chromeProfileLauncher == null
      || typeof config.chromeProfileLauncher !== "object"
      || Array.isArray(config.chromeProfileLauncher)
    )
  ) {
    throw new Error("Chrome profile launcher config must be an object");
  }
  if (config.chromeProfileLauncher) {
    const launcher = config.chromeProfileLauncher;
    const allowedLauncherKeys = new Set([
      "executablePath",
      "userDataDir",
      "profileDirectoryOverrides",
      "extensionProfileNameOverrides",
      "extensionId",
      "extensionIdOverrides",
      "extensionPath",
      "extensionPathOverrides"
    ]);
    if (Object.keys(launcher).some((key) => !allowedLauncherKeys.has(key))) {
      throw new Error("Chrome profile launcher configuration failed its closed schema checks");
    }
    for (const key of ["executablePath", "userDataDir", "extensionId", "extensionPath"]) {
      if (Object.hasOwn(launcher, key) && typeof launcher[key] !== "string") {
        throw new Error("Chrome profile launcher scalar settings must be strings");
      }
    }
    for (const key of [
      "profileDirectoryOverrides",
      "extensionProfileNameOverrides",
      "extensionIdOverrides",
      "extensionPathOverrides"
    ]) {
      if (
        Object.hasOwn(launcher, key)
        && (
          launcher[key] == null
          || typeof launcher[key] !== "object"
          || Array.isArray(launcher[key])
          || Object.values(launcher[key]).some((value) => typeof value !== "string")
        )
      ) {
        throw new Error("Chrome profile launcher override settings must be string maps");
      }
    }
  }
  return { ...config, configPath };
}
