[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$testId = [Guid]::NewGuid().ToString('N')
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) "agentos-chrome-cdp-installer-$testId"
$fixturePlugin = Join-Path $fixtureRoot 'plugin'
$actualLocalAppData = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::LocalApplicationData
)
$actualUserProfile = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::UserProfile
)
$privateTestRoot = Join-Path $actualLocalAppData "AgentOS\installer-tests\$testId"
$isolatedLocalAppData = Join-Path $privateTestRoot 'localappdata'
$fixtureUser = Join-Path $fixtureRoot 'user'
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "ASSERTION_FAILED: $Message" }
}

function Get-TreeDigest {
  param([Parameter(Mandatory)][string]$Root)
  return (@(
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
      Sort-Object FullName |
      ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\')
        "$relative|$($_.Length)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
      }
  ) -join "`n")
}

function Invoke-JsonScript {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][hashtable]$Arguments)
  $output = @(& $Path @Arguments)
  return (($output -join "`n") | ConvertFrom-Json)
}

function Write-JsonFile {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][object]$Value)
  $parent = Split-Path -Parent $Path
  [void](New-Item -ItemType Directory -Force -Path $parent)
  [IO.File]::WriteAllText(
    $Path,
    (($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine),
    $utf8NoBom
  )
}

function Get-OptionalFileState {
  param([Parameter(Mandatory)][string]$Path)
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    return "present:$((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash)"
  }
  return 'absent'
}

function Get-Port18755State {
  $command = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    $listeners = @(Get-NetTCPConnection -LocalPort 18755 -State Listen -ErrorAction SilentlyContinue |
      Sort-Object LocalAddress, LocalPort, OwningProcess |
      ForEach-Object {
        "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)"
      })
    if ($listeners.Count -eq 0) { return 'absent' }
    return ($listeners -join ';')
  }
  $listeners = @(
    [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
      Where-Object { $_.Port -eq 18755 } |
      Sort-Object Address, Port |
      ForEach-Object { "$($_.Address)|$($_.Port)" }
  )
  if ($listeners.Count -eq 0) { return 'absent' }
  return ($listeners -join ';')
}

$productionPaths = [ordered]@{
  private_config = Join-Path $actualLocalAppData 'AgentOS\agentos-chrome-cdp\config.json'
  codebuddy = Join-Path $actualUserProfile '.codebuddy\mcp.json'
  workbuddy = Join-Path $actualUserProfile '.workbuddy\mcp.json'
  claude_desktop = Join-Path $actualLocalAppData 'Claude-3p\claude_desktop_config.json'
}

function Get-ProductionGuardState {
  $files = [ordered]@{}
  foreach ($name in $productionPaths.Keys) {
    $files[$name] = Get-OptionalFileState -Path ([string]$productionPaths[$name])
  }
  return [pscustomobject][ordered]@{
    files = [pscustomobject]$files
    port_18755 = Get-Port18755State
  }
}

$productionGuardBefore = Get-ProductionGuardState
$productionGuardBeforeJson = $productionGuardBefore | ConvertTo-Json -Depth 5 -Compress

try {
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $fixturePlugin 'scripts'))
  [void](New-Item -ItemType Directory -Force -Path (Join-Path $fixturePlugin 'src'))
  [void](New-Item -ItemType Directory -Force -Path (
    Join-Path $fixturePlugin 'node_modules\@modelcontextprotocol\sdk'
  ))
  [void](New-Item -ItemType Directory -Force -Path $fixtureUser)
  Copy-Item -LiteralPath (Join-Path $pluginRoot 'extension') `
    -Destination (Join-Path $fixturePlugin 'extension') -Recurse
  Copy-Item -LiteralPath (Join-Path $pluginRoot 'scripts\Private-Storage.psm1') `
    -Destination (Join-Path $fixturePlugin 'scripts\Private-Storage.psm1')
  [IO.File]::WriteAllText(
    (Join-Path $fixturePlugin 'src\mcp-server.mjs'),
    "export {};`n",
    $utf8NoBom
  )
  [IO.File]::WriteAllText(
    (Join-Path $fixturePlugin 'node_modules\@modelcontextprotocol\sdk\package.json'),
    "{}`n",
    $utf8NoBom
  )

  $extensionInstaller = Join-Path $fixturePlugin 'scripts\Install-AgentOsChromeExtension.ps1'
  $clientInstaller = Join-Path $fixturePlugin 'scripts\Install-AgentOsChromeCdp.ps1'
  Copy-Item -LiteralPath (Join-Path $pluginRoot 'scripts\Install-AgentOsChromeExtension.ps1') `
    -Destination $extensionInstaller
  Copy-Item -LiteralPath (Join-Path $pluginRoot 'scripts\Install-AgentOsChromeCdp.ps1') `
    -Destination $clientInstaller

  # Extension apply and trusted restore operate only on this fixture target.
  $extensionTarget = Join-Path $fixtureRoot 'loaded-extension'
  Copy-Item -LiteralPath (Join-Path $fixturePlugin 'extension') `
    -Destination $extensionTarget -Recurse
  [IO.File]::AppendAllText(
    (Join-Path $extensionTarget 'options.html'),
    "`n<!-- fixture preimage -->`n",
    $utf8NoBom
  )
  [IO.File]::WriteAllText(
    (Join-Path $extensionTarget 'old-only.txt'),
    "fixture preimage`n",
    $utf8NoBom
  )
  $extensionPreimage = Get-TreeDigest -Root $extensionTarget
  $extensionApply = Invoke-JsonScript -Path $extensionInstaller -Arguments @{
    Target = $extensionTarget
    LocalAppDataRoot = $isolatedLocalAppData
    Apply = $true
  }
  Assert-True ($extensionApply.status -eq 'APPLIED') 'extension apply status'
  Assert-True ($extensionApply.exact_mirror -eq $true) 'extension exact-mirror evidence'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $extensionTarget 'old-only.txt'))) `
    'extension apply removes stale files'
  Assert-True (Test-Path -LiteralPath $extensionApply.backup -PathType Container) `
    'extension apply emits a backup'
  $sourceDigest = Get-TreeDigest -Root (Join-Path $fixturePlugin 'extension')
  Assert-True ((Get-TreeDigest -Root $extensionTarget) -eq $sourceDigest) `
    'extension target matches the source after apply'

  $extensionRestore = Invoke-JsonScript -Path $extensionInstaller -Arguments @{
    Target = $extensionTarget
    LocalAppDataRoot = $isolatedLocalAppData
    RestoreBackup = [string]$extensionApply.backup
    Apply = $true
  }
  Assert-True ($extensionRestore.status -eq 'RESTORED') 'extension restore status'
  Assert-True ((Get-TreeDigest -Root $extensionTarget) -eq $extensionPreimage) `
    'extension restore reproduces the exact preimage'

  $outsideBackup = Join-Path $fixtureRoot 'untrusted-backup-copy'
  Copy-Item -LiteralPath ([string]$extensionApply.backup) -Destination $outsideBackup -Recurse
  $outsideRejected = $false
  try {
    [void](Invoke-JsonScript -Path $extensionInstaller -Arguments @{
      Target = $extensionTarget
      LocalAppDataRoot = $isolatedLocalAppData
      RestoreBackup = $outsideBackup
      Apply = $true
    })
  } catch {
    $outsideRejected = $_.Exception.Message -match 'child of the protected'
  }
  Assert-True $outsideRejected 'extension restore rejects out-of-root backups'
  Assert-True ((Get-TreeDigest -Root $extensionTarget) -eq $extensionPreimage) `
    'rejected extension restore leaves the target unchanged'

  # Client migration validates two explicit profile bindings and includes absent targets.
  $extensionId = 'acpdilpmejkpejmahfgcmfeohggllkoh'
  $chromeUserData = Join-Path $fixtureRoot 'Chrome User Data'
  foreach ($profileDirectory in @('Default', 'Profile 3')) {
    $settings = [pscustomobject]@{}
    $settings | Add-Member -MemberType NoteProperty -Name $extensionId -Value (
      [pscustomobject][ordered]@{
        location = 4
        path = $extensionTarget
      }
    )
    Write-JsonFile -Path (Join-Path (
      Join-Path $chromeUserData $profileDirectory
    ) 'Secure Preferences') -Value ([pscustomobject][ordered]@{
      extensions = [pscustomobject][ordered]@{
        settings = $settings
      }
    })
  }

  $codeBuddyPath = Join-Path $fixtureUser '.codebuddy\mcp.json'
  $workBuddyPath = Join-Path $fixtureUser '.workbuddy\mcp.json'
  Write-JsonFile -Path $codeBuddyPath -Value ([pscustomobject][ordered]@{
    mcpServers = [pscustomobject][ordered]@{
      preserved = [pscustomobject][ordered]@{ command = 'preserve-me' }
    }
  })
  Assert-True (-not (Test-Path -LiteralPath $workBuddyPath)) `
    'WorkBuddy fixture begins absent'
  $privateConfigPath = Join-Path $isolatedLocalAppData 'AgentOS\agentos-chrome-cdp\config.json'
  $secretBytes = New-Object byte[] 32
  for ($index = 0; $index -lt $secretBytes.Length; $index++) {
    $secretBytes[$index] = [byte]($index + 1)
  }
  try {
    Write-JsonFile -Path $privateConfigPath -Value ([pscustomobject][ordered]@{
      host = '127.0.0.1'
      port = 18755
      secret = [Convert]::ToBase64String($secretBytes)
      commandTimeoutMs = 60000
      profileAliases = [pscustomobject]@{}
      chromeProfileLauncher = [pscustomobject][ordered]@{
        extensionId = $extensionId
        extensionPath = $extensionTarget
      }
    })
  } finally {
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
  }
  $codeBuddyPreimage = Get-FileHash -LiteralPath $codeBuddyPath -Algorithm SHA256
  $privateConfigPreimage = Get-FileHash -LiteralPath $privateConfigPath -Algorithm SHA256
  $claudePath = Join-Path $actualLocalAppData 'Claude-3p\claude_desktop_config.json'
  $claudeBefore = Get-OptionalFileState -Path $claudePath
  $clientArguments = @{
    Clients = @('CodeBuddy', 'WorkBuddy')
    ExtensionId = $extensionId
    ExtensionPath = $extensionTarget
    ChromeProfileDirectories = @('Default', 'Profile 3')
    ChromeUserDataDir = $chromeUserData
    LocalAppDataRoot = $isolatedLocalAppData
    UserProfileRoot = $fixtureUser
    RotateSecret = $true
    Force = $true
  }
  $clientPreview = Invoke-JsonScript -Path $clientInstaller -Arguments $clientArguments
  Assert-True ($clientPreview.status -eq 'PREVIEW') 'client preview status'
  $clientArguments.Apply = $true
  $clientApply = Invoke-JsonScript -Path $clientInstaller -Arguments $clientArguments
  Assert-True ($clientApply.status -eq 'APPLIED') 'client apply status'
  Assert-True (Test-Path -LiteralPath $clientApply.backup_root -PathType Container) `
    'client apply emits a protected backup'
  Assert-True (Test-Path -LiteralPath $workBuddyPath -PathType Leaf) `
    'client apply creates the originally absent target'
  $privateConfigAppliedHash = (
    Get-FileHash -LiteralPath $privateConfigPath -Algorithm SHA256
  ).Hash
  Assert-True ($privateConfigAppliedHash -ne $privateConfigPreimage.Hash) (
    "client apply rotates the private secret; action=$($clientApply.bridge_config_action); " +
    "before=$($privateConfigPreimage.Hash); after=$privateConfigAppliedHash"
  )
  Assert-True ((Get-OptionalFileState -Path $claudePath) -eq $claudeBefore) `
    'unselected Claude Desktop configuration is untouched'

  $clientRestore = Invoke-JsonScript -Path $clientInstaller -Arguments @{
    Clients = @('CodeBuddy', 'WorkBuddy')
    LocalAppDataRoot = $isolatedLocalAppData
    UserProfileRoot = $fixtureUser
    RestoreBackup = [string]$clientApply.backup_root
    Apply = $true
  }
  Assert-True ($clientRestore.status -eq 'RESTORED') 'client restore status'
  Assert-True (Test-Path -LiteralPath $clientRestore.safety_backup -PathType Container) `
    'client restore first captures the current state'
  Assert-True ((Get-FileHash -LiteralPath $codeBuddyPath -Algorithm SHA256).Hash -eq
    $codeBuddyPreimage.Hash) 'client restore reproduces the existing client preimage'
  Assert-True (-not (Test-Path -LiteralPath $workBuddyPath)) `
    'client restore removes a target that was originally absent'
  $absentRollbackArtifacts = @(Get-ChildItem -LiteralPath (Split-Path -Parent $workBuddyPath) `
    -File -Force -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -like '.mcp.json.agentos-absent-rollback-*'
    })
  Assert-True ($absentRollbackArtifacts.Count -eq 0) `
    'successful absent-target restore cleans its transactional rollback file'
  Assert-True ((Get-FileHash -LiteralPath $privateConfigPath -Algorithm SHA256).Hash -eq
    $privateConfigPreimage.Hash) 'client restore reproduces the private config preimage'

  # A read-share-only handle permits planning and backup reads but rejects the
  # WorkBuddy replacement move after PrivateConfig and CodeBuddy have committed.
  Write-JsonFile -Path $workBuddyPath -Value ([pscustomobject][ordered]@{
    mcpServers = [pscustomobject][ordered]@{
      preserved = [pscustomobject][ordered]@{ command = 'locked-preimage' }
    }
  })
  $workBuddyPreimage = Get-FileHash -LiteralPath $workBuddyPath -Algorithm SHA256
  $workBuddyLock = [IO.File]::Open(
    $workBuddyPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $clientFaultFailed = $false
  try {
    [void](Invoke-JsonScript -Path $clientInstaller -Arguments $clientArguments)
  } catch {
    $clientFaultFailed = $_.Exception.Message -match 'rollback=complete'
  } finally {
    $workBuddyLock.Dispose()
  }
  Assert-True $clientFaultFailed 'locked client write reports complete rollback'
  Assert-True ((Get-FileHash -LiteralPath $codeBuddyPath -Algorithm SHA256).Hash -eq
    $codeBuddyPreimage.Hash) 'locked client write restores the existing client'
  Assert-True ((Get-FileHash -LiteralPath $workBuddyPath -Algorithm SHA256).Hash -eq
    $workBuddyPreimage.Hash) 'locked client write preserves its uncommitted target'
  Assert-True ((Get-FileHash -LiteralPath $privateConfigPath -Algorithm SHA256).Hash -eq
    $privateConfigPreimage.Hash) 'locked client write restores the private config'
  Assert-True ((Get-OptionalFileState -Path $claudePath) -eq $claudeBefore) `
    'locked client write leaves Claude Desktop untouched'

  [pscustomobject][ordered]@{
    status = 'PASS'
    extension_apply_restore = $true
    client_apply_restore = $true
    absent_target_restore = $true
    client_fault_rollback = $true
    claude_untouched = $true
    production_guard = 'verified-in-finally'
  } | ConvertTo-Json -Depth 4
} finally {
  try {
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $fixtureFull = [IO.Path]::GetFullPath($fixtureRoot)
    if (
      $fixtureFull.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $fixtureFull) -eq "agentos-chrome-cdp-installer-$testId" -and
      (Test-Path -LiteralPath $fixtureFull)
    ) {
      Remove-Item -LiteralPath $fixtureFull -Recurse -Force
    }
    $privateBase = [IO.Path]::GetFullPath(
      (Join-Path $actualLocalAppData 'AgentOS\installer-tests')
    ).TrimEnd('\') + '\'
    $privateFull = [IO.Path]::GetFullPath($privateTestRoot)
    if (
      $privateFull.StartsWith($privateBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $privateFull) -eq $testId -and
      (Test-Path -LiteralPath $privateFull)
    ) {
      Remove-Item -LiteralPath $privateFull -Recurse -Force
    }
  } finally {
    $productionGuardAfter = Get-ProductionGuardState
    $productionGuardAfterJson = $productionGuardAfter | ConvertTo-Json -Depth 5 -Compress
    if ($productionGuardAfterJson -ne $productionGuardBeforeJson) {
      throw (
        'PRODUCTION_GUARD_DRIFT: real client/private hashes or port 18755 changed; ' +
        'the test did not attempt restoration. before=' + $productionGuardBeforeJson +
        '; after=' + $productionGuardAfterJson
      )
    }
  }
}
