#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  if ! command -v gosu >/dev/null 2>&1; then
    echo "[mmh] gosu is missing; refusing to run the app process as root."
    exit 78
  fi
  mkdir -p /app/data
  if ! chown -R node:node /app/data; then
    echo "[mmh] failed to make /app/data writable by the node user."
    exit 78
  fi
  exec gosu node "$0" "$@"
fi

PGHOST="${PGHOST:-postgres}"
PGUSER="${POSTGRES_USER:-mmh-fs}"
PGDATABASE="${POSTGRES_DB:-mmh}"
PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
export PGPASSWORD

psql_mmh() {
  psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" "$@"
}

mmh_log() {
  echo "[mmh] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

generate_secret() {
  if command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
    return 0
  fi
  return 1
}

ensure_session_secret() {
  if [ -n "${MMH_SESSION_SECRET:-}" ]; then
    case "$MMH_SESSION_SECRET" in
      CHANGE_ME*)
        echo "[mmh] MMH_SESSION_SECRET is a placeholder; set a strong random value or leave it empty for automatic generation." >&2
        exit 78
        ;;
    esac
    if [ "${#MMH_SESSION_SECRET}" -lt 32 ]; then
      echo "[mmh] MMH_SESSION_SECRET must contain at least 32 characters." >&2
      exit 78
    fi
    return 0
  fi
  secret_file="/app/data/mmh-session-secret.txt"
  if [ -f "$secret_file" ]; then
    MMH_SESSION_SECRET="$(tr -d '[:space:]' < "$secret_file")"
  fi
  case "${MMH_SESSION_SECRET:-}" in
    CHANGE_ME*)
      MMH_SESSION_SECRET=""
      ;;
  esac
  if [ -n "${MMH_SESSION_SECRET:-}" ] && [ "${#MMH_SESSION_SECRET}" -lt 32 ]; then
    MMH_SESSION_SECRET=""
  fi
  if [ -z "${MMH_SESSION_SECRET:-}" ]; then
    umask 077
    MMH_SESSION_SECRET="$(generate_secret)"
    printf '%s\n' "$MMH_SESSION_SECRET" > "$secret_file"
  fi
  chmod 600 "$secret_file" 2>/dev/null || true
  export MMH_SESSION_SECRET
}

run_sql_file() {
  file="$1"
  if [ ! -f "$file" ]; then
    mmh_log "missing compatibility migration: $file"
    exit 78
  fi
  mmh_log "applying $file"
  psql_mmh -v ON_ERROR_STOP=1 -f "$file"
}

run_compat_migrations() {
  legacy_statement_category_rules="$(
    psql_mmh -tAc "SELECT CASE WHEN to_regclass('public.statement_category_rules') IS NULL THEN '0' ELSE '1' END" | tr -d '[:space:]'
  )"

  if [ "$legacy_statement_category_rules" = "1" ]; then
    mmh_log "migrating legacy statement category rules..."
    run_sql_file "prisma/migrations/20260813_add_statement_recognition_rules/migration.sql"
    run_sql_file "prisma/migrations/20260813_z_cleanup_statement_category_rule_institutions/migration.sql"
    run_sql_file "prisma/migrations/20260813_zz_unify_statement_learning_rules/migration.sql"
    mmh_log "legacy statement category rules migrated."
  fi
}

until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"; do
  mmh_log "waiting for postgres..."
  sleep 1
done

mmh_log "postgres ready, checking database schema..."

ensure_session_secret
run_compat_migrations

PUSH_OUTPUT="$(mktemp)"
if ./node_modules/.bin/prisma db push >"$PUSH_OUTPUT" 2>&1; then
  cat "$PUSH_OUTPUT"
  rm -f "$PUSH_OUTPUT"
  psql_mmh -v ON_ERROR_STOP=1 -c "UPDATE \"Account\" SET \"loanType\" = CASE WHEN \"isConsumerLoan\" = TRUE THEN 'consumer' ELSE 'home' END WHERE \"kind\" = 'loan' AND \"loanType\" IS NULL;"
  psql_mmh -v ON_ERROR_STOP=1 -c "UPDATE \"Account\" SET \"kind\" = 'settlement', \"loanType\" = NULL, \"isConsumerLoan\" = FALSE WHERE \"kind\" = 'loan' AND \"counterpartyId\" IS NOT NULL AND COALESCE(\"isPlaceholder\", FALSE) = FALSE; UPDATE \"Account\" SET \"loanType\" = NULL, \"isConsumerLoan\" = FALSE WHERE \"kind\" = 'settlement';"
  mmh_log "account-kind compatibility backfill complete."
  mmh_log "prisma setup complete, starting app..."
  exec node server.js
fi

cat "$PUSH_OUTPUT"

if grep -Eq "accept-data-loss|data loss|dropped_variants|will be dropped|invalid input value for enum" "$PUSH_OUTPUT"; then
  mmh_log "database schema sync refused because it may delete or rewrite existing data."
  mmh_log "This usually means the app image is older than the database. Pull the newest image from GHCR or switch away from a stale mirror."
  rm -f "$PUSH_OUTPUT"
  exit 78
fi

rm -f "$PUSH_OUTPUT"
mmh_log "prisma db push failed."
exit 1
