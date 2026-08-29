# Deploy Pulse WhatsApp bot to Google Cloud Compute Engine (Docker)
#
# Prerequisites:
#   1. New Google account + GCP project created
#   2. gcloud CLI installed: https://cloud.google.com/sdk/docs/install
#   3. gcloud auth login   (use your NEW Gmail)
#   4. Billing enabled on the project
#
# Usage:
#   .\deploy\gcp\deploy.ps1 -ProjectId your-new-project-id
#   .\deploy\gcp\deploy.ps1 -ProjectId your-new-project-id -Zone asia-south1-a

param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,
  [string]$Zone = "asia-south1-a",
  [string]$Region = "asia-south1",
  [string]$InstanceName = "pulse-whatsapp-vm",
  [string]$MachineType = "e2-medium",
  [int]$DiskGb = 30
)

$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$FirewallName = "pulse-whatsapp-allow"
$NetworkTag = "pulse-whatsapp"

function Invoke-Gcloud {
  param([string[]]$GcloudArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & gcloud @GcloudArgs 2>&1 | Out-Host
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
  $ErrorActionPreference = $prev
  if ([int]$code -ne 0) { throw "gcloud failed: gcloud $($GcloudArgs -join ' ')" }
}

function Test-GcloudResource {
  param([string[]]$GcloudArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $out = & gcloud @GcloudArgs 2>$null
  $ok = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $prev
  return ($ok -and $out)
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
}

Write-Host "Project:  $ProjectId"
Write-Host "Zone:     $Zone"
Write-Host "Instance: $InstanceName ($MachineType)"

Invoke-Gcloud -GcloudArgs @("config", "set", "account", "bhanukiran750@gmail.com")
Invoke-Gcloud -GcloudArgs @("config", "set", "project", $ProjectId)
Invoke-Gcloud -GcloudArgs @("services", "enable", "compute.googleapis.com", "--quiet")

$fwExists = Test-GcloudResource @("compute", "firewall-rules", "describe", $FirewallName, "--format=value(name)")
if (-not $fwExists) {
  Write-Host "Creating firewall rule (tcp:22, tcp:80, tcp:443, tcp:3000)..."
  Invoke-Gcloud -GcloudArgs @(
    "compute", "firewall-rules", "create", $FirewallName,
    "--direction=INGRESS",
    "--priority=1000",
    "--network=default",
    "--action=ALLOW",
    "--rules=tcp:22,tcp:80,tcp:443,tcp:3000",
    "--source-ranges=0.0.0.0/0",
    "--target-tags=$NetworkTag"
  )
} else {
  Write-Host "Using firewall rule: $FirewallName"
}

$existing = Test-GcloudResource @("compute", "instances", "describe", $InstanceName, "--zone=$Zone", "--format=value(name)")
if (-not $existing) {
  Write-Host "Creating VM $InstanceName..."
  Invoke-Gcloud -GcloudArgs @(
    "compute", "instances", "create", $InstanceName,
    "--zone=$Zone",
    "--machine-type=$MachineType",
    "--boot-disk-size=${DiskGb}GB",
    "--boot-disk-type=pd-balanced",
    "--image-family=ubuntu-2204-lts",
    "--image-project=ubuntu-os-cloud",
    "--tags=$NetworkTag",
    "--service-account=whatsppbotdatabase@${ProjectId}.iam.gserviceaccount.com",
    "--scopes=https://www.googleapis.com/auth/cloud-platform"
  )
} else {
  Write-Host "Using existing VM: $InstanceName"
  $status = gcloud compute instances describe $InstanceName --zone=$Zone --format="value(status)"
  if ($status -eq "TERMINATED") {
    Write-Host "Starting terminated VM..."
    Invoke-Gcloud -GcloudArgs @("compute", "instances", "start", $InstanceName, "--zone=$Zone")
  }
}

$publicIp = gcloud compute instances describe $InstanceName --zone=$Zone `
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)"

if (-not $publicIp) { throw "VM has no external IP" }
Write-Host "Public IP: $publicIp"

Write-Host "Waiting for SSH (up to 3 min)..."
$sshReady = $false
for ($i = 0; $i -lt 36; $i++) {
  gcloud compute ssh $InstanceName --zone=$Zone --command="echo ok" --quiet 2>$null
  if ($LASTEXITCODE -eq 0) { $sshReady = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $sshReady) { throw "SSH not ready on $InstanceName" }

$TarPath = Join-Path $env:TEMP "whatsapp-bot-deploy.tar.gz"
if (Test-Path $TarPath) { Remove-Item $TarPath -Force }

Write-Host "Creating deployment archive..."
Push-Location $Root
try {
  & tar --exclude=node_modules --exclude=.wwebjs_auth --exclude=.wwebjs_cache --exclude=logs --exclude=data `
    --exclude=uploads --exclude=tmp --exclude=knowledge-base --exclude=.env --exclude=.git `
    --exclude=dashboard/node_modules --exclude=secrets --exclude="whatsapp-bot-big query.json" `
    -czf $TarPath .
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally {
  Pop-Location
}

Write-Host "Archive size: $([math]::Round((Get-Item $TarPath).Length / 1MB, 2)) MB"
Write-Host "Uploading to GCE..."
gcloud compute scp $TarPath "${InstanceName}:/tmp/whatsapp-bot-deploy.tar.gz" --zone=$Zone --quiet
if ($LASTEXITCODE -ne 0) { throw "SCP upload failed" }

$RemoteScriptPath = Join-Path $PSScriptRoot "remote-deploy.sh"
gcloud compute scp $RemoteScriptPath "${InstanceName}:/tmp/remote-deploy.sh" --zone=$Zone --quiet
if ($LASTEXITCODE -ne 0) { throw "SCP script upload failed" }

Write-Host "Installing Docker app on VM (build may take several minutes)..."
gcloud compute ssh $InstanceName --zone=$Zone --quiet --command `
  "sed -i 's/\r$//' /tmp/remote-deploy.sh && chmod +x /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed" }

$LocalEnv = Join-Path $Root ".env"
if (Test-Path $LocalEnv) {
  Write-Host "Uploading .env (secrets + Pinecone)..."
  gcloud compute scp $LocalEnv "${InstanceName}:/tmp/pulse.env" --zone=$Zone --quiet
  gcloud compute ssh $InstanceName --zone=$Zone --quiet --command @'
set -e
sudo cp /tmp/pulse.env /opt/whatsapp-ai-assistant/.env
sudo sed -i '/^GOOGLE_APPLICATION_CREDENTIALS=/d' /opt/whatsapp-ai-assistant/.env
grep -q '^LOCAL_MESSAGE_STORE=' /opt/whatsapp-ai-assistant/.env || echo 'LOCAL_MESSAGE_STORE=true' | sudo tee -a /opt/whatsapp-ai-assistant/.env >/dev/null
# Prefer durable disk SQLite (source of truth) with optional BigQuery write-through.
# Do NOT force SQLITE_ENABLED=false — that makes chats in-memory and loses them on restart.
grep -q '^BQ_ENABLED=' /opt/whatsapp-ai-assistant/.env || echo 'BQ_ENABLED=true' | sudo tee -a /opt/whatsapp-ai-assistant/.env >/dev/null
if ! grep -q '^SQLITE_ENABLED=' /opt/whatsapp-ai-assistant/.env; then
  echo 'SQLITE_ENABLED=true' | sudo tee -a /opt/whatsapp-ai-assistant/.env >/dev/null
fi
sudo sed -i 's|^SQLITE_ENABLED=false|SQLITE_ENABLED=true|' /opt/whatsapp-ai-assistant/.env
# One-time empty-disk seed is handled in code (BQ_HYDRATE_IF_EMPTY=true by default).
grep -q '^BQ_HYDRATE_IF_EMPTY=' /opt/whatsapp-ai-assistant/.env || echo 'BQ_HYDRATE_IF_EMPTY=true' | sudo tee -a /opt/whatsapp-ai-assistant/.env >/dev/null
cd /opt/whatsapp-ai-assistant && sudo docker-compose restart
'@
  Write-Host "Running Pinecone setup + team KB ingest..."
  gcloud compute scp (Join-Path (Split-Path $PSScriptRoot -Parent) "aws\setup-pinecone-remote.sh") "${InstanceName}:/tmp/setup-pinecone-remote.sh" --zone=$Zone --quiet
  gcloud compute ssh $InstanceName --zone=$Zone --quiet --command `
    "sed -i 's/\r$//' /tmp/setup-pinecone-remote.sh && chmod +x /tmp/setup-pinecone-remote.sh && sudo mkdir -p /opt/whatsapp-ai-assistant/deploy/aws && sudo cp /tmp/setup-pinecone-remote.sh /opt/whatsapp-ai-assistant/deploy/aws/setup-pinecone-remote.sh && sudo bash /tmp/setup-pinecone-remote.sh"
}

Write-Host ""
Write-Host "========================================"
Write-Host "GCP deployment complete"
Write-Host "Project:   $ProjectId"
Write-Host "Zone:      $Zone"
Write-Host "Instance:  $InstanceName"
Write-Host "Dashboard: http://${publicIp}:3000"
Write-Host "Health:    http://${publicIp}:3000/health"
Write-Host "========================================"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. SSH:  gcloud compute ssh $InstanceName --zone=$Zone"
Write-Host "  2. Edit: sudo nano /opt/whatsapp-ai-assistant/.env"
Write-Host "     (OPENAI_API_KEY, PINECONE_API_KEY, dashboard login, etc.)"
Write-Host "  3. Restart: cd /opt/whatsapp-ai-assistant && sudo docker compose restart"
Write-Host ""
Write-Host "Migrate data from AWS:"
Write-Host "  .\deploy\gcp\migrate-from-aws.ps1 -GcpProjectId $ProjectId -AwsHost <old-ip> -AwsKeyPath <key.pem>"
