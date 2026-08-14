import { spawn } from "node:child_process";

export const MAX_VISUAL_BACKEND_REQUEST_BYTES = 67_108_864;
export const MAX_VISUAL_BACKEND_RESPONSE_BYTES = 2_097_152;
export const DEFAULT_VISUAL_BACKEND_TIMEOUT_MS = 30_000;

export class VisualBackendError extends Error {
  constructor(message) {
    super(message);
    this.name = "VisualBackendError";
  }
}

function waitForClose(closed, timeoutMs) {
  return Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

function forceKillWindowsTree(pid) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { killer.kill(); } catch {}
      resolve();
    }, 2_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    killer.once("error", done);
    killer.once("close", done);
  });
}

function boundedPositiveInteger(value, fallback, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new VisualBackendError("invalid visual backend limits");
  }
  return Math.min(number, maximum);
}

function serializeRequest(payload, maximum) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(payload), "utf8");
  } catch {
    throw new VisualBackendError("visual backend request is not valid JSON");
  }
  if (body.length > maximum) {
    throw new VisualBackendError("visual backend request exceeds the request limit");
  }
  return body;
}

function parseResponse(bytes) {
  try {
    const value = JSON.parse(Buffer.concat(bytes).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new VisualBackendError("visual backend returned invalid JSON");
  }
}

class CliVisualBackend {
  constructor(command, args, options, kind = "local-cli") {
    this.command = command;
    this.args = args;
    this.shell = false;
    this.kind = kind;
    this.timeoutMs = boundedPositiveInteger(
      options.timeoutMs,
      DEFAULT_VISUAL_BACKEND_TIMEOUT_MS,
      120_000
    );
    this.maxRequestBytes = boundedPositiveInteger(
      options.maxRequestBytes,
      MAX_VISUAL_BACKEND_REQUEST_BYTES,
      MAX_VISUAL_BACKEND_REQUEST_BYTES
    );
    this.maxResponseBytes = boundedPositiveInteger(
      options.maxResponseBytes,
      MAX_VISUAL_BACKEND_RESPONSE_BYTES,
      MAX_VISUAL_BACKEND_RESPONSE_BYTES
    );
  }

  async request(payload) {
    const input = serializeRequest(payload, this.maxRequestBytes);
    return new Promise((resolve, reject) => {
      let settled = false;
      let stopping = false;
      let responseBytes = 0;
      const chunks = [];
      let child;
      try {
        child = spawn(this.command, this.args, {
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch {
        reject(new VisualBackendError("visual backend could not be started"));
        return;
      }

      let closeResolve;
      const closed = new Promise((resolveClose) => { closeResolve = resolveClose; });
      child.once("close", closeResolve);

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const stop = async (message) => {
        if (settled || stopping) return;
        stopping = true;
        child.stdin.destroy();
        try { child.kill("SIGTERM"); } catch {}
        let exited = await waitForClose(closed, 250);
        if (!exited) {
          if (process.platform === "win32") {
            await forceKillWindowsTree(child.pid);
            try { child.kill("SIGKILL"); } catch {}
          } else {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch { try { child.kill("SIGKILL"); } catch {} }
          }
          exited = await waitForClose(closed, 2_000);
        }
        if (!exited) {
          try { child.kill("SIGKILL"); } catch {}
          await waitForClose(closed, 2_000);
        }
        finish(new VisualBackendError(message));
      };
      const timer = setTimeout(() => {
        void stop(`visual backend timed out after ${this.timeoutMs}ms`);
      }, this.timeoutMs);

      child.stdout.on("data", (chunk) => {
        if (settled) return;
        responseBytes += chunk.length;
        if (responseBytes > this.maxResponseBytes) {
          void stop("visual backend exceeded the response limit");
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => {
        finish(new VisualBackendError("visual backend could not be started"));
      });
      child.on("close", (code, signal) => {
        if (settled || stopping) return;
        if (code !== 0 || signal) {
          finish(new VisualBackendError("visual backend exited unsuccessfully"));
          return;
        }
        try {
          finish(null, parseResponse(chunks));
        } catch (error) {
          finish(error);
        }
      });
      child.stdin.end(input);
    });
  }
}

class HttpVisualBackend {
  constructor(url, options) {
    this.url = url;
    this.kind = "loopback-http";
    this.timeoutMs = boundedPositiveInteger(
      options.timeoutMs,
      DEFAULT_VISUAL_BACKEND_TIMEOUT_MS,
      120_000
    );
    this.maxRequestBytes = boundedPositiveInteger(
      options.maxRequestBytes,
      MAX_VISUAL_BACKEND_REQUEST_BYTES,
      MAX_VISUAL_BACKEND_REQUEST_BYTES
    );
    this.maxResponseBytes = boundedPositiveInteger(
      options.maxResponseBytes,
      MAX_VISUAL_BACKEND_RESPONSE_BYTES,
      MAX_VISUAL_BACKEND_RESPONSE_BYTES
    );
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async request(payload) {
    const body = serializeRequest(payload, this.maxRequestBytes);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "manual",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new VisualBackendError(`visual backend http status ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        throw new VisualBackendError("visual backend exceeded the response limit");
      }

      const chunks = [];
      let responseBytes = 0;
      for await (const chunk of response.body ?? []) {
        responseBytes += chunk.length;
        if (responseBytes > this.maxResponseBytes) {
          controller.abort();
          throw new VisualBackendError("visual backend exceeded the response limit");
        }
        chunks.push(Buffer.from(chunk));
      }
      return parseResponse(chunks);
    } catch (error) {
      if (error instanceof VisualBackendError) throw error;
      if (timedOut || error?.name === "AbortError") {
        throw new VisualBackendError(`visual backend timed out after ${this.timeoutMs}ms`);
      }
      throw new VisualBackendError("visual backend request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseCliSpec(value) {
  const source = value.slice(4);
  if (!source) throw new VisualBackendError("visual CLI backend requires an executable");
  if (!source.startsWith("[")) return [source];
  let argv;
  try {
    argv = JSON.parse(source);
  } catch {
    throw new VisualBackendError("visual CLI backend has invalid JSON arguments");
  }
  if (!Array.isArray(argv) || argv.length < 1 || !argv.every((item) => typeof item === "string")) {
    throw new VisualBackendError("visual CLI backend requires string arguments");
  }
  if (!argv[0]) throw new VisualBackendError("visual CLI backend requires an executable");
  return argv;
}

function parseLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new VisualBackendError("visual HTTP backend requires an exact loopback URL and port");
  }
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    || url.username
    || url.password
    || !url.port
  ) {
    throw new VisualBackendError("visual HTTP backend requires an exact loopback URL and port");
  }
  return url;
}

export function createVisualBackend(spec, options = {}) {
  if (spec === undefined || spec === null || spec === "") return null;
  if (typeof spec !== "string") throw new VisualBackendError("invalid visual backend specification");

  if (spec === "ppocr") {
    const command = options.ppocrCommand;
    const args = options.ppocrArgs ?? [];
    if (typeof command !== "string" || !command || !Array.isArray(args)) {
      throw new VisualBackendError("PP-OCR backend requires a configured local adapter");
    }
    return new CliVisualBackend(command, args, options, "ppocrv5-mobile");
  }
  if (spec.startsWith("cli:")) {
    const [command, ...args] = parseCliSpec(spec);
    return new CliVisualBackend(command, args, options);
  }
  if (spec.startsWith("http://") || spec.startsWith("https://")) {
    return new HttpVisualBackend(parseLoopbackUrl(spec), options);
  }
  throw new VisualBackendError("invalid visual backend specification");
}
