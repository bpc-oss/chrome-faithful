import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  ChromeProfileLaunchError,
  launchChromeProfile,
  publicChromeProfileCatalog,
  readAgentOsExtensionBinding,
  readChromeProfileCatalog,
  resolveChromeProfile
} from "../src/chrome-profile-launcher.mjs";

const localState = JSON.stringify({
  profile: {
    info_cache: {
      Default: { name: "Personal", gaia_name: "Person One", user_name: "one@example.test" },
      "Profile 3": { name: "Publishing", gaia_name: "Person Two", user_name: "two@example.test" }
    }
  }
});

const windowsDependencies = {
  platform: "win32",
  env: {
    LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
    PROGRAMFILES: "C:\\Program Files"
  },
  readFile: async () => localState
};

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const buildId = "test-build";
const extensionManifest = JSON.stringify({
  manifest_version: 3,
  name: "Agent OS Chrome CDP",
  version: "0.3.0",
  version_name: buildId,
  permissions: ["debugger", "storage", "offscreen"],
  background: { service_worker: "service-worker.js", type: "module" },
  options_ui: { page: "options.html" }
});
const securePreferences = JSON.stringify({
  extensions: {
    settings: {
      [extensionId]: {
        location: 4,
        path: "C:\\AgentOS\\ChromeCDP\\Extension"
      }
    }
  }
});

async function launchReadFile(filePath) {
  if (filePath.endsWith("Local State")) return localState;
  if (filePath.endsWith("Secure Preferences")) return securePreferences;
  if (filePath.endsWith("Preferences")) return JSON.stringify({ extensions: { settings: {} } });
  if (filePath.endsWith("manifest.json")) return extensionManifest;
  throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
}

const launchDependencies = {
  ...windowsDependencies,
  readFile: launchReadFile,
  realpath: async (filePath) => filePath
};
const trustedLauncherConfig = {
  port: 18755,
  chromeProfileLauncher: {
    extensionId,
    extensionPath: "C:\\AgentOS\\ChromeCDP\\Extension"
  }
};

test("reads local Chrome profile identities for internal exact resolution", async () => {
  const catalog = await readChromeProfileCatalog({}, windowsDependencies);
  assert.equal(
    catalog.userDataDir,
    "C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\User Data"
  );
  assert.deepEqual(catalog.profiles, [
    { directory: "Default", displayName: "Personal", gaiaName: "Person One", userName: "one@example.test" },
    { directory: "Profile 3", displayName: "Publishing", gaiaName: "Person Two", userName: "two@example.test" }
  ]);
});

test("public profile catalog exposes only directory and display name", async () => {
  const catalog = await readChromeProfileCatalog({}, windowsDependencies);
  assert.deepEqual(publicChromeProfileCatalog(catalog), {
    profiles: [
      { directory: "Default", displayName: "Personal" },
      { directory: "Profile 3", displayName: "Publishing" }
    ]
  });
});

test("resolves exact display, directory, account names, and trusted overrides", () => {
  const catalog = {
    profiles: [
      { directory: "Default", displayName: "Personal", gaiaName: "Person One", userName: "one@example.test" },
      { directory: "Profile 3", displayName: "Publishing", gaiaName: "Person Two", userName: "two@example.test" }
    ]
  };
  assert.equal(resolveChromeProfile(catalog, "Publishing").directory, "Profile 3");
  assert.equal(resolveChromeProfile(catalog, "two@example.test").directory, "Profile 3");
  assert.equal(resolveChromeProfile(catalog, "Profile 3").expectedMetadataProfileName, "Publishing");
  assert.equal(resolveChromeProfile(catalog, "work", {
    chromeProfileLauncher: { profileDirectoryOverrides: { work: "Profile 3" } }
  }).directory, "Profile 3");
});

test("directory resolution rejects duplicate metadata names without a unique per-directory override", () => {
  const catalog = {
    profiles: [
      { directory: "Profile 1", displayName: "Same", gaiaName: "First", userName: "first@example.test" },
      { directory: "Profile 2", displayName: "Same", gaiaName: "Second", userName: "second@example.test" }
    ]
  };
  assert.throws(
    () => resolveChromeProfile(catalog, "Profile 1"),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_METADATA_PROFILE_AMBIGUOUS"
  );
  const config = {
    chromeProfileLauncher: {
      extensionProfileNameOverrides: { "Profile 1": "Unique Profile One" }
    }
  };
  assert.equal(
    resolveChromeProfile(catalog, "Profile 1", config).expectedMetadataProfileName,
    "Unique Profile One"
  );
  assert.throws(
    () => resolveChromeProfile(catalog, "Profile 2", config),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_METADATA_PROFILE_AMBIGUOUS"
  );
  assert.throws(
    () => resolveChromeProfile(catalog, "Profile 1", {
      chromeProfileLauncher: { extensionProfileNameOverrides: { "Profile 1": 123 } }
    }),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "INVALID_EXTENSION_PROFILE_NAME_OVERRIDE"
  );
});

test("rejects ambiguous profile names before launching", () => {
  const catalog = {
    profiles: [
      { directory: "Profile 1", displayName: "Same", gaiaName: "" },
      { directory: "Profile 2", displayName: "Same", gaiaName: "" }
    ]
  };
  assert.throws(
    () => resolveChromeProfile(catalog, "Same"),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_PROFILE_AMBIGUOUS"
  );
});

test("finds exactly one unpacked Agent OS extension in only the resolved profile", async () => {
  const catalog = await readChromeProfileCatalog({}, launchDependencies);
  const profile = resolveChromeProfile(catalog, "Profile 3");
  const binding = await readAgentOsExtensionBinding(
    catalog,
    profile,
    trustedLauncherConfig,
    launchDependencies
  );
  assert.deepEqual(binding, { extensionId, buildId });
});

test("trusted extension manifest requires a non-empty bounded version_name build ID", async () => {
  const catalog = await readChromeProfileCatalog({}, launchDependencies);
  const profile = resolveChromeProfile(catalog, "Profile 3");
  for (const versionName of [undefined, 123, "x".repeat(129)]) {
    const legacyManifest = JSON.parse(extensionManifest);
    if (versionName === undefined) delete legacyManifest.version_name;
    else legacyManifest.version_name = versionName;
    await assert.rejects(
      () => readAgentOsExtensionBinding(
        catalog,
        profile,
        trustedLauncherConfig,
        {
          ...launchDependencies,
          readFile: async (filePath) => filePath.endsWith("manifest.json")
            ? JSON.stringify(legacyManifest)
            : launchReadFile(filePath)
        }
      ),
      (error) => error instanceof ChromeProfileLaunchError
        && error.code === "CHROME_EXTENSION_MANIFEST_INVALID"
    );
  }
});

test("a correctly connected profile still requires a fresh verified bootstrap attempt", async () => {
  let issued = false;
  let spawned = false;
  const result = await launchChromeProfile({
    router: {
      issueBootstrapToken: async (binding) => {
        issued = true;
        assert.deepEqual(binding, {
          profileName: "Publishing",
          extensionId,
          buildId,
          profileDirectory: "Profile 3"
        });
        return { attemptId: "00000000-0000-4000-8000-000000000010", token: "e".repeat(43) };
      },
      bootstrapStatus: async (attemptId) => ({
        attemptId,
        profileName: "Publishing",
        extensionId,
        buildId,
        bindingVerified: true,
        verifiedProfileDirectory: "Profile 3",
        state: "REGISTERED"
      }),
      list: async () => [{
        profileName: "Publishing",
        extensionId,
        buildId,
        bindingVerified: true,
        verifiedProfileDirectory: "Profile 3",
        version: "0.3.0"
      }],
      cancelBootstrap: async () => { throw new Error("must not cancel registered bootstrap"); }
    },
    config: trustedLauncherConfig,
    profileName: "Profile 3"
  }, {
    ...launchDependencies,
    access: async () => {},
    spawn: () => { spawned = true; return { unref() {} }; }
  });
  assert.equal(result.alreadyConnected, false);
  assert.equal(issued, true);
  assert.equal(spawned, true);
  assert.equal(result.connectedProfile.verifiedProfileDirectory, "Profile 3");
});

test("a Default profile self-reporting Baoping cannot satisfy a Profile 3 launch", async () => {
  let issued = false;
  let spawned = false;
  let listCalls = 0;
  const genericDefaultConnection = {
    profileName: "Baoping",
    extensionId,
    buildId,
    bindingVerified: false,
    verifiedProfileDirectory: null,
    version: "0.3.0"
  };
  const exactProfile3Connection = {
    profileName: "Baoping",
    extensionId,
    buildId,
    bindingVerified: true,
    verifiedProfileDirectory: "Profile 3",
    version: "0.3.0"
  };
  const result = await launchChromeProfile({
    router: {
      list: async () => {
        listCalls += 1;
        return issued
          ? [genericDefaultConnection, exactProfile3Connection]
          : [genericDefaultConnection];
      },
      issueBootstrapToken: async (binding) => {
        issued = true;
        assert.deepEqual(binding, {
          profileName: "Baoping",
          extensionId,
          buildId,
          profileDirectory: "Profile 3"
        });
        return { attemptId: "00000000-0000-4000-8000-000000000013", token: "h".repeat(43) };
      },
      bootstrapStatus: async (currentAttemptId) => ({
        attemptId: currentAttemptId,
        profileName: "Baoping",
        extensionId,
        buildId,
        bindingVerified: true,
        verifiedProfileDirectory: "Profile 3",
        state: "REGISTERED"
      }),
      cancelBootstrap: async () => { throw new Error("must not cancel registered bootstrap"); }
    },
    config: {
      ...trustedLauncherConfig,
      chromeProfileLauncher: {
        ...trustedLauncherConfig.chromeProfileLauncher,
        extensionProfileNameOverrides: { "Profile 3": "Baoping" }
      }
    },
    profileName: "Profile 3"
  }, {
    ...launchDependencies,
    access: async () => {},
    spawn: () => { spawned = true; return { unref() {} }; }
  });

  assert.equal(issued, true);
  assert.equal(spawned, true);
  assert.equal(listCalls, 1);
  assert.equal(result.alreadyConnected, false);
  assert.equal(result.connectedProfile.bindingVerified, true);
  assert.equal(result.connectedProfile.verifiedProfileDirectory, "Profile 3");
});

test("duplicate display metadata cannot take the already-connected path for a directory request", async () => {
  const duplicateState = JSON.stringify({
    profile: {
      info_cache: {
        "Profile 2": { name: "Publishing", gaia_name: "One", user_name: "one@example.test" },
        "Profile 3": { name: "Publishing", gaia_name: "Two", user_name: "two@example.test" }
      }
    }
  });
  let listCalls = 0;
  let spawned = false;
  await assert.rejects(
    () => launchChromeProfile({
      router: {
        list: async () => {
          listCalls += 1;
          return [{ profileName: "Publishing", extensionId, buildId, version: "0.3.0" }];
        }
      },
      config: trustedLauncherConfig,
      profileName: "Profile 3"
    }, {
      ...launchDependencies,
      readFile: async (filePath) => filePath.endsWith("Local State")
        ? duplicateState
        : launchReadFile(filePath),
      spawn: () => { spawned = true; return { unref() {} }; }
    }),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_METADATA_PROFILE_AMBIGUOUS"
  );
  assert.equal(listCalls, 0);
  assert.equal(spawned, false);
});

test("launches only ordinary Chrome arguments and waits for exact registration", async () => {
  let polls = 0;
  let spawnCall;
  let now = 100;
  const router = {
    issueBootstrapToken: async (binding) => {
      assert.deepEqual(binding, {
        profileName: "Publishing",
        extensionId,
        buildId,
        profileDirectory: "Profile 3"
      });
      return {
        attemptId: "00000000-0000-4000-8000-000000000001",
        token: "a".repeat(43)
      };
    },
    list: async () => polls >= 3
      ? [{
          profileName: "Publishing",
          extensionId,
          buildId,
          bindingVerified: true,
          verifiedProfileDirectory: "Profile 3",
          version: "0.3.0"
        }]
      : [],
    bootstrapStatus: async (attemptId) => {
      assert.equal(attemptId, "00000000-0000-4000-8000-000000000001");
      polls += 1;
      return {
        attemptId,
        profileName: "Publishing",
        extensionId,
        buildId,
        bindingVerified: polls >= 3,
        verifiedProfileDirectory: polls >= 3 ? "Profile 3" : null,
        state: polls >= 3 ? "REGISTERED" : "GRANT_ISSUED"
      };
    },
    cancelBootstrap: async () => { throw new Error("must not cancel registered bootstrap"); }
  };
  const result = await launchChromeProfile({
    router,
    config: trustedLauncherConfig,
    profileName: "Profile 3",
    timeoutMs: 5000
  }, {
    ...launchDependencies,
    access: async () => {},
    spawn: (executable, args, options) => {
      spawnCall = { executable, args, options };
      return { unref() {} };
    },
    sleep: async () => { now += 250; },
    now: () => now
  });
  assert.equal(result.connectedProfile.profileName, "Publishing");
  assert.equal(result.connectedProfile.buildId, buildId);
  assert.equal(result.connectedProfile.bindingVerified, true);
  assert.equal(result.connectedProfile.verifiedProfileDirectory, "Profile 3");
  assert.equal(spawnCall.args[0], "--profile-directory=Profile 3");
  assert.match(
    spawnCall.args[1],
    new RegExp(`^chrome-extension://${extensionId}/options\\.html#port=18755&bootstrap=`)
  );
  assert.equal(spawnCall.args.includes("about:blank"), false);
  assert.equal(spawnCall.args.some((arg) => arg.includes("remote-debugging")), false);
  assert.deepEqual(spawnCall.options, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  assert.equal(JSON.stringify(result).includes("a".repeat(43)), false);
  assert.equal(JSON.stringify(result).includes("bootstrap"), false);
});

test("fails closed when the extension does not register", async () => {
  let now = 0;
  let cancelled = false;
  await assert.rejects(
    () => launchChromeProfile({
      router: {
        list: async () => [],
        issueBootstrapToken: async () => ({
          attemptId: "00000000-0000-4000-8000-000000000002",
          token: "b".repeat(43)
        }),
        bootstrapStatus: async (attemptId) => ({
          attemptId,
          profileName: "Publishing",
          extensionId,
          buildId,
          state: "GRANT_ISSUED"
        }),
        cancelBootstrap: async () => { cancelled = true; }
      },
      config: trustedLauncherConfig,
      profileName: "Publishing",
      timeoutMs: 1000
    }, {
      ...launchDependencies,
      access: async () => {},
      spawn: () => ({ unref() {} }),
      sleep: async () => { now += 250; },
      now: () => now
    }),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_PROFILE_REGISTRATION_TIMEOUT"
  );
  assert.equal(cancelled, true);
});

test("fails closed before launch when the target profile lacks the Agent OS extension", async () => {
  let spawned = false;
  await assert.rejects(
    () => launchChromeProfile({
      router: { list: async () => [] },
      config: trustedLauncherConfig,
      profileName: "Publishing"
    }, {
      ...launchDependencies,
      readFile: async (filePath) => {
        if (filePath.endsWith("Local State")) return localState;
        if (filePath.endsWith("manifest.json")) return extensionManifest;
        return JSON.stringify({ extensions: { settings: {} } });
      },
      realpath: async (filePath) => filePath,
      access: async () => {},
      spawn: () => { spawned = true; return { unref() {} }; }
    }),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_EXTENSION_NOT_FOUND"
  );
  assert.equal(spawned, false);
});

test("a conflicting same-name live placeholder cannot satisfy the new bootstrap attempt", async () => {
  let cancelled = false;
  await assert.rejects(
    () => launchChromeProfile({
      router: {
        issueBootstrapToken: async () => ({
          attemptId: "00000000-0000-4000-8000-000000000011",
          token: "f".repeat(43)
        }),
        bootstrapStatus: async (attemptId) => ({
          attemptId,
          profileName: "Publishing",
          extensionId,
          buildId,
          bindingVerified: false,
          verifiedProfileDirectory: null,
          state: "FAILED",
          failureCode: "BOOTSTRAP_ROUTER_REJECTED"
        }),
        list: async () => { throw new Error("must not borrow the placeholder"); },
        cancelBootstrap: async () => { cancelled = true; }
      },
      config: trustedLauncherConfig,
      profileName: "Publishing"
    }, {
      ...launchDependencies,
      access: async () => {},
      spawn: () => ({ unref() {} })
    }),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_BOOTSTRAP_REGISTRATION_REJECTED"
      && error.details.failureCode === "BOOTSTRAP_ROUTER_REJECTED"
  );
  assert.equal(cancelled, true);
});

test("rejects a registered receipt for a different verified profile directory", async () => {
  await assert.rejects(
    () => launchChromeProfile({
      router: {
        issueBootstrapToken: async () => ({
          attemptId: "00000000-0000-4000-8000-000000000012",
          token: "g".repeat(43)
        }),
        bootstrapStatus: async (attemptId) => ({
          attemptId,
          profileName: "Publishing",
          extensionId,
          buildId,
          bindingVerified: true,
          verifiedProfileDirectory: "Default",
          state: "REGISTERED"
        }),
        list: async () => { throw new Error("must reject receipt before listing"); },
        cancelBootstrap: async () => {}
      },
      config: trustedLauncherConfig,
      profileName: "Publishing"
    }, {
      ...launchDependencies,
      access: async () => {},
      spawn: () => ({ unref() {} })
    }),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_BOOTSTRAP_DIRECTORY_MISMATCH"
  );
});

test("rejects a stale registered receipt after the exact extension connection disconnects", async () => {
  let listCalls = 0;
  let cancelled = false;
  await assert.rejects(
    () => launchChromeProfile({
      router: {
        list: async () => {
          listCalls += 1;
          return [];
        },
        issueBootstrapToken: async (binding) => {
          assert.deepEqual(binding, {
            profileName: "Publishing",
            extensionId,
            buildId,
            profileDirectory: "Profile 3"
          });
          return {
            attemptId: "00000000-0000-4000-8000-000000000004",
            token: "d".repeat(43)
          };
        },
        bootstrapStatus: async (attemptId) => ({
          attemptId,
          profileName: "Publishing",
          extensionId,
          buildId,
          bindingVerified: true,
          verifiedProfileDirectory: "Profile 3",
          state: "REGISTERED"
        }),
        cancelBootstrap: async () => { cancelled = true; }
      },
      config: trustedLauncherConfig,
      profileName: "Publishing",
      timeoutMs: 1000
    }, {
      ...launchDependencies,
      access: async () => {},
      spawn: () => ({ unref() {} })
    }),
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_BOOTSTRAP_CONNECTION_LOST"
  );
  assert.equal(listCalls, 1);
  assert.equal(cancelled, true);
});

test("catalog, binding, and executable local stages share one absolute launch deadline", async () => {
  for (const blockedStage of ["catalog", "binding", "executable"]) {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    let spawned = false;
    let issued = false;
    const dependencies = {
      ...launchDependencies,
      readFile: async (filePath) => {
        if (blockedStage === "catalog" && filePath.endsWith("Local State")) return blocked;
        if (blockedStage === "binding" && filePath.endsWith("Secure Preferences")) return blocked;
        return launchReadFile(filePath);
      },
      access: async () => blockedStage === "executable" ? blocked : undefined,
      spawn: () => { spawned = true; return { unref() {} }; },
      setDeadlineTimeout: (callback) => setImmediate(callback),
      clearDeadlineTimeout: (timer) => clearImmediate(timer)
    };
    await assert.rejects(
      () => launchChromeProfile({
        router: {
          issueBootstrapToken: async () => {
            issued = true;
            return { attemptId: "never", token: "never" };
          },
          bootstrapStatus: async () => { throw new Error("must not poll"); },
          cancelBootstrap: async () => {}
        },
        config: trustedLauncherConfig,
        profileName: "Profile 3",
        timeoutMs: 1000
      }, dependencies),
      (error) => error instanceof ChromeProfileLaunchError
        && error.code === "CHROME_PROFILE_REGISTRATION_TIMEOUT"
    );
    release(blockedStage === "catalog"
      ? localState
      : blockedStage === "binding"
        ? securePreferences
        : undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(issued, false, `${blockedStage} must not issue after its deadline`);
    assert.equal(spawned, false, `${blockedStage} must not spawn after its deadline`);
  }
});

test("converts asynchronous child-process errors without leaking bootstrap arguments", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  let cancelled = false;
  const launch = launchChromeProfile({
    router: {
      list: async () => [],
      issueBootstrapToken: async () => ({
        attemptId: "00000000-0000-4000-8000-000000000003",
        token: "c".repeat(43)
      }),
      bootstrapStatus: async () => { throw new Error("must not poll"); },
      cancelBootstrap: async () => { cancelled = true; }
    },
    config: trustedLauncherConfig,
    profileName: "Publishing"
  }, {
    ...launchDependencies,
    access: async () => {},
    spawn: () => {
      queueMicrotask(() => child.emit("error", new Error(`failed ${"c".repeat(43)}`)));
      return child;
    }
  });
  await assert.rejects(
    () => launch,
    (error) => error instanceof ChromeProfileLaunchError
      && error.code === "CHROME_LAUNCH_FAILED"
      && !error.message.includes("c".repeat(43))
  );
  assert.equal(cancelled, true);
});
