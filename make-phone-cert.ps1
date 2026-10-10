# Mints a private CA and a certificate for this PC's LAN address, so a phone can
# open the ledger over https and - only over https - install it as an app.
#
#   powershell -ExecutionPolicy Bypass -File .\make-phone-cert.ps1
#   powershell -ExecutionPolicy Bypass -File .\make-phone-cert.ps1 -Force
#
# Re-run it after -Force whenever the PC's address changes; the phone keeps the
# CA, so a refreshed certificate needs nothing installed again.
param(
  [switch]$Force,
  [int]$Days = 390,
  [string]$Root = (Split-Path -Parent $MyInvocation.MyCommand.Path)
)

$ErrorActionPreference = 'Stop'
$CertDir = Join-Path $Root 'certs'

function Find-OpenSsl {
  $cmd = Get-Command openssl -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'),
    (Join-Path $env:ProgramFiles 'Git\bin\openssl.exe'),
    (Join-Path $env:USERPROFILE '.qoder\bin\git\usr\bin\openssl.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\usr\bin\openssl.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

function Invoke-OpenSsl {
  param([string[]]$Arguments, [string]$FailMessage)
  # openssl reports progress on stderr; with the script-wide Stop preference that
  # reads as a failure, so this call relaxes it and judges the exit code instead.
  $ErrorActionPreference = 'Continue'
  & $script:OpenSsl @Arguments 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$FailMessage (openssl exited with $LASTEXITCODE)" }
}

$script:OpenSsl = Find-OpenSsl
if (-not $script:OpenSsl) {
  throw 'openssl was not found. Install Git for Windows (it ships one) or run this on the machine that holds the ledger.'
}
"Using openssl: $script:OpenSsl"

if (-not (Test-Path $CertDir)) { [void](New-Item -ItemType Directory -Path $CertDir) }

# Every address a phone might be told to open: the LAN IPv4s right now, plus the
# loopback pair so the same certificate also answers https://localhost.
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.PrefixOrigin -ne 'Autoconfig' -and $_.IPAddress -notlike '169.254.*' -and -not $_.Loopback } |
  Select-Object -ExpandProperty IPAddress)
if ($ips.Count -eq 0) { $ips = @('127.0.0.1') }
if ($ips -notcontains '127.0.0.1') { $ips += '127.0.0.1' }
"Addresses this certificate will serve: $($ips -join ', ')"

$caKey = Join-Path $CertDir 'phone-ca.key'
$caPem = Join-Path $CertDir 'phone-ca.pem'
$leafKey = Join-Path $CertDir 'phone-key.pem'
$leafPem = Join-Path $CertDir 'phone-cert.pem'

# The CA is the part the phone trusts, so it is minted once and reused for years.
if (-not (Test-Path $caPem) -or -not (Test-Path $caKey)) {
  'Minting a new local CA (phone needs this one file).'
  Invoke-OpenSsl @('req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', $caKey, '-out', $caPem, '-days', '3650',
    '-subj', '/CN=Wealth Ledger Local CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign') 'Could not create the local CA.'
} else {
  'Reusing the local CA already in certs/.'
}

# Re-minting a still-valid certificate for the same addresses would only churn,
# so look at what exists first unless -Force said otherwise.
$needLeaf = $true
if ((Test-Path $leafPem) -and -not $Force) {
  $sans = (& $script:OpenSsl x509 -in $leafPem -noout -ext subjectAltName 2>$null | Out-String)
  $endLine = (& $script:OpenSsl x509 -in $leafPem -noout -enddate 2>$null | Out-String)
  $end = $null
  if ($endLine -match 'notAfter=(.*)') { $end = [DateTime]::ParseExact($Matches[1].Trim(), 'MMM d HH:mm:ss yyyy GMT', [System.Globalization.CultureInfo]::InvariantCulture) }
  $missing = @($ips | Where-Object { $sans -notmatch [regex]::Escape($_) })
  if ($end -and $missing.Count -eq 0 -and $end -gt (Get-Date).AddDays(30)) {
    "Certificate is still valid for these addresses until $end - nothing to do. Use -Force to re-mint."
    $needLeaf = $false
  } elseif ($missing.Count -gt 0) {
    "This PC's address changed ($($missing -join ', ')) - re-minting the certificate."
  } else {
    'Certificate expires within 30 days - re-minting it.'
  }
}

if ($needLeaf) {
  $san = 'IP:localhost' -replace 'IP:localhost', 'DNS:localhost'
  foreach ($ip in $ips) { $san += ",IP:$ip" }
  $ext = Join-Path $CertDir 'leaf-ext.cnf'
  $req = Join-Path $CertDir 'leaf-req.pem'
  @(
    'basicConstraints = CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    "subjectAltName = $san"
  ) | Set-Content -Path $ext -Encoding ascii

  Invoke-OpenSsl @('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', $leafKey, '-out', $req,
    '-subj', '/CN=Wealth Ledger') 'Could not create the certificate request.'
  Invoke-OpenSsl @('x509', '-req', '-in', $req, '-CA', $caPem, '-CAkey', $caKey, '-CAcreateserial',
    '-out', $leafPem, '-days', "$Days", '-extfile', $ext) 'Could not sign the certificate.'
  Remove-Item $ext, $req -ErrorAction SilentlyContinue
  'Signed certs/phone-cert.pem for this machine.'
}

""
'Now:'
"  1. Restart the ledger server so it picks up certs/ and starts listening for https."
"  2. On the phone, download wealth-ledger-ca.pem from the Phone access card in Settings and install it"
"     (Settings -> Security -> More security settings -> Encryption & credentials -> Install a certificate -> CA certificate)."
"  3. Open the https address the card shows, enter your PIN, then Chrome's menu -> Install app."
""
"Files in $CertDir"
Get-ChildItem $CertDir -Filter '*.pem' | ForEach-Object { "  $($_.Name)" }
