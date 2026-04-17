#!/bin/sh
set -e

# No PUID/PGID? Run as current user (backwards compatible)
if [ -z "$PUID" ] && [ -z "$PGID" ]; then
  exec /sbin/tini -- "$@"
fi

PUID=${PUID:-99}
PGID=${PGID:-100}
UMASK=${UMASK:-022}

# Create group/user if they don't already exist
getent group "$PGID" >/dev/null 2>&1 || addgroup -g "$PGID" agregarr
if ! getent passwd "$PUID" >/dev/null 2>&1; then
  adduser -D -H -h /home/agregarr -u "$PUID" -G "$(getent group "$PGID" | cut -d: -f1)" agregarr
fi

# Ensure a writable home directory (yarn cache/global folders live here)
USER_HOME=$(getent passwd "$PUID" | cut -d: -f6)
if [ -n "$USER_HOME" ] && [ "$USER_HOME" != "/" ]; then
  mkdir -p "$USER_HOME"
  chown "$PUID:$PGID" "$USER_HOME"
fi

# Fix ownership on directories the app needs to write to
chown -R "$PUID:$PGID" /app/config
chown -R "$PUID:$PGID" /app/.next 2>/dev/null || true

umask "$UMASK"
exec /sbin/tini -- su-exec "$PUID:$PGID" "$@"
