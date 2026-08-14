[CmdletBinding()]
param(
  [string]$Target,
  [string]$LocalAppDataRoot = $env:LOCALAPPDATA,
  [switch]$Apply,
  [string]$RestoreBackup
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$privateStorageModule = Join-Path $PSScriptRoot 'Private-Storage.psm1'
Import-Module -Name $privateStorageModule -Force
if (
  [string]::IsNullOrWhiteSpace($LocalAppDataRoot) -or
  -not [IO.Path]::IsPathRooted($LocalAppDataRoot)
) {
  throw 'LocalAppDataRoot must be an absolute private storage root.'
}
$LocalAppDataRoot = [IO.Path]::GetFullPath($LocalAppDataRoot)
if ([string]::IsNullOrWhiteSpace($Target)) {
  $Target = Join-Path $LocalAppDataRoot 'AgentOS\ChromeCDP\Extension'
}

$source = [IO.Path]::GetFullPath((Join-Path $pluginRoot 'extension'))
$Target = [IO.Path]::GetFullPath($Target)
$backupParent = [IO.Path]::GetFullPath(
  (Join-Path $LocalAppDataRoot 'AgentOS\backups\agentos-chrome-cdp')
)

function Test-PathInsideOrEqual {
  param([string]$Candidate, [string]$Root)
  $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $candidateFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase) -or
    $candidateFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)
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

function Assert-NoReparseTree {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
  $items = @((Get-Item -LiteralPath $Path -Force)) + @(
    Get-ChildItem -LiteralPath $Path -Force -Recurse
  )
  if (@($items | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  }).Count -gt 0) {
    throw "$Label must not contain reparse points."
  }
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

function Get-ExtensionDefinition {
  param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Label)
  $manifestPath = Join-Path $Root 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "$Label manifest is missing."
  }
  try {
    $definition = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw "$Label manifest is not valid JSON."
  }
  $permissions = @($definition.permissions)
  $missingRequiredPermissions = @(
    @('debugger', 'storage', 'offscreen') | Where-Object { $_ -notin $permissions }
  ).Count -gt 0
  if (
    $definition.manifest_version -ne 3 -or
    $definition.name -ne 'Chrome Faithful' -or
    $definition.background.service_worker -ne 'service-worker.js' -or
    $definition.background.type -ne 'module' -or
    $definition.options_ui.page -ne 'options.html' -or
    $missingRequiredPermissions
  ) {
    throw "$Label manifest contract is invalid."
  }
  return $definition
}

function Assert-SafeDirectoryTarget {
  param([string]$Path, [switch]$Recovery)
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  Assert-NoReparseAncestors -Path $full -Label 'Extension target'
  $root = [IO.Path]::GetPathRoot($full).TrimEnd('\')
  if ([string]::IsNullOrWhiteSpace($full) -or $full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Extension target must not be a drive root.'
  }
  if (Test-PathInsideOrEqual -Candidate $full -Root $source) {
    throw 'Extension target must not be inside the plugin source extension directory.'
  }
  if (Test-PathInsideOrEqual -Candidate $source -Root $full) {
    throw 'Extension target must not contain the plugin source extension directory.'
  }
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer) {
      throw 'Extension target exists but is not a directory.'
    }
    Assert-NoReparseTree -Path $full -Label 'Extension target'
    if (-not $Recovery) {
      [void](Get-ExtensionDefinition -Root $full -Label 'Existing extension target')
    }
  }
}

function Get-TreeManifest {
  param([Parameter(Mandatory)][string]$Root)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse -Force |
      Sort-Object FullName |
      ForEach-Object {
        [pscustomobject][ordered]@{
          relative = $_.FullName.Substring($Root.Length).TrimStart('\')
          bytes = $_.Length
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
      }
  )
}

function Assert-TreeMatches {
  param(
    [Parameter(Mandatory)][object[]]$Expected,
    [Parameter(Mandatory)][object[]]$Actual,
    [Parameter(Mandatory)][string]$Label
  )
  $expectedLines = @($Expected | ForEach-Object { "$($_.relative)|$($_.bytes)|$($_.sha256)" })
  $actualLines = @($Actual | ForEach-Object { "$($_.relative)|$($_.bytes)|$($_.sha256)" })
  $difference = @(Compare-Object -ReferenceObject $expectedLines -DifferenceObject $actualLines)
  if ($difference.Count -gt 0) {
    throw "$Label file set or hashes do not match."
  }
}

function Copy-Tree {
  param([string]$From, [string]$To)
  Assert-NoReparseAncestors -Path $From -Label 'Tree source'
  Assert-NoReparseAncestors -Path $To -Label 'Tree destination'
  if (Test-Path -LiteralPath $To) { throw "Tree destination already exists: $To" }
  New-Item -ItemType Directory -Path $To | Out-Null
  Assert-NoReparseAncestors -Path $To -Label 'Created tree destination'
  Get-ChildItem -LiteralPath $From -Force | Copy-Item -Destination $To -Recurse -Force
  Assert-NoReparseTree -Path $To -Label 'Copied tree destination'
}

function Assert-ManifestFileEntries {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Files,
    [switch]$AllowEmpty
  )
  if ($Files.Count -lt 1) {
    if ($AllowEmpty) { return }
    throw 'Extension backup file list must not be empty.'
  }
  $seen = @{}
  foreach ($file in $Files) {
    Assert-ClosedProperties -Value $file -Required @('relative', 'bytes', 'sha256') -Label 'Extension backup file entry'
    $relative = [string]$file.relative
    if (
      [string]::IsNullOrWhiteSpace($relative) -or
      [IO.Path]::IsPathRooted($relative) -or
      $relative.Contains('/') -or
      $relative.Contains([char]0)
    ) {
      throw 'Extension backup contains an unsafe relative path.'
    }
    $segments = @($relative.Split([IO.Path]::DirectorySeparatorChar))
    if (@($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
      throw 'Extension backup contains an unsafe relative path.'
    }
    $key = $relative.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { throw 'Extension backup contains duplicate relative paths.' }
    $seen[$key] = $true
    if (
      -not ($file.bytes -is [int] -or $file.bytes -is [long]) -or
      [long]$file.bytes -lt 0 -or
      [string]$file.sha256 -notmatch '^[0-9a-f]{64}$'
    ) {
      throw 'Extension backup file metadata is invalid.'
    }
  }
  if (-not $seen.ContainsKey('manifest.json')) {
    throw 'Extension backup has no manifest.json entry.'
  }
}

function Read-TrustedExtensionBackup {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$ExpectedTarget)
  $root = [IO.Path]::GetFullPath($Path)
  Assert-NoReparseAncestors -Path $root -Label 'Restore backup'
  if (
    $root.TrimEnd('\').Equals($backupParent.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-PathInsideOrEqual -Candidate $root -Root $backupParent)
  ) {
    throw 'Restore backup must be a child of the protected Agent OS Chrome CDP backup root.'
  }
  Assert-AgentOsPrivateRoot -Path $root -RepositoryRoot $pluginRoot -AuthorizedBase $backupParent
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw 'Restore backup directory is unavailable.'
  }
  Assert-NoReparseTree -Path $root -Label 'Restore backup'
  Assert-AgentOsExactPrivateAcl -Path $root
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Force -Recurse)) {
    Assert-AgentOsExactPrivateAcl -Path $item.FullName
  }

  $payload = Join-Path $root 'payload'
  $manifestPath = Join-Path $root 'backup-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'Restore backup is incomplete.'
  }
  try {
    $backupManifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw 'Restore backup manifest is not valid JSON.'
  }
  $schemaProperty = $backupManifest.PSObject.Properties['schema_version']
  if ($null -eq $schemaProperty) {
    throw 'Extension backup manifest has no schema version.'
  }
  $schemaVersion = $schemaProperty.Value
  if (-not ($schemaVersion -is [int] -or $schemaVersion -is [long])) {
    throw 'Extension backup manifest schema version is invalid.'
  }
  if ($schemaVersion -eq 2) {
    Assert-ClosedProperties -Value $backupManifest `
      -Required @('schema_version', 'kind', 'created_at_utc', 'original_path', 'files') `
      -Label 'Extension backup manifest'
    $existed = $true
  } elseif ($schemaVersion -eq 3) {
    Assert-ClosedProperties -Value $backupManifest `
      -Required @('schema_version', 'kind', 'created_at_utc', 'original_path', 'existed', 'files') `
      -Label 'Extension backup manifest'
    if ($backupManifest.existed -isnot [bool]) {
      throw 'Extension backup existed flag is invalid.'
    }
    $existed = [bool]$backupManifest.existed
  } else {
    throw 'Extension backup manifest schema version is unsupported.'
  }
  if (
    $backupManifest.kind -ne 'agentos-chrome-extension-tree' -or
    -not [IO.Path]::IsPathRooted([string]$backupManifest.original_path) -or
    -not ([IO.Path]::GetFullPath([string]$backupManifest.original_path)).Equals(
      [IO.Path]::GetFullPath($ExpectedTarget),
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw 'Extension backup manifest is not bound to this target.'
  }
  try { [void][DateTimeOffset]::Parse([string]$backupManifest.created_at_utc) } catch {
    throw 'Extension backup timestamp is invalid.'
  }
  $files = @($backupManifest.files)
  if ($existed) {
    if (-not (Test-Path -LiteralPath $payload -PathType Container)) {
      throw 'Restore backup payload is missing.'
    }
    Assert-NoReparseAncestors -Path $payload -Label 'Restore payload'
    Assert-ManifestFileEntries -Files $files
    Assert-TreeMatches -Expected $files -Actual (Get-TreeManifest -Root $payload) -Label 'Restore payload'
    [void](Get-ExtensionDefinition -Root $payload -Label 'Restore payload')
  } else {
    Assert-ManifestFileEntries -Files $files -AllowEmpty
    if ($files.Count -ne 0 -or (Test-Path -LiteralPath $payload)) {
      throw 'Absent extension backup must not contain a payload.'
    }
  }
  return [pscustomobject][ordered]@{
    root = $root
    payload = if ($existed) { $payload } else { $null }
    existed = $existed
    files = $files
  }
}

function New-ExtensionStateBackup {
  param(
    [Parameter(Mandatory)][string]$StatePath,
    [Parameter(Mandatory)][string]$Suffix
  )
  Assert-SafeDirectoryTarget -Path $StatePath -Recovery
  $stateExisted = Test-Path -LiteralPath $StatePath -PathType Container
  if ((Test-Path -LiteralPath $StatePath) -and -not $stateExisted) {
    throw 'Extension backup target exists but is not a directory.'
  }
  $stateFiles = if ($stateExisted) { Get-TreeManifest -Root $StatePath } else { @() }
  $backupId = '{0}-{1}-{2}' -f (
    (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
  ), ([Guid]::NewGuid().ToString('N')), $Suffix
  $root = Join-Path $backupParent $backupId
  $payload = Join-Path $root 'payload'
  Assert-NoReparseAncestors -Path $root -Label 'Extension backup destination'
  [void](Initialize-AgentOsPrivateDirectory -Path $root -RepositoryRoot $pluginRoot)
  Assert-NoReparseAncestors -Path $root -Label 'Created extension backup destination'
  if ($stateExisted) {
    Copy-Tree -From $StatePath -To $payload
    Assert-TreeMatches `
      -Expected $stateFiles `
      -Actual (Get-TreeManifest -Root $payload) `
      -Label 'Backup payload'
  }
  $backupManifest = [pscustomobject][ordered]@{
    schema_version = 3
    kind = 'agentos-chrome-extension-tree'
    created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    original_path = [IO.Path]::GetFullPath($StatePath)
    existed = $stateExisted
    files = $stateFiles
  }
  $manifestBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(
    (($backupManifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
  )
  try {
    Write-AgentOsPrivateBytesAtomic -Path (Join-Path $root 'backup-manifest.json') -Bytes $manifestBytes
  } finally {
    [Array]::Clear($manifestBytes, 0, $manifestBytes.Length)
  }
  [void](Initialize-AgentOsPrivateDirectory -Path $root -RepositoryRoot $pluginRoot)
  Assert-NoReparseAncestors -Path $root -Label 'Finalized extension backup destination'
  return Read-TrustedExtensionBackup -Path $root -ExpectedTarget $StatePath
}

function Invoke-VerifiedTreeSwap {
  param(
    [Parameter(Mandatory)][string]$From,
    [Parameter(Mandatory)][object[]]$Expected,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$Stage,
    [Parameter(Mandatory)][string]$Rollback,
    [Parameter(Mandatory)][bool]$DestinationExisted,
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$DestinationPreimage
  )
  $preimageMoved = $false
  $replacementInstalled = $false
  try {
    Assert-NoReparseAncestors -Path $Destination -Label 'Extension swap destination'
    Assert-NoReparseAncestors -Path $Stage -Label 'Extension swap staging path'
    Assert-NoReparseAncestors -Path $Rollback -Label 'Extension swap rollback path'
    Copy-Tree -From $From -To $Stage
    Assert-TreeMatches -Expected $Expected -Actual (Get-TreeManifest -Root $Stage) -Label 'Extension staging'
    if ($DestinationExisted) {
      Assert-TreeMatches -Expected $DestinationPreimage -Actual (Get-TreeManifest -Root $Destination) -Label 'Extension target pre-swap CAS'
      Assert-NoReparseTree -Path $Destination -Label 'Extension target pre-swap CAS'
      Move-Item -LiteralPath $Destination -Destination $Rollback
      $preimageMoved = $true
      Assert-NoReparseAncestors -Path $Rollback -Label 'Extension rollback preimage'
      Assert-NoReparseTree -Path $Rollback -Label 'Extension rollback preimage'
    } elseif (Test-Path -LiteralPath $Destination) {
      throw 'Extension target appeared after preflight.'
    }
    Move-Item -LiteralPath $Stage -Destination $Destination
    $replacementInstalled = $true
    Assert-NoReparseAncestors -Path $Destination -Label 'Installed extension'
    Assert-NoReparseTree -Path $Destination -Label 'Installed extension'
    Assert-TreeMatches -Expected $Expected -Actual (Get-TreeManifest -Root $Destination) -Label 'Installed extension'
  } catch {
    $swapError = $_
    $rollbackErrors = @()
    if ($preimageMoved) {
      if (-not (Test-Path -LiteralPath $Rollback -PathType Container)) {
        $rollbackErrors += 'preimage:rollback directory disappeared after the committed preimage move'
      }
      if (Test-Path -LiteralPath $Destination) {
        try { Remove-Item -LiteralPath $Destination -Recurse -Force } catch {
          $rollbackErrors += "replacement:$($_.Exception.Message)"
        }
      }
      if (-not (Test-Path -LiteralPath $Destination) -and (Test-Path -LiteralPath $Rollback -PathType Container)) {
        try { Move-Item -LiteralPath $Rollback -Destination $Destination } catch {
          $rollbackErrors += "preimage:$($_.Exception.Message)"
        }
      }
    } elseif (-not $DestinationExisted -and ($replacementInstalled -or -not (Test-Path -LiteralPath $Stage))) {
      if (Test-Path -LiteralPath $Destination) {
        try { Remove-Item -LiteralPath $Destination -Recurse -Force } catch {
          $rollbackErrors += "new-target:$($_.Exception.Message)"
        }
      }
    }
    if (Test-Path -LiteralPath $Stage) {
      try { Remove-Item -LiteralPath $Stage -Recurse -Force } catch {
        $rollbackErrors += "stage:$($_.Exception.Message)"
      }
    }
    $rollbackState = if ($rollbackErrors.Count -eq 0) {
      'complete'
    } else {
      'incomplete:' + ($rollbackErrors -join ';')
    }
    throw "Extension tree swap failed; rollback=$rollbackState; cause=$($swapError.Exception.Message)"
  }

  $cleanupWarning = $null
  if (Test-Path -LiteralPath $Rollback) {
    try {
      Remove-Item -LiteralPath $Rollback -Recurse -Force
    } catch {
      $cleanupWarning = "Committed extension update, but rollback cleanup failed: $($_.Exception.Message)"
      Write-Warning $cleanupWarning
    }
  }
  return $cleanupWarning
}

function Invoke-VerifiedTreeRemoval {
  param(
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$Rollback,
    [Parameter(Mandatory)][bool]$DestinationExisted,
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$DestinationPreimage
  )
  Assert-NoReparseAncestors -Path $Destination -Label 'Extension removal destination'
  Assert-NoReparseAncestors -Path $Rollback -Label 'Extension removal rollback path'
  if (-not $DestinationExisted) {
    if (Test-Path -LiteralPath $Destination) {
      throw 'Extension target appeared after absent-state safety backup.'
    }
    return $null
  }

  $preimageMoved = $false
  try {
    Assert-NoReparseTree -Path $Destination -Label 'Extension removal preimage'
    Assert-TreeMatches `
      -Expected $DestinationPreimage `
      -Actual (Get-TreeManifest -Root $Destination) `
      -Label 'Extension removal pre-swap CAS'
    Move-Item -LiteralPath $Destination -Destination $Rollback
    $preimageMoved = $true
    Assert-NoReparseAncestors -Path $Rollback -Label 'Extension removal rollback preimage'
    Assert-NoReparseTree -Path $Rollback -Label 'Extension removal rollback preimage'
    if (Test-Path -LiteralPath $Destination) {
      throw 'Extension target remained after transactional removal move.'
    }
  } catch {
    $removalError = $_
    $rollbackErrors = @()
    if ($preimageMoved) {
      if (Test-Path -LiteralPath $Destination) {
        $rollbackErrors += 'preimage:destination reappeared before rollback'
      } elseif (Test-Path -LiteralPath $Rollback -PathType Container) {
        try { Move-Item -LiteralPath $Rollback -Destination $Destination } catch {
          $rollbackErrors += "preimage:$($_.Exception.Message)"
        }
      } else {
        $rollbackErrors += 'preimage:rollback directory disappeared'
      }
    }
    $rollbackState = if ($rollbackErrors.Count -eq 0) {
      'complete'
    } else {
      'incomplete:' + ($rollbackErrors -join ';')
    }
    throw "Extension absent-state restore failed; rollback=$rollbackState; cause=$($removalError.Exception.Message)"
  }

  $cleanupWarning = $null
  if (Test-Path -LiteralPath $Rollback) {
    try {
      Remove-Item -LiteralPath $Rollback -Recurse -Force
    } catch {
      $cleanupWarning = "Committed absent-state restore, but rollback cleanup failed: $($_.Exception.Message)"
      Write-Warning $cleanupWarning
    }
  }
  return $cleanupWarning
}

[void](Get-ExtensionDefinition -Root $source -Label 'Extension source')
Assert-NoReparseAncestors -Path $source -Label 'Extension source'
Assert-NoReparseTree -Path $source -Label 'Extension source'
Assert-NoReparseAncestors -Path $Target -Label 'Extension target'
Assert-NoReparseAncestors -Path $backupParent -Label 'Extension backup root'
$sourceFiles = Get-TreeManifest -Root $source
$targetParent = Split-Path -Parent $Target
$targetLeaf = Split-Path -Leaf $Target
$stage = Join-Path $targetParent ('.{0}.agentos-stage-{1}' -f $targetLeaf, [Guid]::NewGuid().ToString('N'))
$rollback = Join-Path $targetParent ('.{0}.agentos-rollback-{1}' -f $targetLeaf, [Guid]::NewGuid().ToString('N'))
$cleanupWarning = $null
$applyBackup = $null
$safetyBackup = $null

if (-not [string]::IsNullOrWhiteSpace($RestoreBackup)) {
  if (-not $Apply) { throw 'RestoreBackup requires -Apply.' }
  Assert-SafeDirectoryTarget -Path $Target -Recovery
  $trustedBackup = Read-TrustedExtensionBackup -Path $RestoreBackup -ExpectedTarget $Target
  $safetyBackup = New-ExtensionStateBackup `
    -StatePath $Target `
    -Suffix 'extension-safety'
  if ($trustedBackup.existed) {
    New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
    Assert-NoReparseAncestors -Path $Target -Label 'Created extension target parent'
    $cleanupWarning = Invoke-VerifiedTreeSwap `
      -From $trustedBackup.payload `
      -Expected $trustedBackup.files `
      -Destination $Target `
      -Stage $stage `
      -Rollback $rollback `
      -DestinationExisted $safetyBackup.existed `
      -DestinationPreimage $safetyBackup.files
  } else {
    $cleanupWarning = Invoke-VerifiedTreeRemoval `
      -Destination $Target `
      -Rollback $rollback `
      -DestinationExisted $safetyBackup.existed `
      -DestinationPreimage $safetyBackup.files
  }
  [pscustomobject][ordered]@{
    status = 'RESTORED'
    source = if ($trustedBackup.existed) { $trustedBackup.payload } else { $null }
    target = $Target
    existed = $trustedBackup.existed
    file_count = $trustedBackup.files.Count
    backup = $trustedBackup.root
    safety_backup = $safetyBackup.root
    cleanup_warning = $cleanupWarning
  } | ConvertTo-Json -Depth 6
  return
}

Assert-SafeDirectoryTarget -Path $Target
if ($Apply) {
  $applyBackup = New-ExtensionStateBackup `
    -StatePath $Target `
    -Suffix 'extension'
  New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
  Assert-NoReparseAncestors -Path $Target -Label 'Created extension target parent'
  $cleanupWarning = Invoke-VerifiedTreeSwap `
    -From $source `
    -Expected $sourceFiles `
    -Destination $Target `
    -Stage $stage `
    -Rollback $rollback `
    -DestinationExisted $applyBackup.existed `
    -DestinationPreimage $applyBackup.files
}

[pscustomobject][ordered]@{
  status = if ($Apply) { 'APPLIED' } else { 'PREVIEW' }
  source = $source
  target = $Target
  version = (Get-ExtensionDefinition -Root $source -Label 'Extension source').version
  file_count = $sourceFiles.Count
  backup = if ($Apply) { $applyBackup.root } else { $null }
  backup_acl = if ($Apply) { 'current-user-and-SYSTEM-only' } else { $null }
  exact_mirror = $true
  cleanup_warning = $cleanupWarning
  files = $sourceFiles
} | ConvertTo-Json -Depth 8
