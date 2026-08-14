import test from "node:test";
import assert from "node:assert/strict";
import {
  createResilientBridgeRouter,
  isBridgeTransportError
} from "../src/resilient-bridge.mjs";

function connectionError(code = "ECONNREFUSED") {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:18755`), { code });
}

const config = {
  host: "127.0.0.1",
  port: 18755,
  secret: "test",
  commandTimeoutMs: 1000
};

test("recognizes only bridge transport failures", () => {
  assert.equal(isBridgeTransportError(connectionError()), true);
  assert.equal(isBridgeTransportError(new Error("Chrome profile is not connected")), false);
  assert.equal(isBridgeTransportError(new Error("Chrome command timed out")), false);
});

test("uses an existing healthy bridge without starting another", async () => {
  let starts = 0;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => ({ ok: true, profiles: [] }),
      list: async () => [],
      request: async () => "ok"
    },
    startBridge: async () => { starts += 1; }
  });
  assert.equal(starts, 0);
  assert.deepEqual(await router.list(), []);
});

test("starts the plugin bridge when no owner is reachable", async () => {
  let starts = 0;
  const owned = {
    router: { list: () => [{ profileName: "Profile A" }] },
    close: async () => {}
  };
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => { throw connectionError(); },
      list: async () => [],
      request: async () => "ok"
    },
    startBridge: async () => {
      starts += 1;
      return owned;
    }
  });
  assert.equal(starts, 1);
  assert.equal(router.ownedBridge, owned);
});

test("waits for a concurrent election winner after EADDRINUSE", async () => {
  let healthCalls = 0;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => {
        healthCalls += 1;
        if (healthCalls < 3) throw connectionError();
        return { ok: true, profiles: [] };
      },
      list: async () => [],
      request: async () => "ok"
    },
    startBridge: async () => {
      throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
    },
    sleep: async () => {},
    electionTimeoutMs: 1000
  });
  assert.equal(router.ownedBridge, null);
  assert.equal(healthCalls, 3);
});

test("issues a bootstrap token only through the authenticated bridge client", async () => {
  let received;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => ({ ok: true, profiles: [] }),
      list: async () => [],
      issueBootstrapToken: async (binding) => {
        received = binding;
        return { attemptId: "attempt", token: "one-use-token" };
      },
      bootstrapStatus: async () => ({ state: "REGISTERED" }),
      cancelBootstrap: async () => ({ state: "CANCELLED" }),
      request: async () => "ok"
    },
    startBridge: async () => { throw new Error("must not start"); }
  });
  const binding = {
    profileName: "Profile A",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    buildId: "test-build",
    profileDirectory: "Profile 1"
  };
  assert.deepEqual(await router.issueBootstrapToken(binding), {
    attemptId: "attempt",
    token: "one-use-token"
  });
  assert.deepEqual(received, binding);
  assert.deepEqual(await router.bootstrapStatus("attempt"), { state: "REGISTERED" });
  assert.deepEqual(await router.cancelBootstrap("attempt"), { state: "CANCELLED" });
});

test("does not retry bootstrap issuance after bridge ownership is lost", async () => {
  let issues = 0;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => ({ ok: true, profiles: [] }),
      issueBootstrapToken: async () => {
        issues += 1;
        throw connectionError("ECONNRESET");
      }
    }
  });
  await assert.rejects(
    () => router.issueBootstrapToken({
      profileName: "Profile A",
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      buildId: "test-build",
      profileDirectory: "Profile 1"
    }),
    (error) => error.code === "BOOTSTRAP_STATE_LOST"
  );
  assert.equal(issues, 1);
});

test("list and bootstrap client promises cannot outlive their absolute deadlines", async () => {
  const never = () => new Promise(() => {});
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => ({ ok: true, profiles: [] }),
      list: never,
      issueBootstrapToken: never,
      bootstrapStatus: never
    }
  });
  const deadlineCall = (invoke) => assert.rejects(
    invoke,
    (error) => error.code === "BRIDGE_DEADLINE_EXPIRED"
  );
  await deadlineCall(() => router.list({ deadline: Date.now() + 20 }));
  await deadlineCall(() => router.issueBootstrapToken({
    profileName: "Profile A",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    buildId: "test-build",
    profileDirectory: "Profile 1"
  }, { deadline: Date.now() + 20 }));
  await deadlineCall(() => router.bootstrapStatus("attempt", { deadline: Date.now() + 20 }));
});

test("recovers one failed request, waits for profile registration, and retries once", async () => {
  let requestCalls = 0;
  let healthCalls = 0;
  let starts = 0;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => {
        healthCalls += 1;
        if (healthCalls === 1) return { ok: true, profiles: [] };
        throw connectionError();
      },
      list: async () => [{ profileName: "Profile A" }],
      request: async () => {
        requestCalls += 1;
        if (requestCalls === 1) throw connectionError();
        return "recovered";
      }
    },
    startBridge: async () => {
      starts += 1;
      return {
        router: { list: () => [] },
        close: async () => {}
      };
    },
    sleep: async () => {}
  });
  assert.equal(await router.request("Profile A", "selftest"), "recovered");
  assert.equal(starts, 1);
  assert.equal(requestCalls, 2);
});

test("does not recover or retry non-transport command failures", async () => {
  let starts = 0;
  let requests = 0;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => ({ ok: true, profiles: [] }),
      list: async () => [],
      request: async () => {
        requests += 1;
        throw new Error("Chrome profile is not connected: Profile A");
      }
    },
    startBridge: async () => { starts += 1; }
  });
  await assert.rejects(
    () => router.request("Profile A", "selftest"),
    /Chrome profile is not connected/
  );
  assert.equal(starts, 0);
  assert.equal(requests, 1);
});

test("concurrent failed requests share one bridge election", async () => {
  let starts = 0;
  let healthCalls = 0;
  let requestCalls = 0;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => {
        healthCalls += 1;
        if (healthCalls === 1) return { ok: true, profiles: [] };
        throw connectionError();
      },
      list: async () => [{ profileName: "Profile A" }],
      request: async () => {
        requestCalls += 1;
        if (requestCalls <= 2) throw connectionError();
        return "ok";
      }
    },
    startBridge: async () => {
      starts += 1;
      await Promise.resolve();
      return {
        router: { list: () => [] },
        close: async () => {}
      };
    },
    sleep: async () => {}
  });
  assert.deepEqual(
    await Promise.all([
      router.request("Profile A", "one"),
      router.request("Profile A", "two")
    ]),
    ["ok", "ok"]
  );
  assert.equal(starts, 1);
});

test("shutdown closes only a bridge owned by this router", async () => {
  let closes = 0;
  const router = await createResilientBridgeRouter(config, {
    client: {
      health: async () => { throw connectionError(); },
      list: async () => [],
      request: async () => "ok"
    },
    startBridge: async () => ({
      router: { list: () => [] },
      close: async () => { closes += 1; }
    })
  });
  await router.close();
  await router.close();
  assert.equal(closes, 1);
});
