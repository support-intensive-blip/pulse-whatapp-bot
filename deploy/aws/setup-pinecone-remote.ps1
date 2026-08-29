# Run Pinecone setup on EC2 via SSH (no full deploy).
# Usage:
#   .\deploy\aws\setup-pinecone-remote.ps1 -KeyPath C:\keys\key.pem -PineconeApiKey pcsk_...

param(
  [string]$Region = "ap-south-1",
  [string]$InstanceId = "i-08eafa9e546c380cd",
  [Parameter(Mandatory = $true)]
  [string]$KeyPath,
  [Parameter(Mandatory = $true)]
  [string]$PineconeApiKey,
  [string]$HostIp = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

if (-not $HostIp) {
  $HostIp = aws ec2 describe-instances --instance-ids $InstanceId --region $Region `
    --query "Reservations[0].Instances[0].PublicIpAddress" --output text
}

if (-not $HostIp -or $HostIp -eq "None") {
  throw "Instance has no public IP. Start the EC2 instance first."
}

$scriptLocal = Join-Path $PSScriptRoot "setup-pinecone-remote.sh"
$scriptRemote = "/tmp/setup-pinecone-remote.sh"

Write-Host "Server: ubuntu@$HostIp"
scp -i $KeyPath -o StrictHostKeyChecking=no $scriptLocal "ubuntu@${HostIp}:$scriptRemote"
ssh -i $KeyPath -o StrictHostKeyChecking=no "ubuntu@$HostIp" `
  "chmod +x $scriptRemote && sudo cp $scriptRemote /opt/whatsapp-ai-assistant/deploy/aws/setup-pinecone-remote.sh 2>/dev/null || sudo mkdir -p /opt/whatsapp-ai-assistant/deploy/aws && sudo cp $scriptRemote /opt/whatsapp-ai-assistant/deploy/aws/setup-pinecone-remote.sh; PINECONE_API_KEY='$PineconeApiKey' sudo -E bash /opt/whatsapp-ai-assistant/deploy/aws/setup-pinecone-remote.sh"

Write-Host "Pinecone setup finished. Dashboard: http://${HostIp}:3000"
