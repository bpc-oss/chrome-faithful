import { request as httpRequest } from "node:http";
import { loadConfig } from "./config.mjs";

export class BridgeClient {
  constructor(config) {
    this.config = config;
  }

  static async create(configPath) {
    return new BridgeClient(await loadConfig(configPath));
  }

  http(path, {
    method = "GET",
    body,
    timeoutMs = this.config.commandTimeoutMs + 5000,
    signal
  } = {}) {
    return new Promise((resolve, reject) => {
      const boundedTimeoutMs = Math.min(305000, Math.max(1, Number(timeoutMs) || 0));
      let settled = false;
      let request;
      let totalTimer;
      const onAbort = () => request?.destroy(new Error("Bridge request aborted"));
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        signal?.removeEventListener?.("abort", onAbort);
        callback(value);
      };
      if (signal?.aborted) {
        finish(reject, new Error("Bridge request aborted"));
        return;
      }
      try {
        request = httpRequest({
          host: this.config.host,
          port: this.config.port,
          path,
          method,
          timeout: boundedTimeoutMs,
          headers: {
            authorization: `Bearer ${this.config.secret}`,
            ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {})
          }
        }, (response) => {
          let responseBody = "";
          let responseBytes = 0;
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            responseBytes += Buffer.byteLength(chunk);
            if (responseBytes > 4 * 1024 * 1024) {
              request.destroy(new Error("Bridge response is too large"));
              return;
            }
            responseBody += chunk;
          });
          response.on("end", () => {
            try {
              const payload = JSON.parse(responseBody);
              if (!payload.ok) finish(reject, new Error(payload.error || `Bridge HTTP ${response.statusCode}`));
              else finish(resolve, payload);
            } catch (error) { finish(reject, error); }
          });
        });
      } catch (error) {
        finish(reject, error);
        return;
      }
      totalTimer = setTimeout(
        () => request.destroy(new Error("Bridge request total deadline expired")),
        boundedTimeoutMs
      );
      request.on("error", (error) => finish(reject, error));
      request.on("timeout", () => request.destroy(new Error("Bridge request timed out")));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (body) request.write(body);
      request.end();
    });
  }
  health(options = {}) { return this.http("/health", options); }
  async list(options = {}) { return (await this.health(options)).profiles; }
  async issueBootstrapToken({ profileName, extensionId, buildId, profileDirectory }, options = {}) {
    const payload = await this.http("/bootstrap-token", {
      ...options,
      method: "POST",
      body: JSON.stringify({ profileName, extensionId, buildId, profileDirectory })
    });
    return { attemptId: payload.attemptId, token: payload.token };
  }
  async bootstrapStatus(attemptId, options = {}) {
    const payload = await this.http("/bootstrap-status", {
      ...options,
      method: "POST",
      body: JSON.stringify({ attemptId })
    });
    return payload.receipt;
  }
  async cancelBootstrap(attemptId, options = {}) {
    const payload = await this.http("/bootstrap-cancel", {
      ...options,
      method: "POST",
      body: JSON.stringify({ attemptId })
    });
    return payload.receipt;
  }
  async request(profileName, method, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    const payload = await this.http("/command", {
      method: "POST",
      body: JSON.stringify({ profileName, method, params, timeoutMs }),
      timeoutMs: Math.min(305000, Math.max(1000, Number(timeoutMs) || 0) + 5000)
    });
    return payload.result;
  }
}
