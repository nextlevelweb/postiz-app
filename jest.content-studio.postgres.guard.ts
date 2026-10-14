import { PrismaClient } from '@prisma/client';

// Test infrastructure only. The Content Studio PostgreSQL integration suite
// may only ever reach the disposable local database made for it (since P2-11;
// the P1-11 database on port 55432 is no longer accepted). No volume: the
// data is gone with the container:
//
//   docker run --name postiz-content-studio-p211-postgres --rm \
//     -e POSTGRES_USER=p211 -e POSTGRES_PASSWORD=p211_local_only \
//     -e POSTGRES_DB=postiz_content_studio_p211 \
//     -p 127.0.0.1:55433:5432 -d postgres:16-alpine
//
// The URL comes from CONTENT_STUDIO_POSTGRES_INTEGRATION_URL only, never from
// DATABASE_URL or the schema, and is checked before any client exists.
// Errors never repeat the URL that was given
export const CONTENT_STUDIO_POSTGRES_URL_ENV =
  'CONTENT_STUDIO_POSTGRES_INTEGRATION_URL';

export const CONTENT_STUDIO_POSTGRES_URL =
  'postgresql://p211:p211_local_only@127.0.0.1:55433/postiz_content_studio_p211';

const PROTOCOLS = ['postgresql:', 'postgres:'];
// exactly the address the container is published on: no name to resolve
const HOST = '127.0.0.1';
const PORT = '55433';
const DATABASE = '/postiz_content_studio_p211';
const USER = 'p211';

export class ContentStudioPostgresSafetyError extends Error {
  constructor(reason: string) {
    super(`Refusing the Content Studio integration database: ${reason}`);
    this.name = 'ContentStudioPostgresSafetyError';
  }
}

export function assertContentStudioPostgresUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    throw new ContentStudioPostgresSafetyError('no URL');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ContentStudioPostgresSafetyError('malformed URL');
  }
  if (!PROTOCOLS.includes(url.protocol)) {
    throw new ContentStudioPostgresSafetyError('not a PostgreSQL URL');
  }
  if (url.hostname !== HOST) {
    throw new ContentStudioPostgresSafetyError('host is not 127.0.0.1');
  }
  if (url.port !== PORT) {
    throw new ContentStudioPostgresSafetyError('port is not 55433');
  }
  if (url.pathname !== DATABASE) {
    throw new ContentStudioPostgresSafetyError(
      'database is not postiz_content_studio_p211'
    );
  }
  if (url.username !== USER) {
    throw new ContentStudioPostgresSafetyError('user is not p211');
  }
  // libpq style parameters (host=, hostaddr=, ...) could point elsewhere
  if (url.search || url.hash) {
    throw new ContentStudioPostgresSafetyError('URL has parameters');
  }
  return raw;
}

export function contentStudioPostgresUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env[CONTENT_STUDIO_POSTGRES_URL_ENV];
  if (!raw) {
    throw new ContentStudioPostgresSafetyError(
      `${CONTENT_STUDIO_POSTGRES_URL_ENV} is required for the isolated Content Studio PostgreSQL integration suite`
    );
  }
  const url = assertContentStudioPostgresUrl(raw);
  // Prisma tooling reads DATABASE_URL: it may only name the same database
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== url) {
    throw new ContentStudioPostgresSafetyError(
      'DATABASE_URL is set to another database'
    );
  }
  return url;
}

// The only way the integration suite gets a client: checked first, then
// bound to that URL whatever the environment says
export function createContentStudioPostgresClient(
  env: NodeJS.ProcessEnv = process.env
) {
  const url = contentStudioPostgresUrlFromEnv(env);
  return new PrismaClient({ datasources: { db: { url } } });
}
