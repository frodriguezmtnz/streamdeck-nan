$ErrorActionPreference = 'Stop'

$maximumInputBytes = 8192
$maximumSecretBytes = 4096
$storeDirectory = Join-Path $env:LOCALAPPDATA 'NaN Dashboard'
$storeFile = Join-Path $storeDirectory 'session-cache.bin'

function Write-Response($Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Compress))
  [Console]::Out.Write("`n")
}

function Fail {
  Write-Response @{ ok = $false; error = 'unavailable' }
  exit 1
}

function Read-StandardInput {
  $text = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($text) -gt $maximumInputBytes) { Fail }
  return $text
}

try {
  Add-Type -AssemblyName System.Security | Out-Null
  $payload = Read-StandardInput
  $request = $payload | ConvertFrom-Json
  if ($null -eq $request -or $null -eq $request.operation) { Fail }

  switch ($request.operation) {
    'put' {
      $secret = $request.secret
      if (-not ($secret -is [string]) -or $secret.Length -eq 0) { Fail }
      $bytes = [Text.Encoding]::UTF8.GetBytes($secret)
      if ($bytes.Length -gt $maximumSecretBytes) { Fail }
      if (-not (Test-Path -LiteralPath $storeDirectory)) {
        New-Item -ItemType Directory -Path $storeDirectory -Force | Out-Null
      }
      $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      $temporary = "$storeFile.tmp"
      [IO.File]::WriteAllBytes($temporary, $protected)
      Move-Item -LiteralPath $temporary -Destination $storeFile -Force
      Write-Response @{ ok = $true }
    }
    'get' {
      if (-not (Test-Path -LiteralPath $storeFile)) {
        Write-Response @{ ok = $true; secret = $null }
        exit 0
      }
      $protected = [IO.File]::ReadAllBytes($storeFile)
      $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      if ($bytes.Length -eq 0 -or $bytes.Length -gt $maximumSecretBytes) { Fail }
      Write-Response @{ ok = $true; secret = [Text.Encoding]::UTF8.GetString($bytes) }
    }
    'delete' {
      if (Test-Path -LiteralPath $storeFile) { Remove-Item -LiteralPath $storeFile -Force }
      Write-Response @{ ok = $true }
    }
    default { Fail }
  }
} catch {
  Fail
}
