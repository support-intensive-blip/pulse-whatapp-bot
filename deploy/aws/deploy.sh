#!/usr/bin/env bash
# Deploy Pulse to AWS EC2 — bash version (Linux/macOS/WSL)
# Usage:
#   ./deploy/aws/deploy.sh --region ap-south-1 --key-name my-key --key-path ~/.ssh/my-key.pem

set -euo pipefail

REGION="ap-south-1"
INSTANCE_NAME="pulse-whatsapp-vm"
INSTANCE_TYPE="t3.medium"
KEY_NAME=""
KEY_PATH=""
INSTANCE_ID=""
SG_NAME="pulse-whatsapp-sg"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --key-name) KEY_NAME="$2"; shift 2 ;;
    --key-path) KEY_PATH="$2"; shift 2 ;;
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --instance-name) INSTANCE_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

command -v aws >/dev/null || { echo "Install AWS CLI first"; exit 1; }
[[ -n "$KEY_PATH" && -f "$KEY_PATH" ]] || { echo "--key-path required (path to .pem)"; exit 1; }
chmod 400 "$KEY_PATH" 2>/dev/null || true

SSH_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=no -o ConnectTimeout=10)
SCP_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=no)

resolve_instance() {
  if [[ -n "$INSTANCE_ID" ]]; then
    echo "$INSTANCE_ID"
    return
  fi
  local existing
  existing=$(aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=$INSTANCE_NAME" "Name=instance-state-name,Values=running,stopped,pending" \
    --query "Reservations[0].Instances[0].InstanceId" --output text 2>/dev/null || true)
  if [[ -n "$existing" && "$existing" != "None" ]]; then
    echo "$existing"
    return
  fi
  [[ -n "$KEY_NAME" ]] || { echo "KEY_NAME required for new instance" >&2; exit 1; }

  local vpc_id sg_id ami_id
  vpc_id=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query "Vpcs[0].VpcId" --output text)
  sg_id=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$vpc_id" \
    --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || true)
  if [[ -z "$sg_id" || "$sg_id" == "None" ]]; then
    sg_id=$(aws ec2 create-security-group --region "$REGION" --group-name "$SG_NAME" \
      --description "Pulse WhatsApp dashboard" --vpc-id "$vpc_id" --query GroupId --output text)
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$sg_id" --protocol tcp --port 22 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$sg_id" --protocol tcp --port 3000 --cidr 0.0.0.0/0
  fi
  ami_id=$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" "Name=state,Values=available" \
    --query "sort_by(Images, &CreationDate)[-1].ImageId" --output text)
  aws ec2 run-instances --region "$REGION" --image-id "$ami_id" --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$sg_id" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME}]" \
    --query "Instances[0].InstanceId" --output text
}

INSTANCE_ID=$(resolve_instance)
echo "Instance: $INSTANCE_ID"

STATE=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].State.Name" --output text)
if [[ "$STATE" == "stopped" ]]; then
  aws ec2 start-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
fi

PUBLIC_IP=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].PublicIpAddress" --output text)
[[ -n "$PUBLIC_IP" && "$PUBLIC_IP" != "None" ]] || { echo "No public IP"; exit 1; }

echo "Waiting for SSH on $PUBLIC_IP..."
for _ in $(seq 1 36); do
  ssh "${SSH_OPTS[@]}" "ubuntu@${PUBLIC_IP}" "echo ok" 2>/dev/null && break
  sleep 5
done

TAR="/tmp/whatsapp-bot-deploy.tar.gz"
rm -f "$TAR"
tar -C "$ROOT" --exclude=node_modules --exclude=.wwebjs_auth --exclude=.wwebjs_cache \
  --exclude=logs --exclude=data --exclude=uploads --exclude=tmp --exclude=knowledge-base \
  --exclude=.env --exclude=.git --exclude=dashboard/node_modules --exclude=secrets \
  -czf "$TAR" .

scp "${SCP_OPTS[@]}" "$TAR" "ubuntu@${PUBLIC_IP}:/tmp/whatsapp-bot-deploy.tar.gz"
scp "${SCP_OPTS[@]}" "$ROOT/deploy/aws/remote-deploy.sh" "ubuntu@${PUBLIC_IP}:/tmp/remote-deploy.sh"
ssh "${SSH_OPTS[@]}" "ubuntu@${PUBLIC_IP}" \
  "sed -i 's/\r$//' /tmp/remote-deploy.sh && chmod +x /tmp/remote-deploy.sh && bash /tmp/remote-deploy.sh"

echo ""
echo "Dashboard: http://${PUBLIC_IP}:3000"
echo "Health:    http://${PUBLIC_IP}:3000/health"
