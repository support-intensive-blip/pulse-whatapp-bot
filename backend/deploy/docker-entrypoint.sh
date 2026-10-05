#!/bin/sh
set -e

# --- Persistent disk layout (Render) ---
# Render gives this service exactly one disk, mounted at /app/persist. data/
# (SQLite conversation history + local KB index) must live on it, otherwise it
# sits on ephemeral container storage and is wiped on every redeploy/restart.
# No-op locally (docker-compose mounts data as a volume and never creates
# /app/persist). A leftover persist/wwebjs_auth folder from the WhatsApp Web
# era is no longer used and can be deleted.
PERSIST_DIR=/app/persist
if [ -d "$PERSIST_DIR" ]; then
  mkdir -p "$PERSIST_DIR/data"

  if [ -d /app/data ] && [ ! -L /app/data ]; then
    rm -rf /app/data
  fi
  ln -sfn "$PERSIST_DIR/data" /app/data
fi

exec npm start
