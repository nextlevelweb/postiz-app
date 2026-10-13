import { PrismaClient } from '@prisma/client';
import {
  assertContentStudioPostgresUrl,
  CONTENT_STUDIO_POSTGRES_URL,
  CONTENT_STUDIO_POSTGRES_URL_ENV,
  ContentStudioPostgresSafetyError,
  contentStudioPostgresUrlFromEnv,
  createContentStudioPostgresClient,
} from '../../../../../../jest.content-studio.postgres.guard';

// No database: the client is mocked, so these tests prove that only the
// disposable local P1-11 database can ever get a client
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));

const APPROVED = CONTENT_STUDIO_POSTGRES_URL;
const withUrl = (url: string, extra: NodeJS.ProcessEnv = {}) =>
  ({ [CONTENT_STUDIO_POSTGRES_URL_ENV]: url, ...extra } as NodeJS.ProcessEnv);

const REJECTED: [string, string][] = [
  [
    'SG2 public-looking hostname',
    'postgresql://p111:p111_local_only@db.example.com:55432/postiz_content_studio_p111',
  ],
  [
    'SG3 LAN address 192.168.1.10',
    'postgresql://p111:p111_local_only@192.168.1.10:55432/postiz_content_studio_p111',
  ],
  [
    'LAN address 10.0.0.5',
    'postgresql://p111:p111_local_only@10.0.0.5:55432/postiz_content_studio_p111',
  ],
  [
    'LAN address 172.17.0.2',
    'postgresql://p111:p111_local_only@172.17.0.2:55432/postiz_content_studio_p111',
  ],
  [
    'public IP',
    'postgresql://p111:p111_local_only@8.8.8.8:55432/postiz_content_studio_p111',
  ],
  [
    '0.0.0.0',
    'postgresql://p111:p111_local_only@0.0.0.0:55432/postiz_content_studio_p111',
  ],
  [
    'another loopback spelling (127.0.0.2)',
    'postgresql://p111:p111_local_only@127.0.0.2:55432/postiz_content_studio_p111',
  ],
  [
    'SG4 127.0.0.1:5432',
    'postgresql://p111:p111_local_only@127.0.0.1:5432/postiz_content_studio_p111',
  ],
  [
    'port 5433',
    'postgresql://p111:p111_local_only@127.0.0.1:5433/postiz_content_studio_p111',
  ],
  [
    'no explicit port',
    'postgresql://p111:p111_local_only@127.0.0.1/postiz_content_studio_p111',
  ],
  [
    'SG5 wrong database (postizdb)',
    'postgresql://p111:p111_local_only@127.0.0.1:55432/postizdb',
  ],
  [
    'database with a trailing path',
    'postgresql://p111:p111_local_only@127.0.0.1:55432/postiz_content_studio_p111/x',
  ],
  [
    'SG6 wrong user (postizlocal)',
    'postgresql://postizlocal:p111_local_only@127.0.0.1:55432/postiz_content_studio_p111',
  ],
  ['no user', 'postgresql://127.0.0.1:55432/postiz_content_studio_p111'],
  [
    'SG7 Docker service hostname postgres',
    'postgresql://p111:p111_local_only@postgres:55432/postiz_content_studio_p111',
  ],
  [
    'libpq host parameter',
    'postgresql://p111:p111_local_only@127.0.0.1:55432/postiz_content_studio_p111?host=db.example.com',
  ],
  [
    'another protocol',
    'mysql://p111:p111_local_only@127.0.0.1:55432/postiz_content_studio_p111',
  ],
  ['SG8 malformed URL', 'not a url'],
  [
    'malformed port',
    'postgresql://p111:x@127.0.0.1:port/postiz_content_studio_p111',
  ],
];

describe('Content Studio PostgreSQL safety gate', () => {
  it('SG1 accepts the exact approved disposable URL', () => {
    expect(APPROVED).toBe(
      'postgresql://p111:p111_local_only@127.0.0.1:55432/postiz_content_studio_p111'
    );
    expect(assertContentStudioPostgresUrl(APPROVED)).toBe(APPROVED);
  });

  it('accepts the same database over localhost and ::1, and postgres:', () => {
    for (const url of [
      'postgresql://p111:p111_local_only@localhost:55432/postiz_content_studio_p111',
      'postgresql://p111:p111_local_only@[::1]:55432/postiz_content_studio_p111',
      'postgres://p111:p111_local_only@127.0.0.1:55432/postiz_content_studio_p111',
    ]) {
      expect(assertContentStudioPostgresUrl(url)).toBe(url);
    }
  });

  it.each(REJECTED)('rejects %s', (_name, url) => {
    expect(() => assertContentStudioPostgresUrl(url)).toThrow(
      ContentStudioPostgresSafetyError
    );
  });

  it('never repeats the rejected URL in its error', () => {
    const url =
      'postgresql://p111:secret-value@db.example.com:55432/postiz_content_studio_p111';
    expect(() => assertContentStudioPostgresUrl(url)).toThrow(
      /^Refusing the Content Studio integration database: host is not loopback$/
    );
  });

  it('SG9 fails closed without the integration URL, whatever DATABASE_URL says', () => {
    for (const env of [
      {},
      { [CONTENT_STUDIO_POSTGRES_URL_ENV]: '' },
      { DATABASE_URL: APPROVED },
    ] as NodeJS.ProcessEnv[]) {
      expect(() => contentStudioPostgresUrlFromEnv(env)).toThrow(
        `${CONTENT_STUDIO_POSTGRES_URL_ENV} is required for the isolated Content Studio PostgreSQL integration suite`
      );
    }
  });

  it('refuses a DATABASE_URL that names another database', () => {
    expect(() =>
      contentStudioPostgresUrlFromEnv(
        withUrl(APPROVED, {
          DATABASE_URL: 'postgresql://postiz:x@127.0.0.1:5432/postiz',
        })
      )
    ).toThrow('DATABASE_URL is set to another database');
    expect(
      contentStudioPostgresUrlFromEnv(
        withUrl(APPROVED, { DATABASE_URL: APPROVED })
      )
    ).toBe(APPROVED);
    expect(contentStudioPostgresUrlFromEnv(withUrl(APPROVED))).toBe(APPROVED);
  });

  // SM1-SM8: a rejected URL never reaches the Prisma client
  it.each([
    ...REJECTED.map(([name, url]) => [name, withUrl(url)] as const),
    ['SM8 absent integration URL', {} as NodeJS.ProcessEnv] as const,
    [
      'absent integration URL with a DATABASE_URL',
      { DATABASE_URL: APPROVED } as NodeJS.ProcessEnv,
    ] as const,
  ])('constructs no client for %s', (_name, env) => {
    expect(() => createContentStudioPostgresClient(env)).toThrow(
      ContentStudioPostgresSafetyError
    );
    expect(PrismaClient).not.toHaveBeenCalled();
  });

  it('binds the client to the approved URL, not to DATABASE_URL or the schema', () => {
    createContentStudioPostgresClient(withUrl(APPROVED));
    expect(PrismaClient).toHaveBeenCalledTimes(1);
    expect(PrismaClient).toHaveBeenCalledWith({
      datasources: { db: { url: APPROVED } },
    });
  });
});
