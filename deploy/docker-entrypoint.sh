#!/bin/sh
set -e

# Stale locks survive container rebuilds when .wwebjs_auth is volume-mounted.
pkill -9 chromium 2>/dev/null || true
pkill -9 chrome 2>/dev/null || true

# --- Persistent disk layout (Render) ---
# Render gives this service exactly one disk. It's mounted at /app/persist and
# must cover BOTH the WhatsApp session and data/ (SQLite conversation memory +
# local KB index) — otherwise everything under data/ lives on ephemeral
# container storage and is wiped on every redeploy/restart. Symlink both real
# paths into the persistent disk. No-op locally (docker-compose mounts
# .wwebjs_auth and data as separate volumes and never creates /app/persist).
PERSIST_DIR=/app/persist
if [ -d "$PERSIST_DIR" ]; then
  mkdir -p "$PERSIST_DIR/data"

  # One-time migration: the disk used to be mounted directly at /app/.wwebjs_auth,
  # so existing session files sit at the persist root, not under wwebjs_auth/.
  if [ ! -e "$PERSIST_DIR/wwebjs_auth" ]; then
    mkdir -p "$PERSIST_DIR/wwebjs_auth"
    find "$PERSIST_DIR" -mindepth 1 -maxdepth 1 \
      -not -name wwebjs_auth -not -name data \
      -exec mv {} "$PERSIST_DIR/wwebjs_auth/" \; 2>/dev/null || true
  fi

  if [ -d /app/.wwebjs_auth ] && [ ! -L /app/.wwebjs_auth ]; then
    rm -rf /app/.wwebjs_auth
  fi
  ln -sfn "$PERSIST_DIR/wwebjs_auth" /app/.wwebjs_auth

  if [ -d /app/data ] && [ ! -L /app/data ]; then
    rm -rf /app/data
  fi
  ln -sfn "$PERSIST_DIR/data" /app/data
fi

if [ -d /app/.wwebjs_auth ]; then
  find /app/.wwebjs_auth \( -name 'SingletonLock' -o -name 'SingletonSocket' -o -name 'SingletonCookie' -o -name 'lockfile' \) -delete 2>/dev/null || true
fi

exec npm start
