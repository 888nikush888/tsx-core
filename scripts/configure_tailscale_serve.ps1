param(
  [ValidateRange(1, 65535)]
  [int]$DashboardPort = 8080,
  [ValidateRange(1, 65535)]
  [int]$HttpsPort = 443
)

$ErrorActionPreference = "Stop"
$tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscaleCommand) {
  throw "Tailscale CLI wurde nicht gefunden. Installiere Tailscale auf dem Docker-Host und melde das Gerät im Tailnet an."
}

$statusJson = & $tailscaleCommand.Source status --json
if ($LASTEXITCODE -ne 0) {
  throw "Tailscale-Status konnte nicht gelesen werden."
}
$status = $statusJson | ConvertFrom-Json
if ($status.BackendState -ne "Running") {
  throw "Tailscale läuft nicht oder das Gerät ist nicht mit dem Tailnet verbunden."
}

& $tailscaleCommand.Source funnel "--https=$HttpsPort" off | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Ein möglicherweise öffentlicher Funnel-Endpunkt konnte nicht sicher deaktiviert werden."
}

$target = "http://127.0.0.1:$DashboardPort"
& $tailscaleCommand.Source serve --bg "--https=$HttpsPort" $target
if ($LASTEXITCODE -ne 0) {
  throw "Tailscale Serve konnte nicht für $target konfiguriert werden."
}

$dnsName = [string]$status.Self.DNSName
if (-not $dnsName) {
  throw "Tailscale meldet keinen MagicDNS-Namen für dieses Gerät."
}
$dnsName = $dnsName.TrimEnd(".")
$origin = if ($HttpsPort -eq 443) { "https://$dnsName" } else { "https://${dnsName}:$HttpsPort" }

Write-Output "Tailscale Serve ist tailnet-intern aktiv: $origin"
Write-Output "Backend-Ziel: $target (weiterhin nur Host-Loopback)"
Write-Output "Setze in TSX Core: Authentifizierung = Tailscale Serve Identity, Origin = $origin, mindestens einen Tailscale Admin-Login; danach kontrolliert neu starten."
