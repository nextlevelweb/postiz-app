#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY. Never use this script on a server.
#
# Runs a command against one of the two local Content Studio development
# databases, chosen by an explicit profile:
#
#   scripts/content-studio-dev-db.sh scratch pnpm run dev:backend
#   scripts/content-studio-dev-db.sh existing-data pnpm run dev:backend
#   scripts/content-studio-dev-db.sh existing-data pnpm run prisma-db-push
#
#   scratch        postiz-dev-content-studio, an empty database for tests
#   existing-data  postiz-dev-content-studio-from-existing, a clone of
#                  postiz-prod-migration-test (real accounts, posts and social
#                  integration tokens), for reviewing Content Studio locally
#
# DATABASE_URL is built for the command's process only, from the credentials
# of the postiz-postgres container of docker-compose.dev.yaml. It is never
# printed or written to disk, and .env is neither read nor changed: a
# DATABASE_URL already in the environment wins over .env, for dotenv and for
# Prisma alike. Any target other than the profile's database on
# 127.0.0.1:5432 is refused, and so is anything that resets the database.
# postiz-prod-migration-test is the source of the clone and is never a target.
#
# The command also gets a local Secret Box keyring (SECRET_BOX_KEYS and
# SECRET_BOX_ACTIVE_KEY), so Content Studio can store AI connection keys
# encrypted. The keyring is a development key made for this checkout on first
# use, in .local/content-studio/secret-box.env (gitignored, mode 600). It is
# never printed, never a production key and never read from .env; a file
# that is not exactly that keyring, or is readable by others, is refused.
# Deleting the file makes stored AI keys unreadable: replace them in Brand &
# AI afterwards.
set -euo pipefail

CONTAINER=postiz-postgres
DB_HOST=127.0.0.1
DB_PORT=5432
SOURCE_DB=postiz-prod-migration-test
SECRET_BOX_DIR=.local/content-studio
SECRET_BOX_FILE=$SECRET_BOX_DIR/secret-box.env

fail() {
  echo "content-studio-dev-db: $*" >&2
  exit 3
}

usage="usage: scripts/content-studio-dev-db.sh scratch|existing-data <command> [args...]"
[ "$#" -gt 1 ] || fail "$usage"
profile=$1
shift
case "$profile" in
  scratch) DB_NAME=postiz-dev-content-studio ;;
  existing-data) DB_NAME=postiz-dev-content-studio-from-existing ;;
  "$SOURCE_DB") fail "refusing $SOURCE_DB: it is the source of the clone, never a target" ;;
  *) fail "unknown profile '$profile'; $usage" ;;
esac
[ "$DB_NAME" != "$SOURCE_DB" ] || fail "refusing $SOURCE_DB"

for arg in "$@"; do
  case "$arg" in
    *"$SOURCE_DB"*)
      fail "refusing a command that names $SOURCE_DB"
      ;;
    *--force-reset* | *--accept-data-loss* | *prisma-reset* | *migrate\ reset* | *db\ reset*)
      fail "refusing a command that can reset or drop data: $arg"
      ;;
  esac
done
case " $* " in
  *" migrate reset "* | *" db reset "*)
    fail "refusing a command that can reset or drop data"
    ;;
esac
# existing-data holds real social integration tokens: nothing that starts the
# orchestrator (it publishes and refreshes tokens) runs against it
if [ "$profile" = existing-data ]; then
  for arg in "$@"; do
    case "$arg" in
      *orchestrator* | dev | dev:stripe | pm2 | pm2-run)
        fail "refusing to start the orchestrator against $DB_NAME: $arg"
        ;;
    esac
  done
fi

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

# the local Secret Box keyring: made once, then only read
if [ ! -e "$SECRET_BOX_FILE" ]; then
  (
    umask 077
    mkdir -p "$SECRET_BOX_DIR"
    key=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')
    printf 'SECRET_BOX_KEYS=local1:%s\nSECRET_BOX_ACTIVE_KEY=local1\n' "$key" >"$SECRET_BOX_FILE"
  )
  echo "content-studio-dev-db: created a local Secret Box key in $SECRET_BOX_FILE" >&2
fi
[ -f "$SECRET_BOX_FILE" ] && [ ! -L "$SECRET_BOX_FILE" ] ||
  fail "$SECRET_BOX_FILE is not a regular file"
[ -O "$SECRET_BOX_FILE" ] || fail "$SECRET_BOX_FILE is not owned by you"
mode=$(stat -f '%Lp' "$SECRET_BOX_FILE" 2>/dev/null || stat -c '%a' "$SECRET_BOX_FILE")
[ "$mode" = 600 ] || fail "$SECRET_BOX_FILE must have mode 600 (chmod 600 $SECRET_BOX_FILE)"
keys=
active=
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    SECRET_BOX_KEYS=*) keys=${line#SECRET_BOX_KEYS=} ;;
    SECRET_BOX_ACTIVE_KEY=*) active=${line#SECRET_BOX_ACTIVE_KEY=} ;;
    *) fail "$SECRET_BOX_FILE holds something other than the Secret Box keyring" ;;
  esac
done <"$SECRET_BOX_FILE"
printf '%s' "$keys" | grep -qE '^[a-z0-9_-]{1,32}:[A-Za-z0-9+/]{43}=(,[a-z0-9_-]{1,32}:[A-Za-z0-9+/]{43}=)*$' ||
  fail "$SECRET_BOX_FILE has an invalid SECRET_BOX_KEYS"
printf '%s' "$active" | grep -qE '^[a-z0-9_-]{1,32}$' ||
  fail "$SECRET_BOX_FILE has an invalid SECRET_BOX_ACTIVE_KEY"
case ",$keys" in
  *",$active:"*) ;;
  *) fail "$SECRET_BOX_FILE: the active key is not in the keyring" ;;
esac
export SECRET_BOX_KEYS="$keys" SECRET_BOX_ACTIVE_KEY="$active"
unset keys active line mode

echo "content-studio-dev-db: profile $profile, database $DB_NAME on $DB_HOST:$DB_PORT, Secret Box configured (local key)" >&2
exec "$@"
