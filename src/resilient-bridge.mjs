import { BridgeClient } from "./bridge-client.mjs";
import { startBridge } from "./bridge-server.mjs";

const TRANSPORT_ERROR = /(?:ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|Bridge request timed out|Bridge request total deadline expired)/i;

function bridgeDeadlineError() {
  const error = new Error("Chrome CDP bridge deadline expired");
  error.code = "BRIDGE_DEADLINE_EXPIRED";
  return error;
}

function bootstrapStateLost(error) {
  const wrapped = new Error("Secure Chrome bootstrap state was lost with the bridge owner");
  wrapped.code = "BOOTSTRAP_STATE_LOST";
  wrapped.cause = error;
  return wrapped;
}

export function isBridgeTransportError(error) {
  return Boolean(
    ["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code)
    || TRANSPORT_ERROR.test(error?.message || String(error))
  );
}

export class ResilientBridgeRouter {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.client = dependencies.client || new BridgeClient(config);
    this.startBridge = dependencies.startBridge || startBridge;
    this.sleep = dependencies.sleep || ((delay) =>
      new Promise((resolve) => setTimeout(resolve, delay)));
    this.now = dependencies.now || Date.now;
    this.electionTimeoutMs = Math.max(
      500,
      Number(dependencies.electionTimeoutMs ?? config.bridgeElectionTimeoutMs ?? 5000)
    );
    this.profileReconnectTimeoutMs = Math.max(
      500,
      Number(
        dependencies.profileReconnectTimeoutMs
        ?? config.profileReconnectTimeoutMs
        ?? 15000
      )
    );
    this.ownedBridge = null;
    this.recoveryPromise = null;
  }

  async initialize() {
    try {
      await this.client.health();
    } catch (error) {
      if (!isBridgeTransportError(error)) throw error;
      await this.recover();
    }
    return this;
  }

  requestOptions(options = {}, fallbackMs = this.config.commandTimeoutMs + 5000) {
    const remaining = options.deadline == null
      ? Number(options.timeoutMs) || fallbackMs
      : options.deadline - this.now();
    if (remaining <= 0) throw bridgeDeadlineError();
    return {
      timeoutMs: Math.min(fallbackMs, remaining),
      ...(options.signal ? { signal: options.signal } : {})
    };
  }

  async withinDeadline(promise, options = {}) {
    if (options.signal?.aborted) throw bridgeDeadlineError();
    if (options.deadline == null) return promise;
    const remaining = options.deadline - this.now();
    if (remaining <= 0) throw bridgeDeadlineError();
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(bridgeDeadlineError()), remaining);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async boundedSleep(delay, options = {}) {
    const remaining = options.deadline == null ? delay : options.deadline - this.now();
    if (remaining <= 0) throw bridgeDeadlineError();
    await this.withinDeadline(this.sleep(Math.min(delay, remaining)), options);
  }

  async boundedClientCall(invoke, options = {}, fallbackMs = this.config.commandTimeoutMs + 5000) {
    const clientOptions = this.requestOptions(options, fallbackMs);
    const deadline = options.deadline ?? (this.now() + clientOptions.timeoutMs);
    return this.withinDeadline(
      Promise.resolve().then(() => invoke(clientOptions)),
      { ...options, deadline }
    );
  }

  async recover(options = {}) {
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.recoverOnce()
        .finally(() => { this.recoveryPromise = null; });
    }
    return this.withinDeadline(this.recoveryPromise, options);
  }

  async recoverOnce() {
    try {
      return await this.client.health({ timeoutMs: this.electionTimeoutMs });
    } catch (error) {
      if (!isBridgeTransportError(error)) throw error;
    }

    let lastError;
    for (let electionRound = 0; electionRound < 2; electionRound += 1) {
      try {
        const bridge = await this.startBridge(this.config);
        this.ownedBridge = bridge;
        return { ok: true, profiles: bridge.router.list(), owner: true };
      } catch (error) {
        if (error?.code !== "EADDRINUSE") throw error;
        lastError = error;
      }

      const deadline = this.now() + this.electionTimeoutMs;
      while (this.now() < deadline) {
        try {
          return await this.client.health({ timeoutMs: Math.max(100, deadline - this.now()) });
        } catch (error) {
          if (!isBridgeTransportError(error)) throw error;
          lastError = error;
          await this.sleep(100);
        }
      }
    }
    throw lastError || new Error("Chrome CDP bridge recovery timed out");
  }

  async health(options = {}) {
    try {
      return await this.boundedClientCall((clientOptions) => this.client.health(clientOptions), options);
    } catch (error) {
      if (!isBridgeTransportError(error)) throw error;
      await this.recover(options);
      return this.boundedClientCall((clientOptions) => this.client.health(clientOptions), options);
    }
  }

  async list(options = {}) {
    try {
      return await this.boundedClientCall((clientOptions) => this.client.list(clientOptions), options);
    } catch (error) {
      if (!isBridgeTransportError(error)) throw error;
      await this.recover(options);
      return this.boundedClientCall((clientOptions) => this.client.list(clientOptions), options);
    }
  }

  async issueBootstrapToken(binding, options = {}) {
    try {
      return await this.boundedClientCall(
        (clientOptions) => this.client.issueBootstrapToken(binding, clientOptions),
        options
      );
    } catch (error) {
      if (isBridgeTransportError(error)) throw bootstrapStateLost(error);
      throw error;
    }
  }

  async bootstrapStatus(attemptId, options = {}) {
    try {
      return await this.boundedClientCall(
        (clientOptions) => this.client.bootstrapStatus(attemptId, clientOptions),
        options
      );
    } catch (error) {
      if (isBridgeTransportError(error)) throw bootstrapStateLost(error);
      throw error;
    }
  }

  async cancelBootstrap(attemptId, options = {}) {
    try {
      return await this.boundedClientCall(
        (clientOptions) => this.client.cancelBootstrap(attemptId, clientOptions),
        options,
        2000
      );
    } catch (error) {
      if (isBridgeTransportError(error)) throw bootstrapStateLost(error);
      throw error;
    }
  }

  async waitForProfile(profileName, timeoutMs = this.profileReconnectTimeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const profiles = await this.withinDeadline(
        this.client.list({ timeoutMs: Math.max(1, deadline - this.now()) }),
        { deadline }
      );
      if (profiles.some((profile) => profile.profileName === profileName)) return;
      await this.sleep(250);
    }
    const error = new Error(
      `Chrome profile did not reconnect after bridge recovery: ${profileName}`
    );
    error.code = "PROFILE_RECONNECT_TIMEOUT";
    throw error;
  }

  async request(profileName, method, params = {}, timeoutMs = this.config.commandTimeoutMs) {
    try {
      return await this.client.request(profileName, method, params, timeoutMs);
    } catch (error) {
      if (!isBridgeTransportError(error)) throw error;
      await this.recover();
      await this.waitForProfile(
        profileName,
        Math.min(this.profileReconnectTimeoutMs, Math.max(500, Number(timeoutMs) || 0))
      );
      return this.client.request(profileName, method, params, timeoutMs);
    }
  }

  async close() {
    const bridge = this.ownedBridge;
    this.ownedBridge = null;
    await bridge?.close();
  }
}

export async function createResilientBridgeRouter(config, dependencies = {}) {
  return new ResilientBridgeRouter(config, dependencies).initialize();
}
