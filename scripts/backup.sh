#!/usr/bin/env bash
# Logical database backup (docs/BACKUP_RESTORE.md): a pg_dump in custom format, optionally encrypted with a passphrase.
#
#   DATABASE_URL_UNPOOLED=postgres://... BACKUP_PASSPHRASE=... scripts/backup.sh [output-dir]
#
# Uses the DIRECT (non-pooled) connection: pg_dump needs session features a transaction pooler does not provide.
# Without BACKUP_PASSPHRASE the dump is written in clear text; keep it on encrypted storage in that case.
set -euo pipefail

url="${DATABASE_URL_UNPOOLED:-}"
if [[ -z "$url" ]]; then echo "DATABASE_URL_UNPOOLED is required" >&2; exit 2; fi
out="${1:-backups}"
mkdir -p "$out"
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$out/taskdb-$stamp.dump"

# Every tenant table has FORCED row-level security, which also binds a table's owner. pg_dump therefore fails
# ("query would be affected by row-level security policy") unless the role is a superuser or has BYPASSRLS.
# Check first so the failure is explained instead of cryptic.
can_dump="$(psql -X -At "$url" -c "select (rolsuper or rolbypassrls) from pg_roles where rolname = current_user" 2>/dev/null || true)"
if [[ "$can_dump" != "t" ]]; then
  echo "The backup role must be a superuser or have BYPASSRLS (row-level security would otherwise hide or block the data)." >&2
  echo "Use a dedicated backup role with BYPASSRLS, used ONLY for backups. See docs/BACKUP_RESTORE.md." >&2
  exit 3
fi

pg_dump --format=custom --no-owner --no-privileges --file="$file" "$url"

if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  # AES-256-CBC with PBKDF2; the passphrase is read from the environment, never from the command line.
  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_PASSPHRASE -in "$file" -out "$file.enc"
  shred -u "$file" 2>/dev/null || rm -f "$file"
  file="$file.enc"
fi

sha256sum "$file" > "$file.sha256"
echo "backup written: $file ($(du -h "$file" | cut -f1))"
