#!/bin/bash
set -euo pipefail
APP=/opt/whatsapp-ai-assistant

sudo cp /tmp/knowledgeBaseService.js "$APP/src/services/knowledgeBaseService.js"
sudo cp /tmp/contextService.js "$APP/src/services/contextService.js"
sudo cp /tmp/chatService.js "$APP/src/services/chatService.js"
sudo cp /tmp/conversationSlotsService.js "$APP/src/services/conversationSlotsService.js"

if ! grep -q '^CONTEXT_MEMORY_TTL_MINUTES=' "$APP/.env"; then
  echo 'CONTEXT_MEMORY_TTL_MINUTES=15' | sudo tee -a "$APP/.env" >/dev/null
fi

cd "$APP"
C=$(sudo docker-compose ps -q whatsapp-bot)
echo "CONTAINER=$C"

# Discover app workdir inside container
WORKDIR=$(sudo docker exec "$C" pwd)
echo "WORKDIR=$WORKDIR"

for f in knowledgeBaseService.js contextService.js chatService.js conversationSlotsService.js; do
  sudo docker cp "$APP/src/services/$f" "${C}:${WORKDIR}/src/services/$f"
done

sudo docker-compose restart whatsapp-bot
sleep 35

curl -sf http://127.0.0.1:3000/health
echo
grep CONTEXT_MEMORY "$APP/.env" || true

C=$(sudo docker-compose ps -q whatsapp-bot)
sudo docker exec "$C" grep -n "CONTEXT_MEMORY_TTL\|Hello mam\|isCasualOnly" "${WORKDIR}/src/services/knowledgeBaseService.js" "${WORKDIR}/src/services/contextService.js" | head -30
echo DEPLOY_OK
