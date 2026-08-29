#!/bin/bash
# Reverse proxy + automatic HTTPS (Caddy + Let's Encrypt)
# Usage: sudo bash setup-https.sh [domain]
# If domain is omitted, uses pulse.nxtwave.<ip-with-dashes>.sslip.io
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/whatsapp-ai-assistant}"
EMAIL="${HTTPS_ADMIN_EMAIL:-}"
HOST_PREFIX="${HTTPS_HOST_PREFIX:-pulse.nxtwave}"

if [ -z "${1:-}" ]; then
  IP=$(curl -sf -H "Metadata-Flavor: Google" \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/natIP \
    || true)
  if [ -z "$IP" ]; then
    IP=$(curl -sf ifconfig.me || true)
  fi
  if [ -z "$IP" ]; then
    echo "Could not detect public IP. Pass domain: bash setup-https.sh your.domain.com"
    exit 1
  fi
  DOMAIN="${HOST_PREFIX}.$(echo "$IP" | tr '.' '-').sslip.io"
else
  DOMAIN="$1"
fi

echo "HTTPS domain: $DOMAIN"

if ! command -v caddy >/dev/null 2>&1; then
  echo "Installing Caddy..."
  sudo apt-get update -qq
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y caddy
fi

GLOBAL_BLOCK="# Pulse WhatsApp dashboard"
if [ -n "$EMAIL" ]; then
  GLOBAL_BLOCK="${GLOBAL_BLOCK}
{
  email ${EMAIL}
}"
fi

sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${GLOBAL_BLOCK}

${DOMAIN} {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR"
  if [ -f docker-compose.yml ] && grep -qE '"3000:3000"|0\.0\.0\.0:3000:3000' docker-compose.yml; then
    echo "Binding app to localhost:3000 (public access via HTTPS only)..."
    sudo sed -i 's|"3000:3000"|"127.0.0.1:3000:3000"|g' docker-compose.yml
    if sudo docker compose version >/dev/null 2>&1; then
      COMPOSE="sudo docker compose"
    else
      COMPOSE="sudo docker-compose"
    fi
    $COMPOSE down 2>/dev/null || true
    $COMPOSE up -d
  fi

  ENV_FILE="$APP_DIR/.env"
  PUBLIC_URL="https://${DOMAIN}"
  for KEY in PUBLIC_DASHBOARD_URL DASHBOARD_CORS_ORIGIN; do
    if grep -q "^${KEY}=" "$ENV_FILE" 2>/dev/null; then
      sudo sed -i "s|^${KEY}=.*|${KEY}=${PUBLIC_URL}|" "$ENV_FILE"
    else
      echo "${KEY}=${PUBLIC_URL}" | sudo tee -a "$ENV_FILE" >/dev/null
    fi
  done

  if sudo docker compose version >/dev/null 2>&1; then
    sudo docker compose restart
  else
    sudo docker-compose restart
  fi
fi

sudo systemctl enable caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

echo ""
echo "HTTPS ready: https://${DOMAIN}"
echo "Health:      https://${DOMAIN}/health"
caddy validate --config /etc/caddy/Caddyfile
