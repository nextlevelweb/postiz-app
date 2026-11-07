import fs from 'fs';
import path from 'path';
import { ValidationPipe } from '@nestjs/common';
import { UpdateContentStudioAIConnectionDto } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.ai-connection.dto';

// The Phase 2 security decisions in one place (P2-11), pinned on the source:
// who may do what, which code may see a credential, and what the routes
// never add. The behavior behind each line is covered by the unit specs of
// each service and by the PostgreSQL integration suite; this spec keeps the
// decisions from drifting. Comments are stripped: they explain the rules and
// may name them
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const code = (relative: string) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SERVICES =
  'libraries/nestjs-libraries/src/database/prisma/content-studio';
const CONTROLLER = code(
  'apps/backend/src/api/routes/content-studio.controller.ts'
);
const CONNECTION_SERVICE = code(
  `${SERVICES}/content-studio.ai-connection.service.ts`
);
const CONNECTION_REPOSITORY = code(
  `${SERVICES}/content-studio.ai-connection.repository.ts`
);
// The editorial policy is for every member too, except its approval switch,
// which only administrators change since Review 20 (pinned in
// content-studio.editorial-policy.service.spec.ts ES8)
const MEMBER_SERVICES = [
  'content-studio.writing-profile.service.ts',
  'content-studio.audience-profile.service.ts',
  'content-studio.expertise-profile.service.ts',
  'content-studio.ai-writing.service.ts',
].map((file) => [file, code(`${SERVICES}/${file}`)] as const);

// The body of one class method: from its name to the next method
const method = (source: string, name: string) => {
  const start = source.search(new RegExp(`\\n  (async )?${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const next = source
    .slice(start + 1)
    .search(/\n  (private )?(async )?[a-zA-Z]+\(/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
};

// The source of every route handler, keyed by its route
const routes = () => {
  const found: Record<string, string> = {};
  const pattern = /@(Get|Post|Put|Patch|Delete)\('([^']*)'\)/g;
  const marks = Array.from(CONTROLLER.matchAll(pattern));
  marks.forEach((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : undefined;
    found[`${mark[1].toUpperCase()} ${mark[2]}`] = CONTROLLER.slice(
      mark.index,
      end
    );
  });
  return found;
};

describe('Phase 2 authorization decisions', () => {
  it('AUTH1 every AI connection change and the connection test need an ADMIN or SUPERADMIN member', () => {
    for (const name of [
      'createConnection',
      'updateConnection',
      'replaceCredential',
      'disableConnection',
      'enableConnection',
      'archiveConnection',
      'testConnection',
    ]) {
      expect(method(CONNECTION_SERVICE, name)).toContain(
        'this.assertManager(actor);'
      );
    }
    expect(CONNECTION_SERVICE).toMatch(
      /MANAGER_ROLES: string\[\] = \[Role\.ADMIN, Role\.SUPERADMIN\]/
    );
  });

  it('AUTH2 any member reads connections and the catalog: no actor, no role', () => {
    for (const name of ['listConnections', 'getConnection', 'listProviders']) {
      expect(method(CONNECTION_SERVICE, name)).not.toMatch(
        /assertManager|actor|role/i
      );
    }
    const all = routes();
    for (const route of [
      'GET /ai/connections',
      'GET /ai/connections/:id',
      'GET /ai/providers',
    ]) {
      expect(all[route]).not.toMatch(/GetUserFromRequest|actor|role/i);
    }
  });

  it('AUTH3-AUTH7 profiles, the editorial policy and AI writing are for every member', () => {
    for (const [file, source] of MEMBER_SERVICES) {
      expect([file, source]).not.toEqual([
        file,
        expect.stringMatching(
          /assertManager|MANAGER_ROLES|Role\.|ADMIN|SUPERADMIN|\.role\b|users\?*\./
        ),
      ]);
    }
    const all = routes();
    const memberRoutes = Object.entries(all).filter(([route]) =>
      /writing-profiles|editorial-policy|audience-profiles|expertise-profiles|\/ai\/(item|thread)$/.test(
        route
      )
    );
    expect(memberRoutes.map(([route]) => route).sort()).toEqual([
      'GET /audience-profiles',
      'GET /audience-profiles/:id',
      'GET /audience-profiles/:id/revisions',
      'GET /audience-profiles/:id/revisions/:revisionId',
      'GET /editorial-policy',
      'GET /editorial-policy/revisions',
      'GET /editorial-policy/revisions/:revisionId',
      'GET /expertise-profiles',
      'GET /expertise-profiles/:id',
      'GET /expertise-profiles/:id/revisions',
      'GET /expertise-profiles/:id/revisions/:revisionId',
      'GET /writing-profiles',
      'GET /writing-profiles/:id',
      'GET /writing-profiles/:id/revisions',
      'GET /writing-profiles/:id/revisions/:revisionId',
      'PATCH /audience-profiles/:id',
      'PATCH /expertise-profiles/:id',
      'PATCH /writing-profiles/:id',
      'POST /audience-profiles',
      'POST /audience-profiles/:id/archive',
      'POST /audience-profiles/:id/restore',
      'POST /audience-profiles/:id/revisions',
      'POST /editorial-policy/revisions',
      'POST /expertise-profiles',
      'POST /expertise-profiles/:id/archive',
      'POST /expertise-profiles/:id/restore',
      'POST /expertise-profiles/:id/revisions',
      'POST /packages/:id/ai/item',
      'POST /packages/:id/ai/thread',
      'POST /writing-profiles',
      'POST /writing-profiles/:id/archive',
      'POST /writing-profiles/:id/restore',
      'POST /writing-profiles/:id/revisions',
    ]);
    for (const [, handler] of memberRoutes) {
      // the organization's id and the user's id only, never a membership
      expect(handler).not.toMatch(/organization: org|actor|\.role|users/);
    }
  });

  it('AUTH8/AUTH9 no Content Studio route uses CheckPolicies, a guard or the AI subscription section', () => {
    // the one guard is Review 20's rate limit of the expensive writes, which
    // decides nothing about who may call them (RL5 pins where it is)
    expect(
      CONTROLLER.replace(
        /@UseGuards\(ThrottlerContentStudioGuard\)/g,
        ''
      ).replace(/^  UseGuards,$/m, '')
    ).not.toMatch(
      /CheckPolicies|UseGuards|Sections\.|AuthorizationActions|permissions\.ability/
    );
    for (const [, source] of MEMBER_SERVICES) {
      expect(source).not.toMatch(
        /CheckPolicies|Sections\.|subscription|billing|credits?\b(?! left)|wallet|stripe/i
      );
    }
    expect(CONNECTION_SERVICE).not.toMatch(
      /CheckPolicies|Sections\.|subscription|billing|wallet|stripe/i
    );
  });

  it('AUTH10 no Phase 2 service answers 401, 402 or 406, nor logs the user out with a 403 exception', () => {
    for (const source of [
      CONNECTION_SERVICE,
      CONTROLLER,
      ...MEMBER_SERVICES.map(([, s]) => s),
    ]) {
      expect(source).not.toMatch(
        /,\s*40[126]\s*\)|UnauthorizedException|PaymentRequired|NotAcceptableException|HttpForbiddenException/
      );
    }
  });
});

describe('Phase 2 credential boundary', () => {
  it('SEC1/SEC3 only the resolver read selects the sealed credential', () => {
    const summary = CONNECTION_REPOSITORY.slice(
      CONNECTION_REPOSITORY.indexOf('const CONNECTION_SUMMARY'),
      CONNECTION_REPOSITORY.indexOf('} as const;')
    );
    expect(summary).not.toMatch(/sealedCredential/);
    expect(CONNECTION_REPOSITORY.match(/sealedCredential: true/g)).toHaveLength(
      1
    );
    expect(
      method(CONNECTION_REPOSITORY, 'getSealedCredentialForResolver')
    ).toContain('sealedCredential: true');
  });

  it('SEC2 the public connection shape is built field by field, without the envelope or key', () => {
    const shape = CONNECTION_SERVICE.slice(
      CONNECTION_SERVICE.indexOf('export const toPublicAIConnection'),
      CONNECTION_SERVICE.indexOf(
        '});',
        CONNECTION_SERVICE.indexOf('export const toPublicAIConnection')
      )
    );
    expect(shape).toContain('credentialPresent: true');
    expect(shape).not.toMatch(/sealedCredential|apiKey|\.\.\.row/);
  });

  it('SEC4 the AI writing layer never sees a key, an envelope or the resolver', () => {
    const writing = MEMBER_SERVICES.find(([file]) =>
      file.includes('ai-writing')
    )![1];
    expect(writing).not.toMatch(
      /apiKey|sealedCredential|openContentStudioAICredential|ContentStudioAIProviderResolver|secretBox|SecretBox|generateText/
    );
  });

  it('PI1 the repository never writes a provider after creation; PI2 the update body refuses one', async () => {
    const updates = [
      'updateConnectionMetadata',
      'replaceCredential',
      'setValidationResult',
      'disableConnection',
      'enableConnection',
      'archiveConnection',
    ];
    for (const name of updates) {
      expect(method(CONNECTION_REPOSITORY, name)).not.toMatch(/provider/);
    }
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    await expect(
      pipe.transform(
        { name: 'Renamed', provider: 'anthropic' },
        { type: 'body', metatype: UpdateContentStudioAIConnectionDto }
      )
    ).rejects.toMatchObject({
      response: {
        message: expect.arrayContaining(['property provider should not exist']),
      },
    });
  });

  it('39 customer-managed AI only: no Content Studio code names a platform AI key', () => {
    const roots = [
      'libraries/nestjs-libraries/src/content-studio',
      SERVICES,
      'apps/frontend/src/components/content-studio',
    ];
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(`${dir}/${entry.name}`)
            : [`${dir}/${entry.name}`]
        );
    const files = roots
      .flatMap(walk)
      .filter((file) => /\.tsx?$/.test(file) && !/\.spec\.tsx?$/.test(file));
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|process\.env/
        ),
      ]);
    }
  });
});
