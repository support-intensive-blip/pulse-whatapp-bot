#!/bin/bash
# Run Pinecone index setup + per-team KB ingest on the EC2 server (no full redeploy).
# Usage on server:
#   PINECONE_API_KEY=pcsk_... sudo -E bash /opt/whatsapp-ai-assistant/deploy/aws/setup-pinecone-remote.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/whatsapp-ai-assistant}"
ENV_FILE="$APP_DIR/.env"

if [ -z "${PINECONE_API_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ -z "${PINECONE_API_KEY:-}" ]; then
  echo "PINECONE_API_KEY is required (set in .env or environment)"
  exit 1
fi

cd "$APP_DIR"

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

upsert_env PINECONE_API_KEY "$PINECONE_API_KEY"
upsert_env PINECONE_INDEX "${PINECONE_INDEX:-pulse-kb}"
upsert_env PINECONE_INTEGRATED "${PINECONE_INTEGRATED:-true}"
upsert_env PINECONE_EMBED_MODEL "${PINECONE_EMBED_MODEL:-multilingual-e5-large}"
upsert_env PINECONE_EMBED_FIELD "${PINECONE_EMBED_FIELD:-chunk_text}"
upsert_env PINECONE_CLOUD "${PINECONE_CLOUD:-aws}"
upsert_env PINECONE_REGION "${PINECONE_REGION:-us-east-1}"

if sudo docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
else
  COMPOSE="docker-compose"
fi

COMPOSE_FILE="$APP_DIR/docker-compose.yml"
run_in_container() {
  sudo $COMPOSE -f "$COMPOSE_FILE" exec -T whatsapp-bot "$@"
}

echo "=== Pinecone index setup ==="
run_in_container npm run pinecone:setup

# Capture PINECONE_HOST from setup output if printed
HOST_LINE=$(run_in_container node -e "
require('dotenv').config();
const { Pinecone } = require('@pinecone-database/pinecone');
(async () => {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const desc = await pc.describeIndex(process.env.PINECONE_INDEX || 'pulse-kb');
  if (desc.host) console.log(desc.host);
})().catch(() => process.exit(0));
" 2>/dev/null || true)

if [ -n "$HOST_LINE" ]; then
  upsert_env PINECONE_HOST "$HOST_LINE"
  echo "PINECONE_HOST set"
fi

echo "=== Restart container to load Pinecone env ==="
sudo $COMPOSE -f "$COMPOSE_FILE" up -d whatsapp-bot
sleep 8

echo "=== Ingest team knowledge bases ==="
TEAM_IDS=$(run_in_container node -e "
const db = require('better-sqlite3')('/app/data/assistant.db');
const rows = db.prepare('SELECT team_id FROM team_settings ORDER BY team_id').all();
console.log(rows.map((r) => r.team_id).join(' '));
")

for TEAM_ID in $TEAM_IDS; do
  echo "--- team $TEAM_ID ---"
  run_in_container npm run ingest-kb -- --team="$TEAM_ID" || echo "team $TEAM_ID ingest skipped/failed"
done

echo "=== Global KB ingest (if PDF exists) ==="
run_in_container npm run ingest-kb || echo "global ingest skipped"

echo "=== Done ==="
run_in_container node -e "
require('dotenv').config();
console.log('Pinecone enabled:', Boolean(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX));
"
