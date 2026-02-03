Param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function New-RandomHex([int]$bytes) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $b = New-Object byte[] $bytes
  $rng.GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

function Write-IfMissing($name, $value) {
  $path = Join-Path $dir $name
  if ((Test-Path $path) -and -not $Force) {
    $len = (Get-Item $path).Length
    if ($len -gt 0) { Write-Host "[OK] exists: $name"; return }
  }
  Set-Content -NoNewline -Encoding UTF8 -Path $path -Value $value
  Write-Host "[NEW] created: $name"
}

Write-IfMissing 'postgres_password.txt' (New-RandomHex 32)
Write-IfMissing 'jwt_secret.txt' (New-RandomHex 32)
Write-IfMissing 'refresh_pepper.txt' (New-RandomHex 32)

$smtp = Join-Path $dir 'smtp_pass.txt'
if (-not (Test-Path $smtp) -or $Force) {
  Set-Content -NoNewline -Encoding UTF8 -Path $smtp -Value ''
  Write-Host "[NEW] created: smtp_pass.txt (empty)"
} else {
  Write-Host "[OK] exists: smtp_pass.txt"
}

Write-Host "`nDone. Mount these via docker compose secrets."
