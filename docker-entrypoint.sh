#!/bin/sh
# Apply pending Prisma migrations on container start, then exec the CMD.
# Idempotent — safe on every restart.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] DATABASE_URL is not set" >&2
  exit 1
fi

# Ensure /data exists + is writable when SQLite is used.
case "$DATABASE_URL" in
  file:*)
    DBPATH=$(echo "$DATABASE_URL" | sed 's|^file:||')
    DIR=$(dirname "$DBPATH")
    mkdir -p "$DIR" 2>/dev/null || true
    ;;
esac

# --- Pre-migration snapshot (SQLite only) -----------------------------------
# `migrate deploy` runs on every boot against the single SQLite file. A failed
# table-rebuild migration can leave that file half-migrated / corrupt, and with
# `set -e` the container then exits into a restart loop over the damaged DB. So
# snapshot it FIRST, to a timestamped file on the /data volume, using a
# consistent copy (sqlite3 `.backup`, else `VACUUM INTO` via node:sqlite) — NOT
# a raw `cp`, which can miss uncheckpointed WAL frames. Keep the last 5.
#
# Guards:
#   - only for file: (SQLite) URLs and only when the DB already exists non-empty
#     (`[ -s ]`) — a fresh/empty DB has nothing to protect, so skip + continue
#     and never fail the boot there;
#   - if a snapshot WAS expected (existing non-empty DB) but failed, ABORT before
#     migrate rather than risk corrupting an unrecoverable DB.
if [ -n "$DBPATH" ] && [ -s "$DBPATH" ]; then
  BACKUP="${DIR}/pre-migrate-$(date +%Y%m%d-%H%M%S).db"
  rm -f "$BACKUP" 2>/dev/null || true
  echo "[entrypoint] snapshotting DB before migrate -> $BACKUP"
  snap_ok=0
  if command -v sqlite3 >/dev/null 2>&1; then
    if sqlite3 "$DBPATH" ".backup '$BACKUP'"; then snap_ok=1; fi
  else
    if NODE_NO_WARNINGS=1 node ./scripts/pre-migrate-backup.mjs "$DBPATH" "$BACKUP"; then snap_ok=1; fi
  fi
  if [ "$snap_ok" -ne 1 ] || [ ! -s "$BACKUP" ]; then
    echo "[entrypoint] ERROR: pre-migrate snapshot failed on an existing non-empty DB; aborting before migrate" >&2
    rm -f "$BACKUP" 2>/dev/null || true
    exit 1
  fi
  # Rotate: keep only the 5 most recent snapshots. The timestamped names sort
  # chronologically, so a lexical reverse sort puts the newest first; drop the
  # 6th onward. (Names are self-generated, no spaces — safe to word-split.)
  for old in $(ls -1 "$DIR"/pre-migrate-*.db 2>/dev/null | sort -r | tail -n +6); do
    rm -f "$old" 2>/dev/null || true
  done
else
  echo "[entrypoint] no existing non-empty SQLite DB — skipping pre-migrate snapshot"
fi

echo "[entrypoint] applying migrations"
HOME=/tmp node ./node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma

exec "$@"
