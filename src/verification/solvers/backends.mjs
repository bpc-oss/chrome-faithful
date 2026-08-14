// Solver backend interface: the recognition brains (OCR / ASR / slider gap
// detection) live outside this repository — typically the Python
// captcha_connector stack (faster-whisper, baidu/Unlimited-OCR, opencv).
// chrome-faithful performs the browser interaction; a backend answers
// "what does this image say", "what does this audio say", "where is the gap".
//
// Two transports:
//   - cli: spawn <command> <args> with a JSON request on stdin, expect JSON on
//     stdout (see docs for the reference adapter protocol).
//   - http: POST { action, ... } to <url>, expect JSON response.
//
// No backend is required: detection, hold/resume, handoff, overlay handling,
// and humanized interaction all work without one.

import { spawn } from "node:child_process";

export class SolverBackendError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "SolverBackendError";
    this.details = details;
  }
}

export class CliBackend {
  constructor({ command, args = [], timeoutMs = 30000 }) {
    if (!command) throw new SolverBackendError("cli backend requires a command");
    this.command = command;
    this.args = args;
    this.timeoutMs = Math.min(120000, Math.max(1000, Number(timeoutMs) || 30000));
  }

  async request(payload) {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new SolverBackendError(`backend timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new SolverBackendError(`backend spawn failed: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new SolverBackendError(`backend exited ${code}: ${err.slice(0, 300)}`));
          return;
        }
        resolve(out);
      });
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
    try {
      return JSON.parse(stdout);
    } catch {
      return { text: stdout.trim(), raw: true };
    }
  }

  async status() {
    const result = await this.request({ action: "status" });
    return result;
  }

  async solveAudio({ audioPath, audioUrl }) {
    return this.request({ action: "solve-audio", audioPath, audioUrl });
  }

  async solveImage({ imagePath }) {
    return this.request({ action: "solve-image", imagePath });
  }

  async locateGap({ imagePath }) {
    return this.request({ action: "locate-gap", imagePath });
  }
}

export class HttpBackend {
  constructor({ url, timeoutMs = 30000, headers = {} }) {
    if (!url) throw new SolverBackendError("http backend requires a url");
    this.url = url;
    this.timeoutMs = Math.min(120000, Math.max(1000, Number(timeoutMs) || 30000));
    this.headers = headers;
  }

  async request(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new SolverBackendError(`backend http ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof SolverBackendError) throw error;
      throw new SolverBackendError(`backend request failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async status() { return this.request({ action: "status" }); }
  async solveAudio({ audioPath, audioUrl }) { return this.request({ action: "solve-audio", audioPath, audioUrl }); }
  async solveImage({ imagePath }) { return this.request({ action: "solve-image", imagePath }); }
  async locateGap({ imagePath }) { return this.request({ action: "locate-gap", imagePath }); }
}

// Single factory: accepts a config object ({type:"cli"|"http", ...}), a plain
// string (command line), a "cli:"-prefixed command line, or an http(s) URL.
export function createBackend(config) {
  if (!config) return null;
  if (typeof config === "string") {
    if (config.startsWith("http://") || config.startsWith("https://")) {
      return new HttpBackend({ url: config });
    }
    const spec = config.startsWith("cli:") ? config.slice(4) : config;
    const [command, ...args] = spec.split(/\s+/).filter(Boolean);
    return new CliBackend({ command, args });
  }
  if (config.type === "cli") return new CliBackend(config);
  if (config.type === "http") return new HttpBackend(config);
  throw new SolverBackendError(`unknown backend type: ${config.type}`);
}

// Environment-style alias of createBackend: "http://127.0.0.1:18001",
// "cli:python scripts/verification/captcha-backend-adapter.py", or a bare
// command line. Empty/undefined -> null (no backend).
export function createBackendFromEnv(value) {
  return createBackend(value);
}
