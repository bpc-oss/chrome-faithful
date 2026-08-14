import { readFile } from "node:fs/promises";
import vm from "node:vm";
import YAML from "yaml";

const JS_EXPRESSION = Symbol("dsh-js-expression");

const jsExpressionTag = {
  tag: "tag:yaml.org,2002:js",
  resolve(source) {
    return { [JS_EXPRESSION]: String(source).trim() };
  }
};

function evaluateExpressions(value, context) {
  if (value && typeof value === "object" && JS_EXPRESSION in value) {
    const evaluated = vm.runInNewContext(`(${value[JS_EXPRESSION]})`, context, {
      timeout: 1000
    });
    return evaluateExpressions(evaluated, context);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => evaluateExpressions(entry, context));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, evaluateExpressions(entry, context)])
    );
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

export function validateDshMcpConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("MCP client config must be an object");
  }
  requireString(config.serverName, "serverName");
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName)) {
    throw new TypeError("serverName must match the DSH MCP namespace contract");
  }
  if (config.transport !== "stdio") throw new TypeError("transport must be stdio");
  requireString(config.command, "command");
  if (!Array.isArray(config.args) || config.args.some((value) => typeof value !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  if (!config.env || typeof config.env !== "object" || Array.isArray(config.env)) {
    throw new TypeError("env must be a string dictionary");
  }
  if (Object.values(config.env).some((value) => typeof value !== "string")) {
    throw new TypeError("environment values must be strings");
  }
  if (!Number.isInteger(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0) {
    throw new TypeError("toolCallTimeoutMs must be a positive integer");
  }
  if (typeof config.failOnStartupError !== "boolean") {
    throw new TypeError("failOnStartupError must be boolean");
  }
  return config;
}

export async function loadDshBundlePatch({
  patchPath,
  baseUrl,
  environment = process.env
}) {
  requireString(patchPath, "patchPath");
  requireString(baseUrl, "baseUrl");
  const source = await readFile(patchPath, "utf8");
  const parsed = YAML.parse(source, { customTags: [jsExpressionTag] });
  const processFacade = Object.freeze({
    execPath: process.execPath,
    env: Object.freeze({ ...environment }),
    getBuiltinModule: process.getBuiltinModule.bind(process)
  });
  const evaluated = evaluateExpressions(parsed, {
    baseUrl,
    process: processFacade
  });
  const rows = evaluated?.[0]?.insert;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new TypeError("DSH bundle patch must insert exactly one row");
  }
  const row = rows[0];
  if (row.id !== "chrome-faithful-mcp") {
    throw new TypeError("DSH bundle row id is invalid");
  }
  if (row.name !== "@deepseek-ai/dsh-mcp-client") {
    throw new TypeError("DSH bundle must mount the official MCP client");
  }
  validateDshMcpConfig(row.config);
  return row;
}
