#!/bin/bash
set -euo pipefail
APP=/opt/whatsapp-ai-assistant

sudo cp /tmp/kbSemanticChunker.js "$APP/src/services/kbSemanticChunker.js"
sudo cp /tmp/knowledgeBaseService.js "$APP/src/services/knowledgeBaseService.js"
sudo cp /tmp/dashboardRoutes.js "$APP/src/api/dashboardRoutes.js"

cd "$APP"
C=$(sudo docker-compose ps -q whatsapp-bot)
echo "CONTAINER=$C"

WORKDIR=$(sudo docker exec "$C" pwd)
echo "WORKDIR=$WORKDIR"

sudo docker cp "$APP/src/services/kbSemanticChunker.js" "${C}:${WORKDIR}/src/services/kbSemanticChunker.js"
sudo docker cp "$APP/src/services/knowledgeBaseService.js" "${C}:${WORKDIR}/src/services/knowledgeBaseService.js"
sudo docker cp "$APP/src/api/dashboardRoutes.js" "${C}:${WORKDIR}/src/api/dashboardRoutes.js"

sudo docker-compose restart whatsapp-bot
sleep 35

curl -sf http://127.0.0.1:3000/health
echo

C=$(sudo docker-compose ps -q whatsapp-bot)
sudo docker exec "$C" grep -n "chunkDocumentFromJson\|isJsonKbArray" "${WORKDIR}/src/services/kbSemanticChunker.js" | head -5
sudo docker exec "$C" grep -n "isJson" "${WORKDIR}/src/api/dashboardRoutes.js" | head -5
echo DEPLOY_OK
