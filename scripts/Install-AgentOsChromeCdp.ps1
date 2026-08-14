[CmdletBinding()]
param(
  [ValidateSet('ClaudeDesktop', 'WorkBuddy', 'CodeBuddy')]
  [string[]]$Clients = @('CodeBuddy', 'WorkBuddy'),
  [string]$ExtensionId,
  [string]$ExtensionPath,
  [string[]]$ChromeProfileDirectories = @(),
  [string]$ChromeUserDataDir,
  [string]$LocalAppDataRoot = $env:LOCALAPPDATA,
  [string]$UserProfileRoot = $env:USERPROFILE,
  [string]$RestoreBackup,
  [switch]$RotateSecret,
  [switch]$Apply,
  [switch]$Remove,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $pluginRoot 'src\mcp-server.mjs'
$privateStorageModule = Join-Path $PSScriptRoot 'Private-Storage.psm1'
Import-Module -Name $privateStorageModule -Force
if (
  [string]::IsNullOrWhiteSpace($LocalAppDataRoot) -or
  -not [IO.Path]::IsPathRooted($LocalAppDataRoot)
) {
  throw 'LocalAppDataRoot must be an absolute private storage root.'
}
if (
  [string]::IsNullOrWhiteSpace($UserProfileRoot) -or
  -not [IO.Path]::IsPathRooted($UserProfileRoot)
) {
  throw 'UserProfileRoot must be an absolute client configuration root.'
}
$LocalAppDataRoot = [IO.Path]::GetFullPath($LocalAppDataRoot)
$UserProfileRoot = [IO.Path]::GetFullPath($UserProfileRoot)
$configRoot = Join-Path $LocalAppDataRoot 'AgentOS\agentos-chrome-cdp'
$configPath = Join-Path $configRoot 'config.json'
$backupParent = Join-Path $LocalAppDataRoot 'AgentOS\backups\agentos-chrome-cdp'
$packageEntry = Join-Path $pluginRoot 'node_modules\@modelcontextprotocol\sdk\package.json'
$schemaCachebuster = '20260801130514'
$restoreRequested = -not [string]::IsNullOrWhiteSpace($RestoreBackup)
$nodeCommand = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if ([string]::IsNullOrWhiteSpace($nodeCommand)) {
  $nodeCommand = 'node'
}

function Assert-NoReparseAncestors {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
  $full = [IO.Path]::GetFullPath($Path)
  $probe = $full
  while (-not (Test-Path -LiteralPath $probe)) {
    $parent = [IO.Directory]::GetParent($probe)
    if ($null -eq $parent) {
      $probe = [IO.Path]::GetPathRoot($full)
      break
    }
    $probe = $parent.FullName
  }
  while (-not [string]::IsNullOrWhiteSpace($probe)) {
    $item = Get-Item -LiteralPath $probe -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label has a reparse-point ancestor: $($item.FullName)"
    }
    $parent = [IO.Directory]::GetParent($item.FullName)
    if ($null -eq $parent) { break }
    $probe = $parent.FullName
  }
}

function Assert-PathStateMatches {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][bool]$ExpectedExisted,
    [AllowNull()][string]$ExpectedSha256,
    [Parameter(Mandatory)][string]$Label
  )
  Assert-NoReparseAncestors -Path $Path -Label $Label
  if ($ExpectedExisted) {
    if (
      -not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      [string]::IsNullOrWhiteSpace($ExpectedSha256) -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $ExpectedSha256.ToLowerInvariant()
    ) {
      throw "$Label changed after planning."
    }
  } elseif (Test-Path -LiteralPath $Path) {
    throw "$Label appeared after planning."
  }
}

function Get-ByteSha256 {
  param([Parameter(Mandatory)][byte[]]$Bytes)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    return (($hasher.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $hasher.Dispose()
  }
}

Assert-NoReparseAncestors -Path $LocalAppDataRoot -Label 'LocalAppDataRoot'
Assert-NoReparseAncestors -Path $UserProfileRoot -Label 'UserProfileRoot'
Assert-NoReparseAncestors -Path $configPath -Label 'Private bridge configuration'
Assert-NoReparseAncestors -Path $backupParent -Label 'Configuration backup root'
Assert-NoReparseAncestors -Path $serverScript -Label 'MCP server script'

if (-not (Test-Path -LiteralPath $serverScript)) {
  throw "MCP server is missing: $serverScript"
}
if ($Apply -and -not $Remove -and -not $restoreRequested -and -not (Test-Path -LiteralPath $packageEntry)) {
  throw "Dependencies are missing. Review package.json, then run npm install --ignore-scripts in $pluginRoot before applying client configuration."
}
if ($restoreRequested) {
  if (-not $Apply) { throw 'RestoreBackup requires -Apply.' }
  if ($Remove -or $RotateSecret) { throw 'RestoreBackup cannot be combined with Remove or RotateSecret.' }
} elseif (-not $Remove) {
  if ($ExtensionId -notmatch '^[a-p]{32}$') {
    throw 'ExtensionId must be the trusted 32-character Chrome extension ID.'
  }
  if ([string]::IsNullOrWhiteSpace($ExtensionPath) -or -not [IO.Path]::IsPathRooted($ExtensionPath)) {
    throw 'ExtensionPath must be the trusted absolute unpacked extension directory.'
  }
  $ExtensionPath = [IO.Path]::GetFullPath($ExtensionPath)
}

function Assert-TrustedUnpackedExtension {
  param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][string]$Path,
    [string[]]$ProfileDirectories = @(),
    [string]$UserDataDir
  )
  Assert-NoReparseAncestors -Path $Path -Label 'ExtensionPath'
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw 'ExtensionPath must be an existing unpacked extension directory.'
  }
  $items = @((Get-Item -LiteralPath $Path -Force)) + @(
    Get-ChildItem -LiteralPath $Path -Force -Recurse
  )
  if (@($items | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  }).Count -gt 0) {
    throw 'ExtensionPath must not contain reparse points.'
  }
  $manifestPath = Join-Path $Path 'manifest.json'
  Assert-NoReparseAncestors -Path $manifestPath -Label 'Extension manifest'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'ExtensionPath has no manifest.json.'
  }
  try {
    $definition = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw 'ExtensionPath manifest is not valid JSON.'
  }
  $permissions = @($definition.permissions)
  $missingPermissions = @(
    @('debugger', 'storage', 'offscreen') | Where-Object { $_ -notin $permissions }
  ).Count -gt 0
  if (
    $definition.manifest_version -ne 3 -or
    $definition.name -ne 'Agent OS Chrome CDP' -or
    $definition.background.service_worker -ne 'service-worker.js' -or
    $definition.background.type -ne 'module' -or
    $definition.options_ui.page -ne 'options.html' -or
    $missingPermissions
  ) {
    throw 'ExtensionPath manifest contract is invalid.'
  }

  if ($ProfileDirectories.Count -gt 0) {
    if ([string]::IsNullOrWhiteSpace($UserDataDir)) {
      $UserDataDir = Join-Path $LocalAppDataRoot 'Google\Chrome\User Data'
    }
    if (-not [IO.Path]::IsPathRooted($UserDataDir)) {
      throw 'ChromeUserDataDir must be absolute.'
    }
    $UserDataDir = [IO.Path]::GetFullPath($UserDataDir)
    Assert-NoReparseAncestors -Path $UserDataDir -Label 'ChromeUserDataDir'
    foreach ($profileDirectory in $ProfileDirectories) {
      if (
        [string]::IsNullOrWhiteSpace($profileDirectory) -or
        $profileDirectory -eq '.' -or
        $profileDirectory -eq '..' -or
        $profileDirectory.Contains('/') -or
        $profileDirectory.Contains('\') -or
        $profileDirectory.Contains([char]0)
      ) {
        throw 'ChromeProfileDirectories contains an unsafe profile directory.'
      }
      $profilePath = Join-Path $UserDataDir $profileDirectory
      $securePreferences = Join-Path $profilePath 'Secure Preferences'
      Assert-NoReparseAncestors -Path $profilePath -Label "Chrome profile $profileDirectory"
      Assert-NoReparseAncestors -Path $securePreferences -Label "Chrome Secure Preferences $profileDirectory"
      if (-not (Test-Path -LiteralPath $securePreferences -PathType Leaf)) {
        throw "Chrome Secure Preferences is unavailable for profile $profileDirectory."
      }
      try {
        $preferences = [IO.File]::ReadAllText($securePreferences, [Text.Encoding]::UTF8) | ConvertFrom-Json
      } catch {
        throw "Chrome Secure Preferences is invalid for profile $profileDirectory."
      }
      $settings = $null
      if ($null -ne $preferences.extensions) {
        $settings = $preferences.extensions.settings
      }
      $entryProperty = if ($null -eq $settings) {
        $null
      } else {
        $settings.PSObject.Properties[$Id]
      }
      $entry = if ($null -eq $entryProperty) { $null } else { $entryProperty.Value }
      if (
        $null -eq $entry -or
        $entry.location -ne 4 -or
        -not ($entry.path -is [string]) -or
        -not [IO.Path]::IsPathRooted([string]$entry.path)
      ) {
        throw "Trusted extension ID/path does not match profile $profileDirectory."
      }
      $entryPath = [IO.Path]::GetFullPath([string]$entry.path)
      Assert-NoReparseAncestors -Path $entryPath -Label "Trusted extension path $profileDirectory"
      if (-not $entryPath.Equals($Path, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Trusted extension ID/path does not match profile $profileDirectory."
      }
    }
  }
}

if (-not $Remove -and -not $restoreRequested) {
  Assert-TrustedUnpackedExtension `
    -Id $ExtensionId `
    -Path $ExtensionPath `
    -ProfileDirectories $ChromeProfileDirectories `
    -UserDataDir $ChromeUserDataDir
}
function Assert-BridgeConfig {
  param(
    [Parameter(Mandatory)][string]$Path,
    [switch]$AllowMissingTrustedLauncher
  )

  try {
    $config = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw 'Bridge configuration is not valid JSON.'
  }
  $required = @('host', 'port', 'secret', 'commandTimeoutMs', 'profileAliases')
  $allowed = @(
    $required +
    @('bridgeElectionTimeoutMs', 'profileReconnectTimeoutMs', 'chromeProfileLauncher')
  )
  $propertyNames = @($config.PSObject.Properties.Name)
  if (
    @($required | Where-Object { $_ -notin $propertyNames }).Count -gt 0 -or
    @($propertyNames | Where-Object { $_ -notin $allowed }).Count -gt 0
  ) {
    throw 'Bridge configuration failed its closed schema checks.'
  }
  $decodedSecret = $null
  try {
    $decodedSecret = [Convert]::FromBase64String([string]$config.secret)
  } catch {
    throw 'Bridge configuration failed its closed schema checks.'
  }
  $invalidAliases = -not ($config.profileAliases -is [pscustomobject])
  if (-not $invalidAliases) {
    $invalidAliases = @(
      $config.profileAliases.PSObject.Properties |
        Where-Object { -not ($_.Value -is [string]) }
    ).Count -gt 0
  }
  $invalidOptionalTimeout = $false
  foreach ($name in @('bridgeElectionTimeoutMs', 'profileReconnectTimeoutMs')) {
    $property = $config.PSObject.Properties[$name]
    if (
      $null -ne $property -and
      (
        -not ($property.Value -is [int] -or $property.Value -is [long]) -or
        [int]$property.Value -lt 500 -or
        [int]$property.Value -gt 300000
      )
    ) {
      $invalidOptionalTimeout = $true
    }
  }
  $launcherProperty = $config.PSObject.Properties['chromeProfileLauncher']
  $invalidLauncher = (
    $null -ne $launcherProperty -and
    -not ($launcherProperty.Value -is [pscustomobject])
  )
  if (-not $invalidLauncher -and $null -ne $launcherProperty) {
    $launcher = $launcherProperty.Value
    $launcherKeys = @($launcher.PSObject.Properties.Name)
    $allowedLauncherKeys = @(
      'executablePath',
      'userDataDir',
      'profileDirectoryOverrides',
      'extensionProfileNameOverrides',
      'extensionId',
      'extensionIdOverrides',
      'extensionPath',
      'extensionPathOverrides'
    )
    $invalidLauncher = @($launcherKeys | Where-Object { $_ -notin $allowedLauncherKeys }).Count -gt 0
    foreach ($name in @('executablePath', 'userDataDir', 'extensionId', 'extensionPath')) {
      $property = $launcher.PSObject.Properties[$name]
      if ($null -ne $property -and -not ($property.Value -is [string])) {
        $invalidLauncher = $true
      }
    }
    foreach ($name in @(
      'profileDirectoryOverrides',
      'extensionProfileNameOverrides',
      'extensionIdOverrides',
      'extensionPathOverrides'
    )) {
      $property = $launcher.PSObject.Properties[$name]
      if ($null -ne $property) {
        if (-not ($property.Value -is [pscustomobject])) {
          $invalidLauncher = $true
        } elseif (@($property.Value.PSObject.Properties | Where-Object {
          -not ($_.Value -is [string])
        }).Count -gt 0) {
          $invalidLauncher = $true
        }
      }
    }
    if (
      -not $AllowMissingTrustedLauncher -and
      (
        $launcher.extensionId -notmatch '^[a-p]{32}$' -or
        [string]::IsNullOrWhiteSpace([string]$launcher.extensionPath) -or
        -not [IO.Path]::IsPathRooted([string]$launcher.extensionPath)
      )
    ) {
      $invalidLauncher = $true
    }
  } elseif (-not $AllowMissingTrustedLauncher) {
    $invalidLauncher = $true
  }
  try {
    if (
      $config.host -ne '127.0.0.1' -or
      [int]$config.port -lt 1024 -or [int]$config.port -gt 65535 -or
      -not ($config.port -is [int] -or $config.port -is [long]) -or
      -not ($config.secret -is [string]) -or
      $config.secret -notmatch '^[A-Za-z0-9+/]{43}=$' -or
      $decodedSecret.Length -ne 32 -or
      -not ($config.commandTimeoutMs -is [int] -or $config.commandTimeoutMs -is [long]) -or
      [int]$config.commandTimeoutMs -lt 1000 -or
      [int]$config.commandTimeoutMs -gt 300000 -or
      $invalidAliases -or
      $invalidOptionalTimeout -or
      $invalidLauncher
    ) {
      throw 'Bridge configuration failed its closed schema checks.'
    }
  } finally {
    if ($null -ne $decodedSecret) {
      [Array]::Clear($decodedSecret, 0, $decodedSecret.Length)
    }
  }
}

function Get-ClientConfig {
  param([string]$Client)

  switch ($Client) {
    'ClaudeDesktop' {
      # Claude's current Windows custom-3p host reads this LOCALAPPDATA path.
      # Writing only the legacy APPDATA\Claude file can look installed while
      # leaving the live host unchanged.
      return @{
        Name = 'agentos-chrome-cdp'
        Path = Join-Path $LocalAppDataRoot 'Claude-3p\claude_desktop_config.json'
        Entry = [pscustomobject][ordered]@{
          command = $nodeCommand
          args = @($serverScript)
          env = [pscustomobject][ordered]@{
            AGENTOS_CHROME_CONFIG = $configPath
            AGENTOS_CHROME_SCHEMA_CACHEBUSTER = $schemaCachebuster
          }
        }
      }
    }
    'WorkBuddy' {
      return @{
        Name = 'agentos-chrome-cdp-v2'
        Path = Join-Path $UserProfileRoot '.workbuddy\mcp.json'
        Entry = [pscustomobject][ordered]@{
          type = 'stdio'
          command = $nodeCommand
          args = @($serverScript)
          env = [pscustomobject][ordered]@{
            AGENTOS_CHROME_CONFIG = $configPath
            AGENTOS_CHROME_SCHEMA_CACHEBUSTER = $schemaCachebuster
          }
          description = "Exact-profile Chrome control with Codex-compatible CDP (schema $schemaCachebuster)"
        }
      }
    }
    'CodeBuddy' {
      # The current WorkBuddy CLI executable is named codebuddy and reads this
      # user config. Keep it separate from .workbuddy compatibility settings so
      # callers can review and update either surface explicitly.
      return @{
        Name = 'agentos-chrome-cdp-v2'
        Path = Join-Path $UserProfileRoot '.codebuddy\mcp.json'
        Entry = [pscustomobject][ordered]@{
          type = 'stdio'
          command = $nodeCommand
          args = @($serverScript)
          env = [pscustomobject][ordered]@{
            AGENTOS_CHROME_CONFIG = $configPath
            AGENTOS_CHROME_SCHEMA_CACHEBUSTER = $schemaCachebuster
          }
          description = "Exact-profile Chrome control with Codex-compatible CDP (schema $schemaCachebuster)"
        }
      }
    }
  }
}

function Read-Config {
  param([string]$Path)

  Assert-NoReparseAncestors -Path $Path -Label 'Client configuration'
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject][ordered]@{
      mcpServers = [pscustomobject]@{}
    }
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Client configuration exists but is not a file: $Path"
  }

  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject][ordered]@{
      mcpServers = [pscustomobject]@{}
    }
  }

  $config = $raw | ConvertFrom-Json
  if ($null -eq $config.mcpServers) {
    $config | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([pscustomobject]@{})
  }
  return $config
}

function Write-ConfigAtomic {
  param(
    [string]$Path,
    [object]$Config,
    [Parameter(Mandatory)][bool]$ExpectedExisted,
    [AllowNull()][string]$ExpectedSha256
  )

  $directory = Split-Path -Parent $Path
  Assert-NoReparseAncestors -Path $Path -Label 'Client configuration target'
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  Assert-NoReparseAncestors -Path $Path -Label 'Created client configuration parent'
  $tempPath = Join-Path $directory ([IO.Path]::GetRandomFileName())
  $json = ($Config | ConvertTo-Json -Depth 30) + [Environment]::NewLine
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $desiredSha256 = $null
  $moveAttempted = $false
  $committed = $false
  try {
    [IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
    Assert-NoReparseAncestors -Path $tempPath -Label 'Client configuration staging file'
    $desiredSha256 = (Get-FileHash -LiteralPath $tempPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-PathStateMatches `
      -Path $Path `
      -ExpectedExisted $ExpectedExisted `
      -ExpectedSha256 $ExpectedSha256 `
      -Label 'Client configuration target'
    $moveAttempted = $true
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
    Assert-NoReparseAncestors -Path $Path -Label 'Installed client configuration'
    if (
      -not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $desiredSha256
    ) {
      throw 'Installed client configuration failed desired-state verification.'
    }
    $committed = $true
    return [pscustomobject][ordered]@{
      committed = $true
      sha256 = $desiredSha256
    }
  } catch {
    if (
      -not $committed -and
      $moveAttempted -and
      -not (Test-Path -LiteralPath $tempPath) -and
      -not [string]::IsNullOrWhiteSpace($desiredSha256) -and
      (Test-Path -LiteralPath $Path -PathType Leaf) -and
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $desiredSha256
    ) {
      $committed = $true
    }
    $_.Exception.Data['AgentOsConfigWriteCommitted'] = $committed
    $_.Exception.Data['AgentOsConfigDesiredSha256'] = $desiredSha256
    throw
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      Remove-Item -LiteralPath $tempPath -Force
    }
  }
}

function Write-PrivateConfigAtomic {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][byte[]]$Bytes,
    [Parameter(Mandatory)][bool]$ExpectedExisted,
    [AllowNull()][string]$ExpectedSha256
  )
  $directory = Split-Path -Parent $Path
  Assert-NoReparseAncestors -Path $Path -Label 'Private configuration target'
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetRandomFileName())
  $desiredSha256 = Get-ByteSha256 -Bytes $Bytes
  $moveAttempted = $false
  $committed = $false
  try {
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    Set-AgentOsExactPrivateAcl -Path $temporary
    Assert-NoReparseAncestors -Path $temporary -Label 'Private configuration staging file'
    # This is the final operation before the atomic move. Any drift after the
    # plan or protected backup fails closed without touching the target.
    Assert-PathStateMatches `
      -Path $Path `
      -ExpectedExisted $ExpectedExisted `
      -ExpectedSha256 $ExpectedSha256 `
      -Label 'Private configuration target'
    $moveAttempted = $true
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    Set-AgentOsExactPrivateAcl -Path $Path
    Assert-NoReparseAncestors -Path $Path -Label 'Installed private configuration'
    if (
      -not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $desiredSha256
    ) {
      throw 'Installed private configuration failed desired-state verification.'
    }
    $committed = $true
    return [pscustomobject][ordered]@{
      committed = $true
      sha256 = $desiredSha256
    }
  } catch {
    if (
      -not $committed -and
      $moveAttempted -and
      -not (Test-Path -LiteralPath $temporary) -and
      (Test-Path -LiteralPath $Path -PathType Leaf) -and
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $desiredSha256
    ) {
      $committed = $true
    }
    $_.Exception.Data['AgentOsPrivateWriteCommitted'] = $committed
    $_.Exception.Data['AgentOsPrivateDesiredSha256'] = $desiredSha256
    throw
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Move-ConfigurationToAbsentRollback {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$ExpectedSha256,
    [Parameter(Mandatory)][string]$RollbackPath,
    [Parameter(Mandatory)][string]$Label
  )
  Assert-NoReparseAncestors -Path $Path -Label $Label
  Assert-NoReparseAncestors -Path $RollbackPath -Label "$Label rollback"
  if (Test-Path -LiteralPath $RollbackPath) {
    throw "$Label rollback path already exists."
  }

  $moveAttempted = $false
  $committed = $false
  try {
    # This exact-state check is intentionally the final filesystem operation
    # before the same-directory rename that commits the absent state.
    Assert-PathStateMatches `
      -Path $Path `
      -ExpectedExisted $true `
      -ExpectedSha256 $ExpectedSha256 `
      -Label $Label
    $moveAttempted = $true
    Move-Item -LiteralPath $Path -Destination $RollbackPath
    $committed = $true
    Assert-NoReparseAncestors -Path $RollbackPath -Label "$Label rollback preimage"
    if (
      (Test-Path -LiteralPath $Path) -or
      -not (Test-Path -LiteralPath $RollbackPath -PathType Leaf) -or
      (Get-FileHash -LiteralPath $RollbackPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        $ExpectedSha256.ToLowerInvariant()
    ) {
      throw "$Label absent-state commit verification failed."
    }
    return [pscustomobject][ordered]@{
      committed = $true
      rollback_path = $RollbackPath
      preimage_sha256 = $ExpectedSha256.ToLowerInvariant()
    }
  } catch {
    if (
      -not $committed -and
      $moveAttempted -and
      -not (Test-Path -LiteralPath $Path) -and
      (Test-Path -LiteralPath $RollbackPath -PathType Leaf) -and
      (Get-FileHash -LiteralPath $RollbackPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq
        $ExpectedSha256.ToLowerInvariant()
    ) {
      $committed = $true
    }
    $_.Exception.Data['AgentOsAbsentRestoreCommitted'] = $committed
    $_.Exception.Data['AgentOsAbsentRestoreRollbackPath'] = $RollbackPath
    $_.Exception.Data['AgentOsAbsentRestorePreimageSha256'] = $ExpectedSha256.ToLowerInvariant()
    throw
  }
}

function Test-PathInsideOrEqual {
  param([string]$Candidate, [string]$Root)
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
    $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-ClosedProperties {
  param(
    [Parameter(Mandatory)][object]$Value,
    [Parameter(Mandatory)][string[]]$Required,
    [Parameter(Mandatory)][string]$Label
  )
  if ($Value -isnot [pscustomobject]) { throw "$Label must be an object." }
  $names = @($Value.PSObject.Properties.Name)
  if (
    @($Required | Where-Object { $_ -notin $names }).Count -gt 0 -or
    @($names | Where-Object { $_ -notin $Required }).Count -gt 0
  ) {
    throw "$Label failed its closed schema checks."
  }
}

function Get-ExpectedConfigurationPath {
  param([Parameter(Mandatory)][string]$Client)
  if ($Client -eq 'PrivateConfig') {
    $expected = [IO.Path]::GetFullPath($configPath)
    Assert-NoReparseAncestors -Path $expected -Label 'Private bridge configuration'
    return $expected
  }
  if ($Client -notin @('ClaudeDesktop', 'WorkBuddy', 'CodeBuddy')) {
    throw 'Configuration backup contains an unknown client role.'
  }
  $expected = [IO.Path]::GetFullPath((Get-ClientConfig -Client $Client).Path)
  Assert-NoReparseAncestors -Path $expected -Label "$Client configuration"
  return $expected
}

function Assert-PrivateBackupTree {
  param([Parameter(Mandatory)][string]$Path)
  Assert-NoReparseAncestors -Path $Path -Label 'Configuration backup'
  Assert-AgentOsPrivateRoot -Path $Path -RepositoryRoot $pluginRoot -AuthorizedBase $backupParent
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw 'Configuration backup directory is unavailable.'
  }
  $items = @((Get-Item -LiteralPath $Path -Force)) + @(
    Get-ChildItem -LiteralPath $Path -Force -Recurse
  )
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Configuration backup must not contain reparse points.'
    }
    Assert-AgentOsExactPrivateAcl -Path $item.FullName
  }
}

function Read-TrustedConfigurationBackup {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string[]]$AllowedClients
  )
  $root = [IO.Path]::GetFullPath($Path)
  if (
    $root.TrimEnd('\').Equals($backupParent.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-PathInsideOrEqual -Candidate $root -Root $backupParent)
  ) {
    throw 'Restore backup must be a child of the protected Agent OS Chrome CDP backup root.'
  }
  Assert-PrivateBackupTree -Path $root
  $manifestPath = Join-Path $root 'backup-manifest.json'
  Assert-NoReparseAncestors -Path $manifestPath -Label 'Configuration backup manifest'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Configuration backup manifest is missing.'
  }
  try {
    $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw 'Configuration backup manifest is not valid JSON.'
  }
  Assert-ClosedProperties -Value $manifest `
    -Required @('schema_version', 'kind', 'created_at_utc', 'protection', 'acl', 'entries') `
    -Label 'Configuration backup manifest'
  if (
    $manifest.schema_version -ne 2 -or
    $manifest.kind -ne 'agentos-chrome-client-config' -or
    $manifest.protection -ne 'DPAPI-CurrentUser' -or
    $manifest.acl -ne 'current-user-and-SYSTEM-only'
  ) {
    throw 'Configuration backup manifest metadata is invalid.'
  }
  try { [void][DateTimeOffset]::Parse([string]$manifest.created_at_utc) } catch {
    throw 'Configuration backup timestamp is invalid.'
  }
  $entries = @($manifest.entries)
  if ($entries.Count -lt 1) { throw 'Configuration backup contains no targets.' }
  $seen = @{}
  $seenProtectedPaths = @{}
  foreach ($entry in $entries) {
    Assert-ClosedProperties -Value $entry -Required @(
      'client',
      'original_path',
      'existed',
      'protected_path',
      'source_sha256',
      'protected_sha256',
      'source_bytes',
      'protected_bytes',
      'protection'
    ) -Label 'Configuration backup entry'
    $client = [string]$entry.client
    if ($client -ne 'PrivateConfig' -and $client -notin $AllowedClients) {
      throw "Configuration backup includes unselected client $client."
    }
    $expectedPath = Get-ExpectedConfigurationPath -Client $client
    if (
      -not [IO.Path]::IsPathRooted([string]$entry.original_path) -or
      -not ([IO.Path]::GetFullPath([string]$entry.original_path)).Equals(
        $expectedPath,
        [StringComparison]::OrdinalIgnoreCase
      )
    ) {
      throw "Configuration backup path is not bound to client $client."
    }
    $key = "$client|$($expectedPath.ToLowerInvariant())"
    if ($seen.ContainsKey($key)) { throw 'Configuration backup contains duplicate targets.' }
    $seen[$key] = $true
    if ($entry.existed -isnot [bool]) { throw 'Configuration backup existed flag is invalid.' }
    if ($entry.existed) {
      if (
        $entry.protection -ne 'DPAPI-CurrentUser' -or
        [string]$entry.source_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$entry.protected_sha256 -notmatch '^[0-9a-f]{64}$' -or
        -not ($entry.source_bytes -is [int] -or $entry.source_bytes -is [long]) -or
        -not ($entry.protected_bytes -is [int] -or $entry.protected_bytes -is [long]) -or
        [long]$entry.source_bytes -lt 0 -or
        [long]$entry.protected_bytes -lt 1 -or
        -not [IO.Path]::IsPathRooted([string]$entry.protected_path)
      ) {
        throw 'Configuration backup protected preimage metadata is invalid.'
      }
      $protectedPath = [IO.Path]::GetFullPath([string]$entry.protected_path)
      $expectedProtectedPath = [IO.Path]::GetFullPath((Join-Path (
        Join-Path $root $client
      ) ((Split-Path -Leaf $expectedPath) + '.dpapi')))
      $protectedKey = $protectedPath.ToLowerInvariant()
      if (
        -not (Test-PathInsideOrEqual -Candidate $protectedPath -Root $root) -or
        -not $protectedPath.Equals($expectedProtectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        $seenProtectedPaths.ContainsKey($protectedKey) -or
        -not (Test-Path -LiteralPath $protectedPath -PathType Leaf) -or
        (Get-FileHash -LiteralPath $protectedPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
          ([string]$entry.protected_sha256).ToLowerInvariant()
      ) {
        throw 'Configuration backup protected preimage is unavailable or has drifted.'
      }
      $seenProtectedPaths[$protectedKey] = $true
    } elseif (
      $null -ne $entry.protected_path -or
      $null -ne $entry.source_sha256 -or
      $null -ne $entry.protected_sha256 -or
      $null -ne $entry.source_bytes -or
      $null -ne $entry.protected_bytes -or
      $null -ne $entry.protection
    ) {
      throw 'Configuration backup absent-target metadata is invalid.'
    }
  }
  return [pscustomobject][ordered]@{
    root = $root
    entries = $entries
  }
}

function New-ProtectedConfigurationBackup {
  param(
    [Parameter(Mandatory)][object[]]$Targets,
    [Parameter(Mandatory)][string[]]$AllowedClients
  )
  if ($Targets.Count -lt 1) { return $null }
  $backupId = '{0}-{1}' -f (
    (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
  ), ([Guid]::NewGuid().ToString('N'))
  $root = Join-Path $backupParent $backupId
  Assert-NoReparseAncestors -Path $root -Label 'Configuration backup destination'
  [void](Initialize-AgentOsPrivateDirectory -Path $root -RepositoryRoot $pluginRoot)
  Assert-NoReparseAncestors -Path $root -Label 'Created configuration backup destination'
  $entries = @()
  $seen = @{}
  foreach ($target in $Targets) {
    $client = [string]$target.client
    $path = [IO.Path]::GetFullPath([string]$target.path)
    Assert-NoReparseAncestors -Path $path -Label "$client configuration backup target"
    $key = "$client|$($path.ToLowerInvariant())"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $expectedPath = Get-ExpectedConfigurationPath -Client $client
    if (-not $path.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Configuration backup target does not match client $client."
    }
    $exists = Test-Path -LiteralPath $path -PathType Leaf
    if ((Test-Path -LiteralPath $path) -and -not $exists) {
      throw "Configuration target exists but is not a file: $path"
    }
    if ($exists) {
      $clientBackup = Join-Path $root $client
      [void](Initialize-AgentOsPrivateDirectory -Path $clientBackup -RepositoryRoot $pluginRoot)
      Assert-NoReparseAncestors -Path $clientBackup -Label 'Created client backup destination'
      $protectedPath = Join-Path $clientBackup ((Split-Path -Leaf $path) + '.dpapi')
      $protected = Protect-AgentOsBackupFile -SourcePath $path -DestinationPath $protectedPath
      Assert-NoReparseAncestors -Path $protectedPath -Label 'Protected client backup payload'
      $entries += [pscustomobject][ordered]@{
        client = $client
        original_path = $path
        existed = $true
        protected_path = $protectedPath
        source_sha256 = $protected.source_sha256
        protected_sha256 = $protected.protected_sha256
        source_bytes = $protected.source_bytes
        protected_bytes = $protected.protected_bytes
        protection = $protected.protection
      }
    } else {
      $entries += [pscustomobject][ordered]@{
        client = $client
        original_path = $path
        existed = $false
        protected_path = $null
        source_sha256 = $null
        protected_sha256 = $null
        source_bytes = $null
        protected_bytes = $null
        protection = $null
      }
    }
  }
  $manifest = [pscustomobject][ordered]@{
    schema_version = 2
    kind = 'agentos-chrome-client-config'
    created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    protection = 'DPAPI-CurrentUser'
    acl = 'current-user-and-SYSTEM-only'
    entries = $entries
  }
  $manifestBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(
    (($manifest | ConvertTo-Json -Depth 10) + [Environment]::NewLine)
  )
  try {
    Write-AgentOsPrivateBytesAtomic -Path (Join-Path $root 'backup-manifest.json') -Bytes $manifestBytes
  } finally {
    [Array]::Clear($manifestBytes, 0, $manifestBytes.Length)
  }
  [void](Initialize-AgentOsPrivateDirectory -Path $root -RepositoryRoot $pluginRoot)
  Assert-NoReparseAncestors -Path $root -Label 'Finalized configuration backup destination'
  return Read-TrustedConfigurationBackup -Path $root -AllowedClients $AllowedClients
}

function Assert-CurrentConfigurationMatchesBackup {
  param([Parameter(Mandatory)][object]$Entry)
  $path = [string]$Entry.original_path
  Assert-NoReparseAncestors -Path $path -Label 'Configuration CAS target'
  if ($Entry.existed) {
    if (
      -not (Test-Path -LiteralPath $path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        ([string]$Entry.source_sha256).ToLowerInvariant()
    ) {
      throw "Configuration target changed after backup: $path"
    }
  } elseif (Test-Path -LiteralPath $path) {
    throw "Configuration target appeared after backup: $path"
  }
}

function Invoke-TrustedConfigurationRestore {
  param(
    [Parameter(Mandatory)][object]$TrustedBackup,
    [Parameter(Mandatory)][string[]]$AllowedClients
  )
  $restoreTargets = @($TrustedBackup.entries | ForEach-Object {
    [pscustomobject][ordered]@{
      client = [string]$_.client
      path = [string]$_.original_path
    }
  })
  $safetyBackup = New-ProtectedConfigurationBackup `
    -Targets $restoreTargets `
    -AllowedClients $AllowedClients
  $staged = @()
  $committedRestores = @()
  $absentRollbacks = @()
  try {
    foreach ($entry in $TrustedBackup.entries) {
      if (-not $entry.existed) { continue }
      $path = [string]$entry.original_path
      $directory = Split-Path -Parent $path
      Assert-NoReparseAncestors -Path $path -Label 'Configuration restore target'
      New-Item -ItemType Directory -Force -Path $directory | Out-Null
      Assert-NoReparseAncestors -Path $path -Label 'Created configuration restore parent'
      $temporary = Join-Path $directory (
        '.{0}.agentos-restore-{1}' -f (Split-Path -Leaf $path), [Guid]::NewGuid().ToString('N')
      )
      [void](Restore-AgentOsProtectedBackup `
        -ProtectedPath ([string]$entry.protected_path) `
        -DestinationPath $temporary `
        -ExpectedSourceSha256 ([string]$entry.source_sha256) `
        -Confirm:$false)
      Assert-NoReparseAncestors -Path $temporary -Label 'Configuration restore staging file'
      if (
        -not (Test-Path -LiteralPath $temporary -PathType Leaf) -or
        (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne
          ([string]$entry.source_sha256).ToLowerInvariant()
      ) {
        throw "Restored staging preimage failed verification: $path"
      }
      $staged += [pscustomobject][ordered]@{
        client = [string]$entry.client
        path = $path
        temporary = $temporary
      }
    }

    foreach ($entry in $safetyBackup.entries) {
      Assert-CurrentConfigurationMatchesBackup -Entry $entry
    }
    foreach ($entry in $TrustedBackup.entries) {
      $path = [string]$entry.original_path
      $safetyEntry = @($safetyBackup.entries | Where-Object {
        $_.client -eq [string]$entry.client -and
        ([string]$_.original_path).Equals($path, [StringComparison]::OrdinalIgnoreCase)
      } | Select-Object -First 1)
      if ($safetyEntry.Count -ne 1) {
        throw "Restore safety state is unavailable: $path"
      }
      Assert-CurrentConfigurationMatchesBackup -Entry $safetyEntry[0]
      if ($entry.existed) {
        $stageEntry = @($staged | Where-Object {
          $_.client -eq [string]$entry.client -and
          $_.path.Equals($path, [StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1)
        if ($stageEntry.Count -ne 1) { throw "Restore staging is unavailable: $path" }
        try {
          Move-Item -LiteralPath $stageEntry[0].temporary -Destination $path -Force
          $committedRestores += [pscustomobject][ordered]@{
            entry = $entry
            desired_existed = $true
            desired_sha256 = [string]$entry.source_sha256
            rollback_path = $null
          }
        } catch {
          if (
            -not (Test-Path -LiteralPath $stageEntry[0].temporary) -and
            (Test-Path -LiteralPath $path -PathType Leaf) -and
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq
              ([string]$entry.source_sha256).ToLowerInvariant()
          ) {
            $committedRestores += [pscustomobject][ordered]@{
              entry = $entry
              desired_existed = $true
              desired_sha256 = [string]$entry.source_sha256
              rollback_path = $null
            }
          }
          throw
        }
        Assert-NoReparseAncestors -Path $path -Label 'Restored configuration target'
      } elseif ($safetyEntry[0].existed) {
        $rollbackPath = Join-Path (Split-Path -Parent $path) (
          '.{0}.agentos-absent-rollback-{1}' -f (
            Split-Path -Leaf $path
          ), ([Guid]::NewGuid().ToString('N'))
        )
        try {
          $absenceMove = Move-ConfigurationToAbsentRollback `
            -Path $path `
            -ExpectedSha256 ([string]$safetyEntry[0].source_sha256) `
            -RollbackPath $rollbackPath `
            -Label "$($entry.client) absent-state restore target"
          if ($absenceMove.committed) {
            $committedRestores += [pscustomobject][ordered]@{
              entry = $entry
              desired_existed = $false
              desired_sha256 = $null
              rollback_path = [string]$absenceMove.rollback_path
            }
            $absentRollbacks += [pscustomobject][ordered]@{
              path = [string]$absenceMove.rollback_path
              sha256 = [string]$absenceMove.preimage_sha256
            }
          }
        } catch {
          if ($_.Exception.Data['AgentOsAbsentRestoreCommitted'] -eq $true) {
            $committedRestores += [pscustomobject][ordered]@{
              entry = $entry
              desired_existed = $false
              desired_sha256 = $null
              rollback_path = [string]$_.Exception.Data['AgentOsAbsentRestoreRollbackPath']
            }
          }
          throw
        }
      }
      if ([string]$entry.client -eq 'PrivateConfig' -and $entry.existed) {
        Set-AgentOsExactPrivateAcl -Path $configRoot
        Set-AgentOsExactPrivateAcl -Path $configPath
      }
      if ($entry.existed) {
        if (
          -not (Test-Path -LiteralPath $path -PathType Leaf) -or
          (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne
            ([string]$entry.source_sha256).ToLowerInvariant()
        ) {
          throw "Restored configuration target failed verification: $path"
        }
      } elseif (Test-Path -LiteralPath $path) {
        throw "Configuration target should be absent after restore: $path"
      }
    }
  } catch {
    $restoreError = $_
    $rollbackErrors = @()
    for ($index = $committedRestores.Count - 1; $index -ge 0; $index--) {
      $committedRestore = $committedRestores[$index]
      $entry = $committedRestore.entry
      $path = [string]$entry.original_path
      $safetyEntry = @($safetyBackup.entries | Where-Object {
        $_.client -eq [string]$entry.client -and
        ([string]$_.original_path).Equals($path, [StringComparison]::OrdinalIgnoreCase)
      } | Select-Object -First 1)
      try {
        if ($safetyEntry.Count -ne 1) { throw 'matching restore-safety preimage is unavailable' }
        if (-not $entry.existed -and $safetyEntry[0].existed) {
          $rollbackPath = [string]$committedRestore.rollback_path
          Assert-NoReparseAncestors -Path $rollbackPath -Label 'Absent-state rollback preimage'
          if (
            -not (Test-Path -LiteralPath $rollbackPath -PathType Leaf) -or
            (Get-FileHash -LiteralPath $rollbackPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
              ([string]$safetyEntry[0].source_sha256).ToLowerInvariant()
          ) {
            throw 'absent-state rollback preimage is unavailable or has drifted'
          }
          Assert-PathStateMatches `
            -Path $path `
            -ExpectedExisted $false `
            -ExpectedSha256 $null `
            -Label "$($entry.client) restore rollback target"
          Move-Item -LiteralPath $rollbackPath -Destination $path
          Assert-PathStateMatches `
            -Path $path `
            -ExpectedExisted $true `
            -ExpectedSha256 ([string]$safetyEntry[0].source_sha256) `
            -Label "$($entry.client) restored rollback preimage"
          if ([string]$entry.client -eq 'PrivateConfig') {
            Set-AgentOsExactPrivateAcl -Path $configRoot
            Set-AgentOsExactPrivateAcl -Path $configPath
          }
        } else {
          Assert-PathStateMatches `
            -Path $path `
            -ExpectedExisted ([bool]$committedRestore.desired_existed) `
            -ExpectedSha256 ([string]$committedRestore.desired_sha256) `
            -Label "$($entry.client) restore rollback target"
          if ($safetyEntry[0].existed) {
            [void](Restore-AgentOsProtectedBackup `
              -ProtectedPath ([string]$safetyEntry[0].protected_path) `
              -DestinationPath $path `
              -ExpectedSourceSha256 ([string]$safetyEntry[0].source_sha256) `
              -Confirm:$false)
            if ([string]$entry.client -eq 'PrivateConfig') {
              Set-AgentOsExactPrivateAcl -Path $configRoot
              Set-AgentOsExactPrivateAcl -Path $configPath
            }
          } elseif (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
          }
        }
      } catch {
        $rollbackErrors += "$($entry.client):$($_.Exception.Message)"
      }
    }
    $rollbackState = if ($rollbackErrors.Count -eq 0) {
      'complete'
    } else {
      'incomplete:' + ($rollbackErrors -join ';')
    }
    throw "Configuration restore failed; rollback=$rollbackState; cause=$($restoreError.Exception.Message)"
  } finally {
    foreach ($stageEntry in $staged) {
      if (Test-Path -LiteralPath $stageEntry.temporary) {
        Remove-Item -LiteralPath $stageEntry.temporary -Force -ErrorAction SilentlyContinue
      }
    }
  }
  foreach ($absenceRollback in $absentRollbacks) {
    if (Test-Path -LiteralPath $absenceRollback.path) {
      try {
        Assert-PathStateMatches `
          -Path ([string]$absenceRollback.path) `
          -ExpectedExisted $true `
          -ExpectedSha256 ([string]$absenceRollback.sha256) `
          -Label 'Committed absent-state rollback cleanup'
        Remove-Item -LiteralPath $absenceRollback.path -Force
      } catch {
        Write-Warning "Committed absent-state restore, but rollback cleanup failed: $($_.Exception.Message)"
      }
    }
  }
  return $safetyBackup.root
}

if ($restoreRequested) {
  $trustedRestore = Read-TrustedConfigurationBackup `
    -Path $RestoreBackup `
    -AllowedClients $Clients
  $safetyBackupRoot = Invoke-TrustedConfigurationRestore `
    -TrustedBackup $trustedRestore `
    -AllowedClients $Clients
  [pscustomobject][ordered]@{
    status = 'RESTORED'
    mode = 'restore'
    restored_backup = $trustedRestore.root
    safety_backup = $safetyBackupRoot
    clients = $Clients
    restart_required = $true
  } | ConvertTo-Json -Depth 8
  return
}

$backupRoot = $null
$results = @()
$backupEntries = @()
$plans = @()
$configExists = Test-Path -LiteralPath $configPath -PathType Leaf
if ((Test-Path -LiteralPath $configPath) -and -not $configExists) {
  throw 'Private bridge configuration exists but is not a file.'
}
$configPlanSha256 = if ($configExists) {
  (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash.ToLowerInvariant()
} else {
  $null
}
$configNeedsUpdate = $false
$existingBridgeConfig = $null
if (-not $Remove -and $configExists) {
  Assert-BridgeConfig -Path $configPath -AllowMissingTrustedLauncher
  $existingBridgeConfig = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $currentExtensionPath = [string]$existingBridgeConfig.chromeProfileLauncher.extensionPath
  $normalizedCurrentExtensionPath = if ([string]::IsNullOrWhiteSpace($currentExtensionPath)) {
    ''
  } elseif ([IO.Path]::IsPathRooted($currentExtensionPath)) {
    [IO.Path]::GetFullPath($currentExtensionPath)
  } else {
    $currentExtensionPath
  }
  $configNeedsUpdate = (
    [string]$existingBridgeConfig.chromeProfileLauncher.extensionId -ne $ExtensionId -or
    $normalizedCurrentExtensionPath -ne $ExtensionPath -or
    [bool]$RotateSecret
  )
}

foreach ($client in $Clients) {
  $target = Get-ClientConfig -Client $client
  $serverName = $target.Name
  $path = $target.Path
  Assert-NoReparseAncestors -Path $path -Label "$client configuration"
  $planExisted = Test-Path -LiteralPath $path -PathType Leaf
  if ((Test-Path -LiteralPath $path) -and -not $planExisted) {
    throw "$client configuration exists but is not a file."
  }
  $planSha256 = if ($planExisted) {
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  } else {
    $null
  }
  $config = Read-Config -Path $path
  $property = $config.mcpServers.PSObject.Properties[$serverName]

  if ($Remove) {
    $action = if ($null -eq $property) { 'unchanged' } else { 'remove' }
  } else {
    $desiredJson = $target.Entry | ConvertTo-Json -Depth 10 -Compress
    $currentJson = if ($null -eq $property) { $null } else { $property.Value | ConvertTo-Json -Depth 10 -Compress }
    if ($currentJson -eq $desiredJson) {
      $action = 'unchanged'
    } elseif ($null -ne $property -and -not $Force) {
      throw "$client already has an '$serverName' MCP entry with different settings. Re-run with -Force only after reviewing it."
    } else {
      $action = if ($null -eq $property) { 'add' } else { 'replace' }
    }
  }

  $plans += [pscustomobject][ordered]@{
    client = $client
    target = $target
    server_name = $serverName
    path = $path
    config = $config
    action = $action
    existed = $planExisted
    preimage_existed = $planExisted
    preimage_sha256 = $planSha256
  }
  $results += [pscustomobject][ordered]@{
    client = $client
    path = $path
    action = $action
    applied = [bool]$Apply
  }
}

if ($Apply) {
  $mutationTargets = @($plans | Where-Object { $_.action -ne 'unchanged' } | ForEach-Object {
    [pscustomobject][ordered]@{
      client = $_.client
      path = $_.path
    }
  })
  if (-not $Remove -and (-not $configExists -or $configNeedsUpdate)) {
    $mutationTargets += [pscustomobject][ordered]@{
      client = 'PrivateConfig'
      path = $configPath
    }
  }
  if ($mutationTargets.Count -gt 0) {
    $trustedApplyBackup = New-ProtectedConfigurationBackup `
      -Targets $mutationTargets `
      -AllowedClients $Clients
    $backupRoot = $trustedApplyBackup.root
    $backupEntries = @($trustedApplyBackup.entries)
    foreach ($backupEntry in $backupEntries) {
      $plannedExisted = $null
      $plannedSha256 = $null
      if ([string]$backupEntry.client -eq 'PrivateConfig') {
        $plannedExisted = $configExists
        $plannedSha256 = $configPlanSha256
      } else {
        $planned = @($plans | Where-Object {
          $_.client -eq [string]$backupEntry.client -and
          ([string]$_.path).Equals(
            [string]$backupEntry.original_path,
            [StringComparison]::OrdinalIgnoreCase
          )
        } | Select-Object -First 1)
        if ($planned.Count -ne 1) {
          throw 'Protected backup is not bound to a planned client preimage.'
        }
        $plannedExisted = [bool]$planned[0].preimage_existed
        $plannedSha256 = [string]$planned[0].preimage_sha256
      }
      if (
        [bool]$backupEntry.existed -ne [bool]$plannedExisted -or
        (
          [bool]$plannedExisted -and
          ([string]$backupEntry.source_sha256).ToLowerInvariant() -ne
            ([string]$plannedSha256).ToLowerInvariant()
        )
      ) {
        throw 'Protected backup does not match the exact planned preimage.'
      }
      Assert-CurrentConfigurationMatchesBackup -Entry $backupEntry
    }
  }

  $configCreatedThisRun = $false
  $configModifiedThisRun = $false
  $privateCommittedSha256 = $null
  $committedPlans = @()
  try {
    if (-not $Remove) {
      $privateBackupEntry = @($backupEntries | Where-Object {
        $_.client -eq 'PrivateConfig' -and
        ([string]$_.original_path).Equals($configPath, [StringComparison]::OrdinalIgnoreCase)
      } | Select-Object -First 1)
      if (-not $configExists -or $configNeedsUpdate) {
        if ($privateBackupEntry.Count -ne 1) {
          throw 'Protected private configuration preimage is unavailable.'
        }
        [void](Initialize-AgentOsPrivateDirectory -Path $configRoot -RepositoryRoot $pluginRoot)
        Assert-NoReparseAncestors -Path $configPath -Label 'Created private configuration parent'
      }
      if (-not $configExists) {
        $randomBytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
        try {
          $localConfig = [ordered]@{
            host = '127.0.0.1'
            port = 18755
            secret = [Convert]::ToBase64String($randomBytes)
            commandTimeoutMs = 60000
            profileAliases = [ordered]@{}
            chromeProfileLauncher = [ordered]@{
              extensionId = $ExtensionId
              extensionPath = $ExtensionPath
            }
          }
          $json = ($localConfig | ConvertTo-Json -Depth 10) + [Environment]::NewLine
          $configBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
          try {
            try {
              $privateWriteResult = Write-PrivateConfigAtomic `
                -Path $configPath `
                -Bytes $configBytes `
                -ExpectedExisted $privateBackupEntry[0].existed `
                -ExpectedSha256 $privateBackupEntry[0].source_sha256
              if ($privateWriteResult.committed) {
                $configCreatedThisRun = $true
                $privateCommittedSha256 = [string]$privateWriteResult.sha256
              }
            } catch {
              if ($_.Exception.Data['AgentOsPrivateWriteCommitted'] -eq $true) {
                $configCreatedThisRun = $true
                $privateCommittedSha256 = [string]$_.Exception.Data['AgentOsPrivateDesiredSha256']
              }
              throw
            }
          } finally {
            [Array]::Clear($configBytes, 0, $configBytes.Length)
          }
        } finally {
          [Array]::Clear($randomBytes, 0, $randomBytes.Length)
        }
      } elseif ($configNeedsUpdate) {
        if ($null -eq $existingBridgeConfig.chromeProfileLauncher) {
          $existingBridgeConfig | Add-Member -MemberType NoteProperty -Name chromeProfileLauncher -Value ([pscustomobject]@{})
        }
        $existingBridgeConfig.chromeProfileLauncher |
          Add-Member -MemberType NoteProperty -Name extensionId -Value $ExtensionId -Force
        $existingBridgeConfig.chromeProfileLauncher |
          Add-Member -MemberType NoteProperty -Name extensionPath -Value $ExtensionPath -Force
        if ($RotateSecret) {
          $randomBytes = New-Object byte[] 32
          $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
          try {
            $rng.GetBytes($randomBytes)
            $existingBridgeConfig.secret = [Convert]::ToBase64String($randomBytes)
          } finally {
            $rng.Dispose()
            [Array]::Clear($randomBytes, 0, $randomBytes.Length)
          }
        }
        $json = ($existingBridgeConfig | ConvertTo-Json -Depth 30) + [Environment]::NewLine
        $configBytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
        try {
          try {
            $privateWriteResult = Write-PrivateConfigAtomic `
              -Path $configPath `
              -Bytes $configBytes `
              -ExpectedExisted $privateBackupEntry[0].existed `
              -ExpectedSha256 $privateBackupEntry[0].source_sha256
            if ($privateWriteResult.committed) {
              $configModifiedThisRun = $true
              $privateCommittedSha256 = [string]$privateWriteResult.sha256
            }
          } catch {
            if ($_.Exception.Data['AgentOsPrivateWriteCommitted'] -eq $true) {
              $configModifiedThisRun = $true
              $privateCommittedSha256 = [string]$_.Exception.Data['AgentOsPrivateDesiredSha256']
            }
            throw
          }
        } finally {
          [Array]::Clear($configBytes, 0, $configBytes.Length)
        }
      }
      if ($configCreatedThisRun -or $configModifiedThisRun) {
        Set-AgentOsExactPrivateAcl -Path $configPath
      }
      Assert-BridgeConfig -Path $configPath
      $installedBridgeConfig = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
      if (
        [string]$installedBridgeConfig.chromeProfileLauncher.extensionId -ne $ExtensionId -or
        [IO.Path]::GetFullPath([string]$installedBridgeConfig.chromeProfileLauncher.extensionPath) -ne $ExtensionPath
      ) {
        throw 'Existing bridge configuration does not match the explicitly trusted extension binding.'
      }
    }

    foreach ($plan in @($plans | Where-Object { $_.action -ne 'unchanged' })) {
      if ($Remove) {
        $plan.config.mcpServers.PSObject.Properties.Remove($plan.server_name)
      } else {
        $plan.config.mcpServers | Add-Member -MemberType NoteProperty -Name $plan.server_name -Value $plan.target.Entry -Force
      }
      try {
        $writeResult = Write-ConfigAtomic `
          -Path $plan.path `
          -Config $plan.config `
        -ExpectedExisted $plan.preimage_existed `
        -ExpectedSha256 $plan.preimage_sha256
        if ($writeResult.committed) {
          $committedPlans += [pscustomobject][ordered]@{
            plan = $plan
            desired_sha256 = [string]$writeResult.sha256
          }
        }
      } catch {
        if ($_.Exception.Data['AgentOsConfigWriteCommitted'] -eq $true) {
          $committedPlans += [pscustomobject][ordered]@{
            plan = $plan
            desired_sha256 = [string]$_.Exception.Data['AgentOsConfigDesiredSha256']
          }
        }
        throw
      }
    }
  } catch {
    $applyError = $_
    $rollbackErrors = @()
    for ($index = $committedPlans.Count - 1; $index -ge 0; $index--) {
      $committedPlan = $committedPlans[$index]
      $plan = $committedPlan.plan
      try {
        Assert-PathStateMatches `
          -Path $plan.path `
          -ExpectedExisted $true `
          -ExpectedSha256 ([string]$committedPlan.desired_sha256) `
          -Label "$($plan.client) rollback target"
        $backupEntry = @($backupEntries | Where-Object {
          $_.client -eq $plan.client -and
          ([string]$_.original_path).Equals($plan.path, [StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1)
        if ($backupEntry.Count -ne 1) {
          throw 'matching protected preimage is unavailable'
        }
        if ($backupEntry[0].existed) {
          [void](Restore-AgentOsProtectedBackup `
            -ProtectedPath ([string]$backupEntry[0].protected_path) `
            -DestinationPath $plan.path `
            -ExpectedSourceSha256 ([string]$backupEntry[0].source_sha256) `
            -Confirm:$false)
        } elseif (Test-Path -LiteralPath $plan.path) {
          Remove-Item -LiteralPath $plan.path -Force
        }
      } catch {
        $rollbackErrors += "$($plan.client):$($_.Exception.Message)"
      }
    }
    if ($configCreatedThisRun -or $configModifiedThisRun) {
      try {
        Assert-PathStateMatches `
          -Path $configPath `
          -ExpectedExisted $true `
          -ExpectedSha256 $privateCommittedSha256 `
          -Label 'Private configuration rollback target'
        $configBackupEntry = @($backupEntries | Where-Object {
          $_.client -eq 'PrivateConfig' -and
          ([string]$_.original_path).Equals($configPath, [StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1)
        if ($configBackupEntry.Count -ne 1) {
          throw 'matching protected private-config preimage is unavailable'
        }
        if ($configBackupEntry[0].existed) {
          [void](Restore-AgentOsProtectedBackup `
            -ProtectedPath ([string]$configBackupEntry[0].protected_path) `
            -DestinationPath $configPath `
            -ExpectedSourceSha256 ([string]$configBackupEntry[0].source_sha256) `
            -Confirm:$false)
          Set-AgentOsExactPrivateAcl -Path $configRoot
          Set-AgentOsExactPrivateAcl -Path $configPath
        } elseif (Test-Path -LiteralPath $configPath) {
          Remove-Item -LiteralPath $configPath -Force
        }
      } catch {
        $rollbackErrors += "private-config:$($_.Exception.Message)"
      }
    }
    $rollbackState = if ($rollbackErrors.Count -eq 0) {
      'complete'
    } else {
      'incomplete:' + ($rollbackErrors -join ';')
    }
    throw "Client configuration apply failed; rollback=$rollbackState; cause=$($applyError.Exception.Message)"
  }
}

[pscustomobject][ordered]@{
  status = if ($Apply) { 'APPLIED' } else { 'PREVIEW' }
  mode = if ($Remove) { 'remove' } else { 'install' }
  private_config = $configPath
  bridge_config_state = if ($Remove) {
    'not-required-for-remove'
  } elseif (Test-Path -LiteralPath $configPath) {
    'present'
  } else {
    'create-on-apply'
  }
  bridge_config_action = if ($Remove) {
    'unchanged'
  } elseif (-not $configExists) {
    'create'
  } elseif ($configNeedsUpdate) {
    if ($RotateSecret) { 'update-trust-and-rotate-secret' } else { 'update-trust' }
  } else {
    'unchanged'
  }
  backup_root = if ($Apply -and $backupEntries.Count -gt 0) { $backupRoot } else { $null }
  backup_protection = if ($Apply -and $backupEntries.Count -gt 0) { 'DPAPI-CurrentUser' } else { $null }
  results = $results
  restart_required = [bool]$Apply
} | ConvertTo-Json -Depth 10
