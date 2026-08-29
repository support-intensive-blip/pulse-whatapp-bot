#!/bin/sh
set -e

# Stale locks survive container rebuilds when .wwebjs_auth is volume-mounted.
pkill -9 chromium 2>/dev/null || true
pkill -9 chrome 2>/dev/null || true

if [ -d /app/.wwebjs_auth ]; then
  find /app/.wwebjs_auth \( -name 'SingletonLock' -o -name 'SingletonSocket' -o -name 'SingletonCookie' -o -name 'lockfile' \) -delete 2>/dev/null || true
fi

exec npm start
