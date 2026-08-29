# Copy SQLite DB, knowledge-base PDFs, and WhatsApp session from AWS EC2 to GCP GCE.
#
# Usage:
#   .\deploy\gcp\migrate-from-aws.ps1 `
#     -GcpProjectId your-new-project-id `
#     -AwsHost 13.233.113.165 `
#     -AwsKeyPath "$env:TEMP\pulse-whatsapp-key-fixed.pem"

param(
  [Parameter(Mandatory = $true)]
  [string]$GcpProjectId,
  [string]$GcpZone = "asia-south1-a",
  [string]$GcpInstance = "pulse-whatsapp-vm",
  [Parameter(Mandatory = $true)]
  [string]$AwsHost,
  [Parameter(Mandatory = $true)]
  [string]$AwsKeyPath
)

$ErrorActionPreference = "Stop"
$Staging = Join-Path $env:TEMP "pulse-migrate-$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Path $Staging -Force | Out-Null

Write-Host "Staging: $Staging"
Write-Host "Pulling data from AWS ubuntu@$AwsHost ..."

scp -i $AwsKeyPath -o StrictHostKeyChecking=no `
  "ubuntu@${AwsHost}:/opt/whatsapp-ai-assistant/data/assistant.db" `
  "$Staging/assistant.db"

scp -i $AwsKeyPath -o StrictHostKeyChecking=no -r `
  "ubuntu@${AwsHost}:/opt/whatsapp-ai-assistant/knowledge-base" `
  "$Staging/knowledge-base" 2>$null

# WhatsApp session lives in Docker volume — export via temporary container on AWS
ssh -i $AwsKeyPath -o StrictHostKeyChecking=no ubuntu@$AwsHost @'
set -e
cd /opt/whatsapp-ai-assistant
sudo docker run --rm -v whatsapp-ai-assistant_wwebjs_auth:/from:ro -v /tmp:/to alpine tar czf /to/wwebjs_auth.tar.gz -C /from .
'@

scp -i $AwsKeyPath -o StrictHostKeyChecking=no `
  "ubuntu@${AwsHost}:/tmp/wwebjs_auth.tar.gz" `
  "$Staging/wwebjs_auth.tar.gz"

# Copy .env as reference (review secrets before using)
scp -i $AwsKeyPath -o StrictHostKeyChecking=no `
  "ubuntu@${AwsHost}:/opt/whatsapp-ai-assistant/.env" `
  "$Staging/aws.env.reference" 2>$null

Write-Host "Pushing data to GCP $GcpInstance ..."
gcloud config set project $GcpProjectId | Out-Null

gcloud compute scp "$Staging/assistant.db" "${GcpInstance}:/tmp/assistant.db" --zone=$GcpZone --quiet
if (Test-Path "$Staging/knowledge-base") {
  gcloud compute scp --recurse "$Staging/knowledge-base" "${GcpInstance}:/tmp/knowledge-base" --zone=$GcpZone --quiet
}
gcloud compute scp "$Staging/wwebjs_auth.tar.gz" "${GcpInstance}:/tmp/wwebjs_auth.tar.gz" --zone=$GcpZone --quiet
if (Test-Path "$Staging/aws.env.reference") {
  gcloud compute scp "$Staging/aws.env.reference" "${GcpInstance}:/tmp/aws.env.reference" --zone=$GcpZone --quiet
}

gcloud compute ssh $GcpInstance --zone=$GcpZone --quiet --command @'
set -e
sudo mkdir -p /opt/whatsapp-ai-assistant/data /opt/whatsapp-ai-assistant/knowledge-base
sudo cp /tmp/assistant.db /opt/whatsapp-ai-assistant/data/assistant.db
if [ -d /tmp/knowledge-base ]; then
  sudo cp -a /tmp/knowledge-base/. /opt/whatsapp-ai-assistant/knowledge-base/
fi
if [ -f /tmp/aws.env.reference ] && [ ! -f /opt/whatsapp-ai-assistant/.env ]; then
  sudo cp /tmp/aws.env.reference /opt/whatsapp-ai-assistant/.env
fi
sudo docker volume create wwebjs_auth 2>/dev/null || true
sudo docker run --rm -v wwebjs_auth:/to -v /tmp:/from alpine sh -c "rm -rf /to/* && tar xzf /from/wwebjs_auth.tar.gz -C /to"
cd /opt/whatsapp-ai-assistant && sudo docker compose restart
echo "Migration applied on GCP VM"
'@

Write-Host ""
Write-Host "Migration complete. Review /opt/whatsapp-ai-assistant/.env on GCP before going live."
Write-Host "Staging files kept at: $Staging"
