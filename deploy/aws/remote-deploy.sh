#!/bin/bash
# Docker + compose on Ubuntu EC2 (SQLite only — no GCP/BigQuery)
set -e
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y docker.io docker-compose ffmpeg curl

sudo systemctl enable docker
sudo systemctl start docker

sudo mkdir -p /opt/whatsapp-ai-assistant
sudo mkdir -p /opt/whatsapp-ai-assistant/data /opt/whatsapp-ai-assistant/logs /opt/whatsapp-ai-assistant/uploads /opt/whatsapp-ai-assistant/knowledge-base

sudo tar -xzf /tmp/whatsapp-bot-deploy.tar.gz -C /opt/whatsapp-ai-assistant

cd /opt/whatsapp-ai-assistant

if [ ! -f .env ]; then
  cp .env.example .env
fi

# SQLite-only deployment (disable BigQuery / GCP)
if grep -q '^BQ_ENABLED=' .env 2>/dev/null; then
  sed -i 's|^BQ_ENABLED=.*|BQ_ENABLED=false|' .env
else
  echo 'BQ_ENABLED=false' >> .env
fi
if grep -q '^LOCAL_MESSAGE_STORE=' .env 2>/dev/null; then
  sed -i 's|^LOCAL_MESSAGE_STORE=.*|LOCAL_MESSAGE_STORE=true|' .env
else
  echo 'LOCAL_MESSAGE_STORE=true' >> .env
fi
sed -i '/^GOOGLE_APPLICATION_CREDENTIALS=/d' .env 2>/dev/null || true
sed -i '/^GCP_PROJECT_ID=/d' .env 2>/dev/null || true
sed -i '/^BQ_DATASET=/d' .env 2>/dev/null || true
sed -i '/^BQ_TABLE=/d' .env 2>/dev/null || true
sed -i '/^BQ_LOCATION=/d' .env 2>/dev/null || true

if ! grep -q '^WHATSAPP_TAKEOVER_ON_CONFLICT=true' .env 2>/dev/null; then
  if grep -q '^WHATSAPP_TAKEOVER_ON_CONFLICT=' .env 2>/dev/null; then
    sed -i 's|^WHATSAPP_TAKEOVER_ON_CONFLICT=.*|WHATSAPP_TAKEOVER_ON_CONFLICT=true|' .env
  else
    echo 'WHATSAPP_TAKEOVER_ON_CONFLICT=true' >> .env
  fi
fi

if grep -q '^CHAT_SYNC_ON_READY=' .env 2>/dev/null; then
  sed -i 's|^CHAT_SYNC_ON_READY=.*|CHAT_SYNC_ON_READY=true|' .env
else
  echo 'CHAT_SYNC_ON_READY=true' >> .env
fi

if ! grep -q "^JWT_SECRET=" .env 2>/dev/null; then
  echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
fi

if [ -d .wwebjs_auth ] && [ "$(sudo docker volume ls -q -f name=wwebjs_auth | wc -l)" -eq 0 ]; then
  sudo docker volume create wwebjs_auth >/dev/null 2>&1 || true
fi
if [ -d .wwebjs_auth ] && [ -n "$(ls -A .wwebjs_auth 2>/dev/null)" ]; then
  sudo docker run --rm \
    -v "$(pwd)/.wwebjs_auth:/from:ro" \
    -v wwebjs_auth:/to \
    alpine sh -c "cp -a /from/. /to/" 2>/dev/null || true
  sudo rm -rf .wwebjs_auth
fi
if [ -d .wwebjs_cache ]; then
  sudo rm -rf .wwebjs_cache
fi

sudo docker-compose down --remove-orphans 2>/dev/null || true
sudo docker rm -f whatsapp-ai-assistant 2>/dev/null || true
sudo docker ps -aq --filter name=whatsapp-ai-assistant | xargs -r sudo docker rm -f

sudo docker image prune -af 2>/dev/null || true

if sudo docker compose version >/dev/null 2>&1; then
  COMPOSE="sudo docker compose"
else
  COMPOSE="sudo docker-compose"
fi

$COMPOSE up -d --build

sleep 20
$COMPOSE ps
$COMPOSE logs --tail=80
