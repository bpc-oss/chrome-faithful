import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultConfigPath, loadConfig, pluginRoot } from "../src/config.mjs";


const repositoryPluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("default bridge config is under private LocalAppData, not source", () => {
  const localAppData = path.join(os.tmpdir(), "fixture-localappdata");
  const resolved = defaultConfigPath({ LOCALAPPDATA: localAppData });

  assert.equal(
    resolved,
    path.join(localAppData, "AgentOS", "agentos-chrome-cdp", "config.json")
  );
  assert.equal(path.relative(pluginRoot, resolved).startsWith(".."), true);
});

test("loads a valid external config and rejects source-tree config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentos-chrome-config-"));
  const configPath = path.join(directory, "config.json");
  const bridgeCredential = Buffer.alloc(32, 0x42).toString("base64");
  try {
    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port: 18755,
      secret: bridgeCredential,
      commandTimeoutMs: 60000,
      profileAliases: {},
      chromeProfileLauncher: {
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
        extensionPath: path.join(directory, "extension")
      }
    }), "utf8");
    const config = await loadConfig(configPath);
    assert.equal(config.secret, bridgeCredential);
    assert.equal(config.chromeProfileLauncher.extensionId, "abcdefghijklmnopabcdefghijklmnop");
    assert.equal(config.configPath, await realpath(configPath));

    await assert.rejects(
      loadConfig(path.join(repositoryPluginRoot, "config", "local.example.json")),
      /outside the plugin source tree/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config parsing is closed-schema and never reflects raw secret text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentos-chrome-invalid-"));
  const configPath = path.join(directory, "config.json");
  const bridgeCredential = Buffer.alloc(32, 0x43).toString("base64");
  try {
    await writeFile(configPath, `{\"secret\":\"${bridgeCredential}\"`, "utf8");
    await assert.rejects(loadConfig(configPath), (error) => {
      assert.match(error.message, /not valid JSON/);
      assert.equal(error.message.includes(bridgeCredential), false);
      return true;
    });

    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port: 18755,
      secret: bridgeCredential,
      commandTimeoutMs: 60000,
      profileAliases: {},
      unexpectedAuthority: true
    }), "utf8");
    await assert.rejects(loadConfig(configPath), /closed schema checks/);

    await writeFile(configPath, JSON.stringify({
      host: "127.0.0.1",
      port: 18755,
      secret: bridgeCredential,
      commandTimeoutMs: 60000,
      profileAliases: {},
      chromeProfileLauncher: { unexpectedNestedAuthority: true }
    }), "utf8");
    await assert.rejects(loadConfig(configPath), /launcher configuration failed its closed schema/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer contract keeps secrets and backups outside source", async () => {
  const [installer, extensionInstaller, storage, mcpConfig, transactionFixture] = await Promise.all([
    readFile(path.join(repositoryPluginRoot, "scripts", "Install-AgentOsChromeCdp.ps1"), "utf8"),
    readFile(path.join(repositoryPluginRoot, "scripts", "Install-AgentOsChromeExtension.ps1"), "utf8"),
    readFile(path.join(repositoryPluginRoot, "scripts", "Private-Storage.psm1"), "utf8"),
    readFile(path.join(repositoryPluginRoot, ".mcp.json"), "utf8"),
    readFile(path.join(repositoryPluginRoot, "test", "installer-transactions.test.ps1"), "utf8")
  ]);

  assert.match(installer, /LOCALAPPDATA[\s\S]*AgentOS\\agentos-chrome-cdp/);
  assert.match(installer, /Protect-AgentOsBackupFile/);
  assert.match(extensionInstaller, /LOCALAPPDATA[\s\S]*AgentOS\\backups\\agentos-chrome-cdp/);
  assert.match(storage, /ProtectedData\]::Protect/);
  assert.match(storage, /S-1-5-18/);
  assert.match(storage, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(storage, /BLOCKED_PRIVATE_ROOT_OVERLAPS_REPOSITORY/);
  assert.match(storage, /BLOCKED_PRIVATE_ROOT_OUTSIDE_AUTHORIZED_BASE/);
  assert.match(storage, /\$rules\.Count -ne 2/);
  assert.match(installer, /\[string\[\]\]\$Clients = @\('CodeBuddy', 'WorkBuddy'\)/);
  assert.match(installer, /\.codebuddy\\mcp\.json/);
  assert.match(installer, /\.workbuddy\\mcp\.json/);
  assert.match(installer, /\[Guid\]::NewGuid/);
  assert.match(installer, /RotateSecret/);
  assert.match(installer, /LocalAppDataRoot = \$env:LOCALAPPDATA/);
  assert.match(installer, /UserProfileRoot = \$env:USERPROFILE/);
  assert.match(installer, /extensionId[\s\S]*extensionPath/);
  assert.match(installer, /Assert-TrustedUnpackedExtension/);
  assert.match(installer, /Secure Preferences/);
  assert.match(installer, /Read-TrustedConfigurationBackup/);
  assert.match(installer, /New-ProtectedConfigurationBackup/);
  assert.match(installer, /Invoke-TrustedConfigurationRestore/);
  assert.match(installer, /kind = 'agentos-chrome-client-config'/);
  assert.match(installer, /existed = \$false/);
  assert.match(installer, /function Assert-NoReparseAncestors/);
  assert.match(installer, /\[IO\.Directory\]::GetParent/);
  assert.match(installer, /ChromeUserDataDir[\s\S]*Assert-NoReparseAncestors/);
  assert.match(installer, /preimage_existed = \$planExisted/);
  assert.match(installer, /preimage_sha256 = \$planSha256/);
  assert.match(installer, /Protected backup does not match the exact planned preimage/);
  assert.match(installer, /function Assert-PathStateMatches/);
  assert.match(installer, /Write-ConfigAtomic[\s\S]*ExpectedSha256/);
  assert.match(installer, /function Write-PrivateConfigAtomic/);
  assert.match(installer, /final operation before the atomic move/);
  assert.match(installer, /AgentOsConfigWriteCommitted/);
  assert.match(installer, /AgentOsPrivateWriteCommitted/);
  assert.match(installer, /-not \(Test-Path -LiteralPath \$tempPath\)/);
  assert.match(installer, /-not \(Test-Path -LiteralPath \$temporary\)/);
  assert.match(installer, /\$committedPlans/);
  assert.match(installer, /\$committedRestores/);
  assert.match(installer, /function Move-ConfigurationToAbsentRollback/);
  assert.match(installer, /agentos-absent-rollback/);
  assert.match(installer, /AgentOsAbsentRestoreCommitted/);
  assert.match(installer, /Committed absent-state restore, but rollback cleanup failed/);
  assert.match(installer, /rollback target/);
  assert.doesNotMatch(installer, /\$attemptedPlans/);
  assert.doesNotMatch(installer, /\$attempted = @\(\)/);
  assert.match(installer, /if \(-not \$Remove\)/);
  assert.match(installer, /\$privateWriteResult = Write-PrivateConfigAtomic[\s\S]*if \(\$privateWriteResult\.committed\) \{[\s\S]*\$configCreatedThisRun = \$true/);
  assert.match(installer, /AgentOsPrivateWriteCommitted'\] -eq \$true\) \{[\s\S]*\$configCreatedThisRun = \$true/);
  assert.match(installer, /function Write-ConfigAtomic[\s\S]*finally[\s\S]*Remove-Item/);
  assert.doesNotMatch(installer, /Join-Path \$pluginRoot 'config\\local\.json'/);
  assert.doesNotMatch(mcpConfig, /config\\\\local\.json|config\/local\.json/);
  assert.match(extensionInstaller, /New-ExtensionStateBackup[\s\S]*backup-manifest\.json/);
  assert.match(extensionInstaller, /Assert-TreeMatches/);
  assert.match(extensionInstaller, /function Assert-NoReparseAncestors/);
  assert.match(extensionInstaller, /Created extension target parent/);
  assert.match(extensionInstaller, /agentos-stage/);
  assert.match(extensionInstaller, /agentos-rollback/);
  assert.match(extensionInstaller, /RestoreBackup/);
  assert.match(extensionInstaller, /Read-TrustedExtensionBackup/);
  assert.match(extensionInstaller, /kind = 'agentos-chrome-extension-tree'/);
  assert.match(extensionInstaller, /schema_version = 3/);
  assert.match(extensionInstaller, /\$schemaVersion -eq 2/);
  assert.match(extensionInstaller, /existed = \$stateExisted/);
  assert.match(extensionInstaller, /Suffix 'extension-safety'/);
  assert.match(extensionInstaller, /safety_backup = \$safetyBackup\.root/);
  assert.match(extensionInstaller, /Invoke-VerifiedTreeRemoval/);
  assert.match(extensionInstaller, /Extension absent-state restore failed/);
  assert.match(extensionInstaller, /\$preimageMoved = \$false/);
  assert.match(extensionInstaller, /\$replacementInstalled = \$false/);
  assert.match(extensionInstaller, /Move-Item -LiteralPath \$Stage -Destination \$Destination/);
  assert.match(extensionInstaller, /Committed extension update, but rollback cleanup failed/);
  assert.match(storage, /Assert-AgentOsExactPrivateAcl/);
  assert.doesNotMatch(transactionFixture, /\.Replace\(|Invoke-Expression/);
  assert.match(transactionFixture, /LocalAppDataRoot = \$isolatedLocalAppData/);
  assert.match(transactionFixture, /UserProfileRoot = \$fixtureUser/);
  assert.match(transactionFixture, /private_config[\s\S]*codebuddy[\s\S]*workbuddy[\s\S]*claude_desktop/);
  assert.match(transactionFixture, /port_18755 = Get-Port18755State/);
  assert.match(transactionFixture, /PRODUCTION_GUARD_DRIFT/);
  assert.match(transactionFixture, /\[IO\.FileShare\]::Read/);
});
