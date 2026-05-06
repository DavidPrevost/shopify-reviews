#!/bin/sh
# Nightly SQLite backup → Pebbles via rsync over Tailscale.
# Runs inside the alpine `backup` sidecar container; the reviews-app data
# directory is mounted read-only at /data.

set -eu

SNAPSHOT_DIR=/data/snapshots
TARGET_HOST=${BACKUP_TARGET_HOST:-100.86.45.31}     # Pebbles Tailscale IP
TARGET_USER=${BACKUP_TARGET_USER:-root}
TARGET_PATH=${BACKUP_TARGET_PATH:-/opt/backups/shopify-reviews/}

mkdir -p "$SNAPSHOT_DIR"

ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
snapshot="$SNAPSHOT_DIR/reviews-$ts.db"

# SQLite-aware online backup — works correctly even while the writer is open.
sqlite3 /data/reviews.db ".backup '$snapshot'"
echo "snapshot: $snapshot"

# Local rotation: keep 7 daily, then weekly thinning is left to the receiver.
ls -1t "$SNAPSHOT_DIR"/reviews-*.db 2>/dev/null | tail -n +8 | xargs -r rm --

# Push to Pebbles. SSH key + known_hosts come from the bind-mounted /root/.ssh.
rsync -az --delete \
  -e "ssh -o StrictHostKeyChecking=accept-new" \
  "$SNAPSHOT_DIR/" \
  "${TARGET_USER}@${TARGET_HOST}:${TARGET_PATH}"

echo "rsync to ${TARGET_HOST}:${TARGET_PATH} complete"
