Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Security -ErrorAction Stop

$script:BackupEntropy = [Text.Encoding]::UTF8.GetBytes('AgentOS.ChromeCDP.ConfigBackup.v1')
$script:SystemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$script:DefaultPrivateBase = Join-Path (
  [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
) 'AgentOS'

function Get-AgentOsCurrentUserSid {
  [CmdletBinding()]
  param()

  return [Security.Principal.WindowsIdentity]::GetCurrent().User
}

function Assert-AgentOsExactPrivateAcl {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'BLOCKED_PRIVATE_PATH_REPARSE_POINT'
  }

  $currentSid = Get-AgentOsCurrentUserSid
  $verified = Get-Acl -LiteralPath $Path
  if (-not $verified.AreAccessRulesProtected) {
    throw 'BLOCKED_PRIVATE_ACL_INHERITANCE'
  }
  $allowed = @($currentSid.Value, $script:SystemSid.Value)
  $ownerSid = $verified.GetOwner(
    [Security.Principal.SecurityIdentifier]
  ).Value
  $rules = @($verified.GetAccessRules(
    $true,
    $false,
    [Security.Principal.SecurityIdentifier]
  ))
  $actual = @($rules | ForEach-Object {
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  } | Sort-Object -Unique)
  $unexpected = @($actual | Where-Object { $_ -notin $allowed })
  $missing = @($allowed | Where-Object { $_ -notin $actual })
  $expectedInheritance = if ($item.PSIsContainer) {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $invalidRule = @($rules | Where-Object {
    $_.IsInherited -or
    $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
    (($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
      [Security.AccessControl.FileSystemRights]::FullControl) -or
    $_.InheritanceFlags -ne $expectedInheritance -or
    $_.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None
  })
  if (
    $rules.Count -ne 2 -or
    $ownerSid -notin $allowed -or
    $unexpected.Count -gt 0 -or
    $missing.Count -gt 0 -or
    $invalidRule.Count -gt 0
  ) {
    $diagnostic = @(
      "rules=$($rules.Count)"
      "owner_allowed=$($ownerSid -in $allowed)"
      "unexpected=$($unexpected.Count)"
      "missing=$($missing.Count)"
      "invalid=$($invalidRule.Count)"
    ) -join ';'
    throw "BLOCKED_PRIVATE_ACL_READBACK:$diagnostic"
  }
}

function Get-AgentOsByteSha256 {
  [CmdletBinding()]
  param([Parameter(Mandatory)][byte[]]$Bytes)

  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    return (($hasher.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $hasher.Dispose()
  }
}

function Test-AgentOsPathInsideOrEqual {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Root
  )

  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  return (
    $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
  )
}

function Assert-AgentOsPrivateRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [string]$AuthorizedBase = $script:DefaultPrivateBase
  )

  if ([string]::IsNullOrWhiteSpace($AuthorizedBase)) {
    throw 'BLOCKED_PRIVATE_AUTHORIZED_BASE_MISSING'
  }
  if (
    (Test-AgentOsPathInsideOrEqual -Path $Path -Root $RepositoryRoot) -or
    (Test-AgentOsPathInsideOrEqual -Path $RepositoryRoot -Root $Path)
  ) {
    throw 'BLOCKED_PRIVATE_ROOT_OVERLAPS_REPOSITORY'
  }
  if (-not (Test-AgentOsPathInsideOrEqual -Path $Path -Root $AuthorizedBase)) {
    throw 'BLOCKED_PRIVATE_ROOT_OUTSIDE_AUTHORIZED_BASE'
  }

  $current = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($Path))
  while ($null -ne $current) {
    if ($current.Exists -and (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'BLOCKED_PRIVATE_ROOT_REPARSE_POINT'
    }
    $current = $current.Parent
  }
}

function Set-AgentOsAccessControlCompatible {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$Item,
    [Parameter(Mandatory)]$Acl
  )

  $rawItem = $Item.PSObject.BaseObject
  $rawAcl = $Acl.PSObject.BaseObject
  $extensions = 'System.IO.FileSystemAclExtensions' -as [type]
  if ($null -eq $extensions) {
    $rawItem.SetAccessControl($rawAcl)
    return
  }
  $method = @($extensions.GetMethods() | Where-Object {
    $_.Name -eq 'SetAccessControl' -and
    $_.GetParameters().Count -eq 2 -and
    $_.GetParameters()[0].ParameterType.IsAssignableFrom($rawItem.GetType()) -and
    $_.GetParameters()[1].ParameterType.IsAssignableFrom($rawAcl.GetType())
  } | Select-Object -First 1)
  if ($method.Count -ne 1) {
    throw 'BLOCKED_PRIVATE_ACL_API_UNAVAILABLE'
  }
  [void]$method[0].Invoke($null, [object[]]@($rawItem, $rawAcl))
}

function Set-AgentOsExactPrivateAcl {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)

  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'BLOCKED_PRIVATE_PATH_REPARSE_POINT'
  }

  $currentSid = Get-AgentOsCurrentUserSid
  $security = if ($item.PSIsContainer) {
    [Security.AccessControl.DirectorySecurity]::new()
  } else {
    [Security.AccessControl.FileSecurity]::new()
  }
  $security.SetAccessRuleProtection($true, $false)
  foreach ($existingRule in @($security.GetAccessRules(
    $true,
    $true,
    [Security.Principal.SecurityIdentifier]
  ))) {
    [void]$security.RemoveAccessRuleSpecific($existingRule)
  }
  if ($item.PSIsContainer) {
    $inheritance = (
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
  } else {
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  foreach ($sid in @($currentSid, $script:SystemSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  # Set only the DACL. PowerShell's Set-Acl also attempts to persist security
  # sections that can require SeSecurityPrivilege on an ordinary desktop
  # session, even though this operation does not need that privilege.
  Set-AgentOsAccessControlCompatible -Item $item -Acl $security

  Assert-AgentOsExactPrivateAcl -Path $Path
}

function Initialize-AgentOsPrivateDirectory {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$RepositoryRoot,
    [string]$AuthorizedBase = $script:DefaultPrivateBase
  )

  Assert-AgentOsPrivateRoot -Path $Path -RepositoryRoot $RepositoryRoot -AuthorizedBase $AuthorizedBase
  [void](New-Item -ItemType Directory -Force -Path $Path)
  Set-AgentOsExactPrivateAcl -Path $Path
  foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force -Recurse)) {
    Set-AgentOsExactPrivateAcl -Path $child.FullName
  }
  return [IO.Path]::GetFullPath($Path)
}

function Write-AgentOsPrivateBytesAtomic {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][byte[]]$Bytes
  )

  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    throw 'BLOCKED_PRIVATE_PARENT_MISSING'
  }
  if (-not (Test-AgentOsPathInsideOrEqual -Path $Path -Root $script:DefaultPrivateBase)) {
    throw 'BLOCKED_PRIVATE_PATH_OUTSIDE_AUTHORIZED_BASE'
  }
  Set-AgentOsExactPrivateAcl -Path $directory
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetRandomFileName())
  try {
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    Set-AgentOsExactPrivateAcl -Path $temporary
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    Set-AgentOsExactPrivateAcl -Path $Path
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Protect-AgentOsBackupFile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$DestinationPath
  )

  $plain = [IO.File]::ReadAllBytes($SourcePath)
  $protected = $null
  try {
    $protected = [Security.Cryptography.ProtectedData]::Protect(
      $plain,
      $script:BackupEntropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    Write-AgentOsPrivateBytesAtomic -Path $DestinationPath -Bytes $protected
    return [pscustomobject][ordered]@{
      source_sha256 = Get-AgentOsByteSha256 -Bytes $plain
      protected_sha256 = Get-AgentOsByteSha256 -Bytes $protected
      source_bytes = $plain.Length
      protected_bytes = $protected.Length
      protection = 'DPAPI-CurrentUser'
    }
  } finally {
    if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
    if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }
  }
}

function Restore-AgentOsProtectedBackup {
  [CmdletBinding(SupportsShouldProcess)]
  param(
    [Parameter(Mandatory)][string]$ProtectedPath,
    [Parameter(Mandatory)][string]$DestinationPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSourceSha256
  )

  $ciphertext = [IO.File]::ReadAllBytes($ProtectedPath)
  $plain = $null
  try {
    $plain = [Security.Cryptography.ProtectedData]::Unprotect(
      $ciphertext,
      $script:BackupEntropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $actual = Get-AgentOsByteSha256 -Bytes $plain
    if ($actual -ne $ExpectedSourceSha256) {
      throw 'BLOCKED_BACKUP_PLAINTEXT_HASH'
    }
    if ($PSCmdlet.ShouldProcess($DestinationPath, 'restore DPAPI-protected configuration backup')) {
      $directory = Split-Path -Parent $DestinationPath
      [void](New-Item -ItemType Directory -Force -Path $directory)
      $temporary = Join-Path $directory ('.' + [IO.Path]::GetRandomFileName())
      try {
        [IO.File]::WriteAllBytes($temporary, $plain)
        Move-Item -LiteralPath $temporary -Destination $DestinationPath -Force
      } finally {
        if (Test-Path -LiteralPath $temporary) {
          Remove-Item -LiteralPath $temporary -Force
        }
      }
    }
    return [pscustomobject][ordered]@{
      status = if ($WhatIfPreference) { 'PREVIEW' } else { 'RESTORED' }
      destination = $DestinationPath
      sha256 = $actual
    }
  } finally {
    if ($null -ne $ciphertext) { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
    if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
  }
}

Export-ModuleMember -Function @(
  'Assert-AgentOsExactPrivateAcl',
  'Assert-AgentOsPrivateRoot',
  'Initialize-AgentOsPrivateDirectory',
  'Protect-AgentOsBackupFile',
  'Restore-AgentOsProtectedBackup',
  'Set-AgentOsExactPrivateAcl',
  'Test-AgentOsPathInsideOrEqual',
  'Write-AgentOsPrivateBytesAtomic'
)
