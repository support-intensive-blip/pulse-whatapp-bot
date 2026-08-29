# Deploy Pulse WhatsApp bot to AWS EC2 (Docker)
# Usage:
#   .\deploy\aws\deploy.ps1 -Region ap-south-1 -KeyName my-key -KeyPath C:\keys\my-key.pem
#   .\deploy\aws\deploy.ps1 -InstanceId i-0abc123... -KeyPath C:\keys\my-key.pem

param(
  [string]$Region = "ap-south-1",
  [string]$InstanceName = "pulse-whatsapp-vm",
  [string]$InstanceType = "t3.medium",
  [string]$KeyName = "",
  [string]$KeyPath = "",
  [string]$InstanceId = "",
  [string]$SecurityGroupName = "pulse-whatsapp-sg"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

function Invoke-Aws {
  param([string[]]$AwsArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & aws @AwsArgs 2>&1 | Out-Host
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
  $ErrorActionPreference = $prev
  return [int]$code
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "AWS CLI not found. Install: https://aws.amazon.com/cli/"
}

if (-not $KeyPath -or -not (Test-Path $KeyPath)) {
  throw "KeyPath is required (path to your .pem SSH key). Example: -KeyPath C:\keys\my-key.pem"
}

Write-Host "Region: $Region"
Write-Host "Instance: $InstanceName"

# Resolve or create EC2 instance
if ($InstanceId) {
  $inst = aws ec2 describe-instances --instance-ids $InstanceId --region $Region --query "Reservations[0].Instances[0]" --output json | ConvertFrom-Json
  if (-not $inst -or $inst.State.Name -eq "terminated") {
    throw "Instance $InstanceId not found or terminated"
  }
} else {
  $existing = aws ec2 describe-instances --region $Region `
    --filters "Name=tag:Name,Values=$InstanceName" "Name=instance-state-name,Values=running,stopped,pending" `
    --query "Reservations[0].Instances[0].InstanceId" --output text 2>$null

  if ($existing -and $existing -ne "None") {
    $InstanceId = $existing.Trim()
    Write-Host "Using existing instance: $InstanceId"
  } else {
    if (-not $KeyName) {
      throw "KeyName is required to create a new instance (EC2 key pair name in AWS)"
    }

    Write-Host "Creating security group..."
    $vpcId = aws ec2 describe-vpcs --region $Region --filters "Name=isDefault,Values=true" `
      --query "Vpcs[0].VpcId" --output text

    $sgId = aws ec2 describe-security-groups --region $Region `
      --filters "Name=group-name,Values=$SecurityGroupName" "Name=vpc-id,Values=$vpcId" `
      --query "SecurityGroups[0].GroupId" --output text 2>$null

    if (-not $sgId -or $sgId -eq "None") {
      $sgId = aws ec2 create-security-group --region $Region `
        --group-name $SecurityGroupName `
        --description "Pulse WhatsApp dashboard port 3000" `
        --vpc-id $vpcId --query "GroupId" --output text
      aws ec2 authorize-security-group-ingress --region $Region --group-id $sgId --protocol tcp --port 22 --cidr 0.0.0.0/0 | Out-Null
      aws ec2 authorize-security-group-ingress --region $Region --group-id $sgId --protocol tcp --port 3000 --cidr 0.0.0.0/0 | Out-Null
      Write-Host "Created security group: $sgId"
    } else {
      Write-Host "Using security group: $sgId"
    }

    $amiId = aws ec2 describe-images --region $Region --owners 099720109477 `
      --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" "Name=state,Values=available" `
      --query "sort_by(Images, &CreationDate)[-1].ImageId" --output text

    $blockMappingsFile = Join-Path $env:TEMP "pulse-ec2-block-mappings.json"
    @'
[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]
'@ | Set-Content -Path $blockMappingsFile -Encoding ascii -NoNewline

    Write-Host "Launching $InstanceType with AMI $amiId..."
    $blockFileUri = "file://" + ($blockMappingsFile -replace '\\', '/')
    $InstanceId = aws ec2 run-instances --region $Region `
      --image-id $amiId `
      --instance-type $InstanceType `
      --key-name $KeyName `
      --security-group-ids $sgId `
      --block-device-mappings $blockFileUri `
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$InstanceName}]" `
      --query "Instances[0].InstanceId" --output text

    if (-not $InstanceId -or $InstanceId -match "error|Error") {
      throw "Failed to create EC2 instance"
    }

    Write-Host "Waiting for instance to run..."
    aws ec2 wait instance-running --region $Region --instance-ids $InstanceId | Out-Null
  }
}

# Start if stopped
$state = aws ec2 describe-instances --region $Region --instance-ids $InstanceId `
  --query "Reservations[0].Instances[0].State.Name" --output text
if ($state -eq "stopped") {
  Write-Host "Starting stopped instance..."
  aws ec2 start-instances --region $Region --instance-ids $InstanceId | Out-Null
  aws ec2 wait instance-running --region $Region --instance-ids $InstanceId | Out-Null
}

$publicIp = aws ec2 describe-instances --region $Region --instance-ids $InstanceId `
  --query "Reservations[0].Instances[0].PublicIpAddress" --output text

if (-not $publicIp -or $publicIp -eq "None") {
  throw "No public IP on instance. Assign an Elastic IP or enable auto-assign public IP in the subnet."
}

Write-Host "Public IP: $publicIp"
Write-Host "Waiting for SSH (up to 3 min)..."
$sshReady = $false
for ($i = 0; $i -lt 36; $i++) {
  ssh -i $KeyPath -o StrictHostKeyChecking=no -o ConnectTimeout=5 "ubuntu@${publicIp}" "echo ok" 2>$null
  if ($LASTEXITCODE -eq 0) { $sshReady = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $sshReady) { throw "SSH not ready on ubuntu@${publicIp}" }

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

$tarSize = (Get-Item $TarPath).Length
Write-Host "Archive size: $([math]::Round($tarSize / 1MB, 2)) MB"

Write-Host "Uploading to EC2..."
scp -i $KeyPath -o StrictHostKeyChecking=no $TarPath "ubuntu@${publicIp}:/tmp/whatsapp-bot-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "SCP upload failed" }

$RemoteScriptPath = Join-Path $PSScriptRoot "remote-deploy.sh"
scp -i $KeyPath -o StrictHostKeyChecking=no $RemoteScriptPath "ubuntu@${publicIp}:/tmp/remote-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "SCP script upload failed" }

Write-Host "Installing and starting on EC2 (Docker build may take several minutes)..."
ssh -i $KeyPath -o StrictHostKeyChecking=no "ubuntu@${publicIp}" `
  "sed -i 's/\r$//' /tmp/remote-deploy.sh && chmod +x /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed" }

Write-Host ""
Write-Host "========================================"
Write-Host "AWS deployment complete"
Write-Host "Instance:  $InstanceId"
Write-Host "Region:    $Region"
Write-Host "Dashboard: http://${publicIp}:3000"
Write-Host "Health:    http://${publicIp}:3000/health"
Write-Host "========================================"
Write-Host ""
Write-Host "First time: SSH in and edit /opt/whatsapp-ai-assistant/.env"
Write-Host "  ssh -i `"$KeyPath`" ubuntu@${publicIp}"
Write-Host "  sudo nano /opt/whatsapp-ai-assistant/.env"
Write-Host "Then restart: cd /opt/whatsapp-ai-assistant && sudo docker compose restart"
Write-Host ""
Write-Host "Login: DASHBOARD_ADMIN_EMAIL / DASHBOARD_ADMIN_PASSWORD from .env"
