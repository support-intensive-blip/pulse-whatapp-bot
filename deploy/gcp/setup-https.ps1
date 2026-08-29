# Enable HTTPS on the GCP VM (Caddy + Let's Encrypt)
#
# Usage:
#   .\deploy\gcp\setup-https.ps1 -ProjectId whatsapp-bot-499606
#   .\deploy\gcp\setup-https.ps1 -ProjectId whatsapp-bot-499606 -Domain pulse.yourcompany.com
#
# Without -Domain, uses <ip>.sslip.io (free DNS → your VM IP).

param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,
  [string]$Zone = "asia-south1-a",
  [string]$InstanceName = "pulse-whatsapp-vm",
  [string]$FirewallName = "pulse-whatsapp-allow",
  [string]$Domain = "",
  [string]$AdminEmail = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$ScriptPath = Join-Path $PSScriptRoot "setup-https.sh"

gcloud config set project $ProjectId | Out-Null

Write-Host "Opening firewall ports 80 and 443..."
$rules = gcloud compute firewall-rules describe $FirewallName --format="value(allowed[].ports[])" 2>$null
if ($LASTEXITCODE -eq 0) {
  gcloud compute firewall-rules update $FirewallName --allow="tcp:22,tcp:80,tcp:443,tcp:3000" | Out-Null
} else {
  gcloud compute firewall-rules create $FirewallName `
    --direction=INGRESS `
    --priority=1000 `
    --network=default `
    --action=ALLOW `
    --rules=tcp:22,tcp:80,tcp:443,tcp:3000 `
    --source-ranges=0.0.0.0/0 `
    --target-tags=pulse-whatsapp | Out-Null
}

$publicIp = gcloud compute instances describe $InstanceName --zone=$Zone `
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)"

Write-Host "VM public IP: $publicIp"
if (-not $Domain) {
  $Domain = "pulse.nxtwave." + ($publicIp -replace '\.', '-') + ".sslip.io"
}
Write-Host "HTTPS domain: $Domain"

gcloud compute scp $ScriptPath "${InstanceName}:/tmp/setup-https.sh" --zone=$Zone --quiet
if ($LASTEXITCODE -ne 0) { throw "SCP failed" }

$domainArg = if ($Domain) { $Domain } else { "" }
$emailExport = if ($AdminEmail) { "export HTTPS_ADMIN_EMAIL='$AdminEmail';" } else { "" }

gcloud compute ssh $InstanceName --zone=$Zone --quiet --command `
  "sed -i 's/\r$//' /tmp/setup-https.sh && chmod +x /tmp/setup-https.sh && $emailExport sudo -E bash /tmp/setup-https.sh '$domainArg'"

if ($LASTEXITCODE -ne 0) { throw "HTTPS setup failed on VM" }

Write-Host ""
Write-Host "========================================"
Write-Host "HTTPS configured"
Write-Host "Dashboard: https://$Domain"
Write-Host "Health:    https://$Domain/health"
Write-Host "========================================"
Write-Host ""
Write-Host "Use https://$Domain in the browser (not http://$publicIp`:3000)."
Write-Host "Browser notifications will work on the HTTPS URL."
