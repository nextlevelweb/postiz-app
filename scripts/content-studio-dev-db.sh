#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY. Never use this script on a server.
#
# Runs a command against the local Content Studio development database:
#
#   scripts/content-studio-dev-db.sh pnpm run dev:backend
#   scripts/content-studio-dev-db.sh pnpm run prisma-db-push
#
# DATABASE_URL is built for the command's process only, from the credentials
# of the postiz-postgres container of docker-compose.dev.yaml. It is never
# printed or written to disk, and .env is neither read nor changed: a
# DATABASE_URL already in the environment wins over .env, for dotenv and for
# Prisma alike. Any target other than postiz-dev-content-studio on
# 127.0.0.1:5432 is refused, and so is anything that resets the database.
set -euo pipefail

CONTAINER=postiz-postgres
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=postiz-dev-content-studio

fail() {
  echo "content-studio-dev-db: $*" >&2
  exit 3
}

[ "$#" -gt 0 ] || fail "usage: scripts/content-studio-dev-db.sh <command> [args...]"
for arg in "$@"; do
  case "$arg" in
    *--force-reset* | *--accept-data-loss* | *prisma-reset* | *migrate\ reset*)
      fail "refusing a command that can reset or drop data: $arg"
      ;;
  esac
done
command -v docker >/dev/null || fail "docker is not installed"
command -v node >/dev/null || fail "node is not installed"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] ||
  fail "container $CONTAINER is not running (pnpm run dev:docker)"
docker port "$CONTAINER" 5432/tcp | grep -qE ":${DB_PORT}\$" ||
  fail "container $CONTAINER does not publish port $DB_PORT"

# the database exists and answers as itself (read only, over the socket)
current=$(docker exec -e DB_NAME="$DB_NAME" "$CONTAINER" sh -c \
  'psql -U "$POSTGRES_USER" -d "$DB_NAME" -XAtq -c "SELECT current_database()"' 2>/dev/null) ||
  fail "database $DB_NAME cannot be read in $CONTAINER"
[ "$current" = "$DB_NAME" ] || fail "unexpected current_database()"

user=$(docker exec "$CONTAINER" printenv POSTGRES_USER)
password=$(docker exec "$CONTAINER" printenv POSTGRES_PASSWORD)
DATABASE_URL=$(PGU="$user" PGP="$password" node -e '
  const e = encodeURIComponent;
  const { PGU, PGP } = process.env;
  const [host, port, db] = process.argv.slice(1);
  process.stdout.write(`postgresql://${e(PGU)}:${e(PGP)}@${host}:${port}/${e(db)}`);
' "$DB_HOST" "$DB_PORT" "$DB_NAME")
unset user password
export DATABASE_URL

# the URL the command gets, parsed back: host, port and database exactly
node -e '
  const u = new URL(process.env.DATABASE_URL);
  const [host, port, db] = process.argv.slice(1);
  if (
    u.hostname !== host ||
    u.port !== port ||
    decodeURIComponent(u.pathname.slice(1)) !== db ||
    u.search !== ""
  ) {
    console.error("content-studio-dev-db: unexpected DATABASE_URL target");
    process.exit(3);
  }
' "$DB_HOST" "$DB_PORT" "$DB_NAME"

echo "content-studio-dev-db: database $DB_NAME on $DB_HOST:$DB_PORT" >&2
exec "$@"
