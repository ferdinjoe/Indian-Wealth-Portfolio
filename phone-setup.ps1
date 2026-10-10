# Lets a phone on your Wi-Fi reach this laptop, by opening the two ledger ports
# in Windows Firewall for the network you are actually connected to - and for
# that one network category only, so the rule does not follow you to a cafe.
#
#   .\phone-setup.ps1              open the ports and print the phone address
#   .\phone-setup.ps1 -Remove      put the firewall back the way it was
#   .\phone-setup.ps1 -Profile Private   insist on Private even if you are on Public
#
# It asks Windows for administrator rights, because nothing else can change the
# firewall. Nothing here starts or stops the ledger itself.
param(
  [switch]$Remove,
  [int]$Port = 3000,
  [int]$SecurePort = 3443,
  [ValidateSet('Current', 'Private', 'Public', 'Domain', 'Any')]
  [string]$Profile = 'Current'
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The rule names are the only handle on what this script created, so -Remove can
# take exactly these away and leave every other firewall rule untouched.
function Get-RuleNames {
  @("Wealth Ledger (phone ${Port})", "Wealth Ledger (phone ${SecurePort} https)")
}

# Which network is this machine really on? The interface carrying the default
# route is the one a phone would reach, so its category decides the rule.
function Get-ActiveCategory {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric | Select-Object -First 1
  if (-not $route) { return 'Private' }
  $net = Get-NetConnectionProfile -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex } | Select-Object -First 1
  if ($net) { return $net.NetworkCategory.ToString() }
  'Private'
}

$active = Get-ActiveCategory
$target = if ($Profile -eq 'Current') { $active } else { $Profile }
# Get-NetConnectionProfile says "DomainAuthenticated"; the firewall says "Domain".
if ($target -eq 'DomainAuthenticated') { $target = 'Domain' }

if (-not (Test-Admin)) {
  Write-Host 'Needs administrator rights to change the firewall - asking now.' -ForegroundColor Yellow
  $args = "-File `"$PSCommandPath`" -Port $Port -SecurePort $SecurePort -Profile $Profile"
  if ($Remove) { $args += ' -Remove' }
  Start-Process -FilePath (Get-Command powershell.exe).Source -Verb RunAs -ArgumentList $args
  exit
}

$names = Get-RuleNames
foreach ($name in $names) {
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}

if ($Remove) {
  Write-Host "`n  This script's firewall rules are gone. Anything else that opens those ports is untouched.`n" -ForegroundColor Green
  exit
}

$ports = @($Port, $SecurePort)
for ($i = 0; $i -lt $ports.Count; $i++) {
  New-NetFirewallRule `
    -DisplayName $names[$i] `
    -Description 'Lets a phone on this network open the Wealth Ledger running on this laptop.' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ports[$i] -Profile $target | Out-Null
}

$ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress

$addresses = @()
foreach ($ip in $ips) {
  $addresses += "    https://${ip}:${SecurePort}      (installs as an app)"
  $addresses += "    http://${ip}:${Port}      (browses only)"
}

$listening = @()
foreach ($p in $ports) {
  if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { $listening += $p }
}

$notes = @()
if (-not $ips.Count) { $notes += 'No Wi-Fi or Ethernet address on this machine, so a phone has nothing to reach.' }
if ($listening -notcontains $SecurePort) {
  $notes += "Nothing is listening on ${SecurePort}: mint a certificate with make-phone-cert.ps1, then start the ledger again."
}
if ($listening -notcontains $Port) {
  $notes += 'The ledger is not running yet - open it with the Wealth Ledger shortcut.'
}
if ($target -eq 'Public') {
  $notes += "This network ('$active') is marked Public, so these ports are now open on a network other machines can see. The PIN in Settings is what keeps them out; turn phone access off when you leave home."
}
# A per-program allow rule for node.exe opens every port it listens on, which
# means the phone may already have worked before this script ran.
$node = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -like '*node*' } |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' })
if ($node) { $notes += 'Node.js already has its own inbound allow rule, so the ports may have been reachable before this script.' }

Write-Host ''
Write-Host "  Ports $Port and $SecurePort are now open to a phone on the $target network." -ForegroundColor Green
Write-Host ''
Write-Host '  Type this into Chrome on your phone:' -ForegroundColor White
if ($addresses.Count) { $addresses | ForEach-Object { Write-Host $_ } } else { Write-Host '    (none found on this machine)' }
Write-Host ''
foreach ($note in $notes) { Write-Host "  Note: $note" -ForegroundColor Yellow }
Write-Host ''
Write-Host '  Undo this any time with:  .\phone-setup.ps1 -Remove'
Write-Host ''
