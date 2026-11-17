#!/usr/bin/env bash
# Démarrage du conteneur :
#   1. PostgreSQL + ParadeDB (base créée au premier lancement, dans /data/postgres) ;
#   2. migrations (idempotentes) ;
#   3. interface web, qui met aussi à jour l'index avec les vidéos de /data/corpus.
# Un arrêt du conteneur arrête proprement l'application puis la base.
set -euo pipefail

# Dossier de base d'une installation antérieure (/data/pgdata) : repris tel quel.
if [ ! -s "$PGDATA/PG_VERSION" ] && [ -s /data/pgdata/PG_VERSION ]; then
  export PGDATA=/data/pgdata
fi

mkdir -p "$CORPUS_DIR" "$PGDATA"
chown postgres:postgres /data "$CORPUS_DIR" 2>/dev/null || true

# Une base en mémoire vive (dossier hors d'un vrai disque) disparaîtrait au redémarrage de la machine.
fs_type="$(df --output=fstype "$PGDATA" 2>/dev/null | tail -n 1 | tr -d ' ')"
case "$fs_type" in
  rootfs|tmpfs|ramfs)
    if [ ! -s "$PGDATA/PG_VERSION" ] && [ "${RAGATOR_ALLOW_RAM_DATA:-}" != "1" ]; then
      echo "ragator : ERREUR — /data est en mémoire vive ($fs_type) : la base serait perdue au redémarrage. Monter /data sur un vrai disque." >&2
      exit 1
    fi
    echo "ragator : ATTENTION — la base est en mémoire vive ($fs_type) : elle sera perdue au redémarrage." >&2
    ;;
esac

# Accès réseau direct à la base : seulement avec RAGATOR_DB_PASSWORD (16 caractères au moins), par le
# rôle ragator_reseau (voir pg_hba.conf). Sans lui, la base n'écoute que dans le conteneur.
listen=127.0.0.1
if [ -n "${RAGATOR_DB_PASSWORD:-}" ]; then
  if [ "${#RAGATOR_DB_PASSWORD}" -ge 16 ]; then listen='*'; else echo "ragator : RAGATOR_DB_PASSWORD trop court, ignoré." >&2; fi
fi

docker-entrypoint.sh postgres -c listen_addresses="$listen" -c hba_file=/etc/ragator/pg_hba.conf \
  -c paradedb.planner_warnings=off &
pg_pid=$!
app_pid=''

stop() {
  [ -n "$app_pid" ] && kill -TERM "$app_pid" 2>/dev/null || true
  kill -INT "$pg_pid" 2>/dev/null || true
  wait "$pg_pid" 2>/dev/null || true
}
trap 'stop; exit 0' TERM INT

echo "ragator : démarrage de la base…"
until pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q; do
  kill -0 "$pg_pid" 2>/dev/null || { echo "ragator : la base n'a pas démarré" >&2; exit 1; }
  sleep 1
done

db_psql() { psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q "$@"; }
if [ "$listen" = '*' ]; then
  db_psql -v pw="$RAGATOR_DB_PASSWORD" -v owner="$POSTGRES_USER" <<'SQL'
SELECT 'CREATE ROLE ragator_reseau' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ragator_reseau') \gexec
ALTER ROLE ragator_reseau LOGIN PASSWORD :'pw';
GRANT :"owner" TO ragator_reseau;
ALTER ROLE ragator_reseau SET role = :'owner';
SQL
else
  db_psql <<'SQL'
SELECT 'ALTER ROLE ragator_reseau NOLOGIN' WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ragator_reseau') \gexec
SQL
fi

cd /app
gosu postgres node --import tsx src/cli/index.ts db:migrate >/dev/null
gosu postgres node --import tsx src/cli/index.ts web --mettre-a-jour &
app_pid=$!

# Le conteneur s'arrête si l'un des deux s'arrête.
set +e
wait -n "$pg_pid" "$app_pid"
status=$?
stop
exit "$status"
