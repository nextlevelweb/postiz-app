import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION,
  CONTENT_PACKAGE_SCHEMA_VERSION,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { DESIGN_DOCUMENT_SCHEMA_VERSION } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  CONTENT_STUDIO_SOURCE_KINDS,
  isContentStudioSourceKind,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

// Research feed ingestion (P8-01) in one place, pinned on the source: a feed
// is an ordinary source of kind `feed`, read only through SafeFetch and an
// XML parser that is handed a string; the pages it lists become ordinary
// `url` sources with ordinary versions, and the only new record is that a
// feed listed a page. Grounding, AI, packages, designs and review know
// nothing of feeds. The behavior is covered by source.feed.spec.ts,
// source.feed.capture.spec.ts, the controller, orchestrator and frontend
// specs and the PostgreSQL suite; this spec keeps the decisions from
// drifting. Comments are stripped: they explain the rules and may name them
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const BASES = [
  'libraries/nestjs-libraries/src',
  'libraries/helpers/src',
  'apps/backend/src',
  'apps/orchestrator/src',
  'apps/frontend/src',
];
const SKIPPED = new Set(['node_modules', 'dist', '.next', 'generated']);
const walk = (directory: string): string[] =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return SKIPPED.has(entry.name) ? [] : walk(full);
        }
        return /\.tsx?$/.test(entry.name) &&
          !/\.(spec|test)\.tsx?$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
          ? [full]
          : [];
      })
    : [];
const PRODUCTION = BASES.flatMap((base) =>
  walk(path.join(REPO_ROOT, base))
).map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
const code = (relative: string) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const CODE = new Map(PRODUCTION.map((file) => [file, code(file)]));
const users = (pattern: RegExp) =>
  PRODUCTION.filter((file) => pattern.test(CODE.get(file)!)).sort();
const raw = (relative: string) =>
  fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const SOURCES = 'libraries/nestjs-libraries/src/content-studio/sources';
const FEED_FILES = [
  `${SOURCES}/source.feed.ts`,
  `${SOURCES}/ingestion/source.ingestion.service.ts`,
  'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-discovery.repository.ts',
  'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
  'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
  'apps/orchestrator/src/activities/content-studio.source.activity.ts',
  'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts',
];
const schema = raw(
  'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
);
const model = (name: string) => {
  const match = schema.match(
    new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`)
  );
  if (!match) {
    throw new Error(`model ${name} not found`);
  }
  return match[1];
};
const fields = (name: string) =>
  model(name)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([field]) => field && !field.startsWith('@@'))
    .map(([field, type]) => `${field} ${type}`);

describe('P8-01 feed network access', () => {
  it('P801-1 Content Studio fetches a feed or a page only through safeFetch, in the ingestion service', () => {
    const contentStudio = PRODUCTION.filter((file) =>
      /content-studio|content\.studio/.test(file)
    );
    expect(
      contentStudio.filter((file) => /\bsafeFetch\(/.test(CODE.get(file)!))
    ).toEqual([`${SOURCES}/ingestion/source.ingestion.service.ts`]);
    for (const file of FEED_FILES) {
      expect([
        file,
        CODE.get(file)!.match(
          /\bfetch\(|axios|undici|got\(|node:https?|from 'https?'|XMLHttpRequest/g
        ),
      ]).toEqual([file, null]);
    }
  });

  it('P801-2/FC4/M2 nothing in Content Studio or the orchestrator can let a library fetch a feed URL', () => {
    expect(users(/rss-parser|parseURL\(/)).toEqual([
      // upstream AutoPost keeps its own feed reading; Content Studio never
      // goes through it
      'libraries/nestjs-libraries/src/database/prisma/autopost/autopost.service.ts',
    ]);
    for (const file of FEED_FILES) {
      expect([file, /autopost|AutopostService/i.test(CODE.get(file)!)]).toEqual(
        [file, false]
      );
    }
    // the XML parser only ever reads the decoded string
    expect(
      CODE.get(`${SOURCES}/source.feed.ts`)!.match(/parser\.parse\(([^)]*)\)/g)
    ).toEqual(['parser.parse(xml)']);
  });
});

describe('P8-01 the source model', () => {
  it('62/SK2/SK3 kinds are exactly url and feed, as text: no enum', () => {
    expect([...CONTENT_STUDIO_SOURCE_KINDS]).toEqual(['url', 'feed']);
    for (const kind of [
      'Feed',
      'rss',
      'atom',
      'url ',
      '__proto__',
      'toString',
    ]) {
      expect([kind, isContentStudioSourceKind(kind)]).toEqual([kind, false]);
    }
    expect(model('ContentStudioSource')).toMatch(/\n\s+kind\s+String\n/);
    expect(schema).not.toMatch(/enum ContentStudioSourceKind/);
  });

  it('P801-3/75/77/78 a discovery is a feed listing a page: composite same-organization keys, Restrict, one row per feed and page', () => {
    expect(fields('ContentStudioSourceDiscovery')).toEqual([
      'id String',
      'organizationId String',
      'feedSourceId String',
      'discoveredSourceId String',
      'entryId String?',
      'entryTitle String?',
      'publishedAt DateTime?',
      'firstSeenAt DateTime',
      'lastSeenAt DateTime',
      'organization Organization',
      'feedSource ContentStudioSource',
      'discoveredSource ContentStudioSource',
    ]);
    const block = model('ContentStudioSourceDiscovery');
    expect(block).toContain(
      '@relation("ContentStudioSourceDiscoveryFeed", fields: [feedSourceId, organizationId], references: [id, organizationId], onDelete: Restrict, onUpdate: Restrict)'
    );
    expect(block).toContain(
      '@relation("ContentStudioSourceDiscoveryDiscovered", fields: [discoveredSourceId, organizationId], references: [id, organizationId], onDelete: Restrict, onUpdate: Restrict)'
    );
    expect(block).toContain(
      '@@unique([organizationId, feedSourceId, discoveredSourceId])'
    );
    // no feed version table, no copy of page content
    expect(schema).not.toMatch(/model ContentStudio(Feed|SourceFeed)\w*/);
    // the source keeps its identity rules
    expect(model('ContentStudioSource')).toContain(
      '@@unique([organizationId, canonicalUrl])'
    );
  });

  it('P801-3 discovered pages are created as ordinary url sources and captured by the one version writer', () => {
    const ingestion = CODE.get(
      `${SOURCES}/ingestion/source.ingestion.service.ts`
    )!;
    // P8-C1: within the organization's page source limit
    expect(ingestion.match(/createSource\w*\(/g)).toEqual([
      'createSourcesWithinLimit(',
    ]);
    expect(ingestion).toMatch(
      /createSourcesWithinLimit\(\{\s*organizationId,\s*kind: 'url',/
    );
    expect(users(/appendVersionWithCompareAndSwap\(/)).toEqual([
      `${SOURCES}/ingestion/source.ingestion.service.ts`,
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    ]);
    expect(ingestion.match(/appendVersionWithCompareAndSwap\(/g)).toHaveLength(
      1
    );
    expect(users(/contentStudioSourceVersion\.create\(/)).toEqual([
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    ]);
  });

  it('a discovery is written by the feed capture only: no route, DTO or other service', () => {
    expect(users(/recordDiscovery\(/)).toEqual([
      `${SOURCES}/ingestion/source.ingestion.service.ts`,
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-discovery.repository.ts',
    ]);
    expect(
      users(
        /contentStudioSourceDiscovery\.(create|update|updateMany|upsert|delete|deleteMany)\(/
      )
    ).toEqual([
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-discovery.repository.ts',
    ]);
    const repository = CODE.get(
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-discovery.repository.ts'
    )!;
    expect(repository).not.toMatch(/\.delete(Many)?\(|\.upsert\(/);
    // firstSeenAt is written once, at creation; a sighting moves lastSeenAt
    // forward only and keeps the entry's metadata of that sighting
    expect(repository.match(/firstSeenAt: input\.seenAt/g)).toHaveLength(1);
    expect(repository).toMatch(
      /lastSeenAt: \{ lt: input\.seenAt \},\s*\},\s*data: \{\s*lastSeenAt: input\.seenAt,\s*entryId: input\.entryId,\s*entryTitle: input\.entryTitle,\s*publishedAt: input\.publishedAt,\s*\}/
    );
  });
});

describe('P8-01 what does not change', () => {
  it('P801-4/37 grounding and AI writing know nothing of feeds or discoveries', () => {
    for (const file of [
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.grounding.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-writing.service.ts',
      'apps/frontend/src/components/content-studio/content-studio.grounding.tsx',
      'apps/frontend/src/components/content-studio/content-studio.ai-writing.tsx',
    ]) {
      expect([file, CODE.get(file)!.match(/feed|discover/gi)]).toEqual([
        file,
        null,
      ]);
    }
    // a feed has no version, and AI writing only grounds on a current
    // version of a web page (the kind is checked explicitly since P8-03)
    expect(
      CODE.get(
        'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-writing.service.ts'
      )
    ).toMatch(
      /if \(row\.kind !== 'url' \|\| row\.latestVersionNumber < 1\) \{\s*throw sourceNotReady\(\);/
    );
    // the pickers (P8-03) list web pages only and offer captured ones only
    expect(
      CODE.get(
        'apps/frontend/src/components/content-studio/content-studio.source.picker.tsx'
      )
    ).toMatch(/source\.latestVersionNumber >= 1/);
    // the evidence picker chooses through the same picker (P8-03), and the
    // picker knows nothing of feeds either: it lists web pages
    expect(
      CODE.get(
        'apps/frontend/src/components/content-studio/content-studio.grounding.tsx'
      )
    ).toMatch(/<ContentStudioSourcePicker\s+mode="single"/);
    const picker = CODE.get(
      'apps/frontend/src/components/content-studio/content-studio.source.picker.tsx'
    )!;
    expect(picker.match(/feed|discover/gi)).toBeNull();
    expect(picker).toContain(
      "useContentStudioSources(false, page, 'url', search)"
    );
  });

  it('P801-5/P801-6/P801-7 feed ingestion has no AI, scoring, topics or competitors', () => {
    for (const file of FEED_FILES) {
      expect([
        file,
        CODE.get(file)!.match(
          /AIConnection|AIExecution|AIOperation|AIUsage|ai\.execution|ai\.provider|openai|anthropic|embedding|\bscore|sentiment|\btopic|cluster|competitor|relevance|summari[sz]/gi
        ),
      ]).toEqual([file, null]);
    }
    expect(schema).not.toMatch(
      /model ContentStudio\w*(Competitor|Trend|Topic|Radar|Score)\w*/
    );
  });

  it('P801-8 Content Package and Design Document keep their schema versions', () => {
    expect([
      CONTENT_PACKAGE_SCHEMA_VERSION,
      CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION,
      DESIGN_DOCUMENT_SCHEMA_VERSION,
    ]).toEqual([1, 2, 1]);
    for (const name of [
      'ContentPackage',
      'ContentPackageRevision',
      'ContentStudioDesignProject',
      'ContentStudioDesignRevision',
      'ContentStudioReview',
      'ContentStudioApproval',
      'ContentStudioHandoff',
    ]) {
      expect([name, /discover|feed/i.test(model(name))]).toEqual([name, false]);
    }
  });

  it('P801-9 no deferred Phase 7 work: no design duplicate, library page, logo or snippet', () => {
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(controller).not.toMatch(/duplicate|\/library|snippet/i);
    expect(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          'apps/frontend/src/app/(app)/(site)/content-studio/library'
        )
      )
    ).toBe(false);
    expect(
      raw('libraries/nestjs-libraries/src/content-studio/brand/brand.kit.ts')
    ).not.toMatch(/logo:|logos:/);
  });

  it('P801-10 the feed reader uses parsers the project already declares', () => {
    const manifest = JSON.parse(raw('package.json'));
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const name of ['fast-xml-parser', 'parse5']) {
      expect([name, typeof dependencies[name]]).toEqual([name, 'string']);
    }
  });

  it('113 upstream AutoPost and the post workflows are untouched by feed capture', () => {
    for (const file of FEED_FILES) {
      expect([
        file,
        /posts\.service|PostsService|integration\.manager|autoPost/i.test(
          CODE.get(file)!
        ),
      ]).toEqual([file, false]);
    }
    expect(
      raw('apps/orchestrator/src/workflows/autopost.workflow.ts')
    ).not.toMatch(/content.?studio/i);
  });
});

describe('P8-01 routes', () => {
  it('79/50 one new read route; capture stays the one refresh route; the organization comes from the request', () => {
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
      // P8-02: one more, News Radar across feeds
      // P8-04A: one more, what changed in a source version
      // P8-04B1: one more, the organization's page changes
    ).toHaveLength(145);
    const handler = controller.slice(
      controller.indexOf("@Get('/sources/:id/discoveries')"),
      controller.indexOf("@Post('/sources/:id/archive')")
    );
    expect(handler).toMatch(/@GetOrgFromRequest\(\) org: Organization/);
    expect(handler).toMatch(
      /organizationId: org\.id,\s*sourceId: id,\s*page: query\.page,/
    );
    expect(handler).not.toMatch(/@Body|safeFetch|ingestion/i);
    expect(controller).not.toMatch(
      /\/feeds?\b|\/capture\b|\/discoveries\/:|\/radar/
    );
  });
});

// News Radar (P8-02): a read model over the P8-01 discoveries, their feeds
// and their pages, nothing else. The behavior is covered by
// content-studio.news-radar.spec.ts, the controller and frontend specs and
// the PostgreSQL suite; these keep the decisions from drifting
const RADAR_BACKEND = {
  service:
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
  repository:
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-discovery.repository.ts',
  dto: 'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.source.dto.ts',
};
const RADAR_FRONTEND = [
  'apps/frontend/src/components/content-studio/content-studio.research.tsx',
  'apps/frontend/src/components/content-studio/content-studio.research.api.ts',
  'apps/frontend/src/components/content-studio/content-studio.discovery.row.tsx',
  'apps/frontend/src/app/(app)/(site)/content-studio/research/page.tsx',
];
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect([start, from > -1 && to > from]).toEqual([start, true]);
  return text.slice(from, to);
};
const radarCode = () => {
  const service = CODE.get(RADAR_BACKEND.service)!;
  const repository = CODE.get(RADAR_BACKEND.repository)!;
  const controller = CODE.get(
    'apps/backend/src/api/routes/content-studio.controller.ts'
  )!;
  return {
    method: between(
      service,
      'async listOrganizationDiscoveries(',
      'private toPublicDiscovery('
    ),
    repository: [
      between(repository, 'const radarWhere', '});\n'),
      repository.slice(repository.indexOf('listDiscoveriesForOrganization(')),
    ].join('\n'),
    handler: between(controller, "@Get('/discoveries')", '\n  }\n'),
    frontend: RADAR_FRONTEND.map((file) => CODE.get(file)!).join('\n'),
  };
};

describe('P8-02 News Radar', () => {
  it('P802-1 the organization-wide Radar only reads: no write, capture, fetch or mark', () => {
    const { method, repository, handler } = radarCode();
    for (const part of [method, repository, handler]) {
      expect(part).not.toMatch(
        /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$transaction|recordDiscovery|markFeedCaptured|appendVersion|refreshSource|captureFeed|captureUrl|safeFetch|fetch\(|Ingestion|lastSeenAt:|readAt|unread/
      );
    }
    expect(handler).toMatch(
      /listOrganizationDiscoveries\(\{\s*organizationId: org\.id,\s*page: query\.page,\s*since: query\.since,\s*feedSourceId: query\.feedSourceId,\s*captureState: query\.captureState,\s*\}\)/
    );
    // the window is the first sighting; the list and its count share one filter
    expect(repository).toMatch(/firstSeenAt: \{ gte: input\.seenSince \}/);
    expect(repository).toMatch(/feedSource: \{ archivedAt: null \}/);
    expect(repository.match(/where: radarWhere\(input\)/g)).toHaveLength(2);
  });

  it('P802-2/P802-3/P802-4 no AI, package creation, network or feed capture in the Radar', () => {
    const { method, repository, handler, frontend } = radarCode();
    // P8-03 (P803-9): the Radar may open the New package dialog through the
    // shared Use in content button, and nothing else of packages: no
    // createPackage, no /packages, no AI
    const own = frontend
      .replace(
        "from '@gitroom/frontend/components/content-studio/content-studio.package.list'",
        ''
      )
      .replace(
        "import { ContentStudioUseInContent } from '@gitroom/frontend/components/content-studio/content-studio.package.modal';",
        ''
      );
    expect(frontend.match(/content-studio\.package\.modal/g)).toHaveLength(1);
    for (const part of [method, repository, handler, own]) {
      expect(part).not.toMatch(
        /AIConnection|AIExecution|AIOperation|AIUsage|ai[-.]writing|ai\.execution|openai|anthropic|embedding|\bscore|relevance|sentiment|\btopic|cluster|competitor|summari[sz]/i
      );
      expect(part).not.toMatch(
        /createPackage|ContentPackage|package\.service|\/packages|createDesign|handoff|review/i
      );
      expect(part).not.toMatch(
        /safeFetch|source\.ingestion|source\.feed|useContentStudioSourceActions|\/refresh|favicon|og:image|XMLHttpRequest|axios|window\.open|new Image/i
      );
    }
    expect(own).not.toMatch(
      /refreshInterval|setInterval|WebSocket|EventSource/
    );
    expect(own).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });

  it('P802-5 schema.prisma is byte-identical to its P8-01 version, but for the P8-04B1 page-change fields', () => {
    // P8-02 changes no schema; a later phase that does updates this pin.
    // P8-04B1 adds the four derived page-change fields and one index (pinned
    // by P804B1-1/P804B1-2)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '0c0638c523fe2e1439b81130c7e05f9eacdc12465ffac41f5be04b9d377af6e5'
    );
    // the Radar reads the P8-01 indexes
    expect(model('ContentStudioSourceDiscovery')).toMatch(
      /@@index\(\[organizationId, firstSeenAt\]\)\s*@@index\(\[feedSourceId, firstSeenAt\]\)/
    );
  });

  it('P802-6/P802-7 no News Radar model and no read or unread state', () => {
    expect(schema).not.toMatch(
      /model \w*(Radar|Research|ReadState|Unread)\w* \{/i
    );
    expect(schema).not.toMatch(/\b(readAt|unread|isRead|seenBy)\b/i);
    expect(
      users(/\.contentStudio(News)?Radar\w*\.|NewsRadarItem|RadarItem/)
    ).toEqual([]);
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(controller).not.toMatch(/\/read\b|\/unread|\/mark|\/seen/);
  });

  it('P802-8 the source kind filter is optional: without it the list is the P3 one', () => {
    const dto = between(
      CODE.get(RADAR_BACKEND.dto)!,
      'export class ListContentStudioSourcesDto',
      'export class CreateContentStudioSourceDto'
    );
    expect(dto).toMatch(
      /@IsOptional\(\)\s*@IsIn\(CONTENT_STUDIO_SOURCE_KINDS\)\s*kind\?: string;/
    );
    const sources = CODE.get(
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts'
    )!;
    // one where for the list and its count (P8-03)
    expect(
      sources.match(/\.\.\.\(input\.kind \? \{ kind: input\.kind \} : \{\}\),/g)
    ).toHaveLength(1);
    expect(sources.match(/where: sourceListWhere\(input\)/g)).toHaveLength(2);
  });

  it('P802-9 one new read route, GET /discoveries (143; 144 with P8-04A, 145 with P8-04B1)', () => {
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(145);
    expect(controller.match(/@Get\('\/discoveries'\)/g)).toHaveLength(1);
    expect(controller).not.toMatch(
      /@(Post|Put|Patch|Delete)\('\/discoveries|\/research|\/radar/
    );
  });

  it('P802-10 no deferred Phase 7 work and no deferred Phase 8 work', () => {
    const { frontend } = radarCode();
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(controller).not.toMatch(
      /duplicate|\/library|snippet|\/export|\/import/i
    );
    expect(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          'apps/frontend/src/app/(app)/(site)/content-studio/library'
        )
      )
    ).toBe(false);
    expect(
      raw('libraries/nestjs-libraries/src/content-studio/brand/brand.kit.ts')
    ).not.toMatch(/logo:|logos:/);
    // no search, selection, bulk action, capture-all or tabs in the Radar
    expect(frontend).not.toMatch(
      /type="search"|search=|checkbox|bulk|captureAll|Capture all|role="tablist"/i
    );
  });
});

// Research into content (P8-03): server search of the Source list, one
// Source picker for AI writing and evidence, and "Use in content" from News
// Radar and a web page's own page into the New package dialog. Sources are
// still chosen by id only and read at their current version when AI writing
// runs; nothing new is stored
const FRONTEND = 'apps/frontend/src/components/content-studio';
const HANDOFF = {
  repository:
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
  service:
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
  aiWriting:
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-writing.service.ts',
  aiWritingDto:
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.ai-writing.dto.ts',
  packageDto:
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.package.dto.ts',
  grounding:
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.grounding.service.ts',
  picker: `${FRONTEND}/content-studio.source.picker.tsx`,
  modal: `${FRONTEND}/content-studio.package.modal.tsx`,
  workspace: `${FRONTEND}/content-studio.workspace.tsx`,
  api: `${FRONTEND}/content-studio.api.ts`,
};
const handoff = (key: keyof typeof HANDOFF) => CODE.get(HANDOFF[key])!;

describe('P8-03 research into content', () => {
  it('P803-1/P803-8/P803-12 no schema change: no origin, selection, collection or research model', () => {
    // the P8-01 schema, byte for byte, but for the P8-04B1 page-change
    // fields (P802-5 pins the same hash)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '0c0638c523fe2e1439b81130c7e05f9eacdc12465ffac41f5be04b9d377af6e5'
    );
    expect(schema).not.toMatch(
      /model \w*(Research|Selection|Basket|Collection|Radar)\w* \{/
    );
    expect(fields('ContentStudioSource').map((f) => f.split(' ')[0])).toEqual([
      'id',
      'organizationId',
      'kind',
      'name',
      'canonicalUrl',
      'latestVersionNumber',
      'archivedAt',
      'createdById',
      'createdAt',
      'updatedAt',
      'lastCapturedAt',
      // P8-04B1: derived from the versions, not research
      'lastPageChangeAt',
      'lastPageChangeVersionNumber',
      'lastPageChangeKind',
      'lastPageChangePreviousCaptureAt',
      'organization',
      'createdBy',
      'versions',
      'feedDiscoveries',
      'discoveredBy',
    ]);
    expect(fields('ContentPackage').join('\n')).not.toMatch(
      /research|source|discover|feed/i
    );
    // no origin, manual or curated filter anywhere a list is built
    for (const file of [
      HANDOFF.repository,
      HANDOFF.service,
      RADAR_BACKEND.dto,
      HANDOFF.picker,
      `${FRONTEND}/content-studio.sources.tsx`,
      `${FRONTEND}/content-studio.sources.api.ts`,
    ]) {
      expect([file, CODE.get(file)!.match(/origin|manual|curated/gi)]).toEqual([
        file,
        null,
      ]);
    }
    expect(handoff('repository')).not.toMatch(/discoveredBy:/);
  });

  it('P803-2/P803-6 no new route: GET /sources takes a search, nothing resolves a selection', () => {
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
      // P8-04A: one more, what changed in a source version
      // P8-04B1: one more, the organization's page changes
    ).toHaveLength(145);
    // the routes of sources: the P8-02 ones, nothing to resolve or keep a
    // selection with
    expect(
      Array.from(
        controller.matchAll(
          /@(Get|Post|Put|Patch|Delete)\('(\/sources[^']*)'\)/g
        )
      ).map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    ).toEqual([
      'GET /sources',
      'POST /sources',
      'GET /sources/:id',
      'PATCH /sources/:id',
      'GET /sources/:id/versions',
      'GET /sources/:id/versions/:versionId',
      // P8-04A, read only
      'GET /sources/:id/versions/:versionId/changes',
      'GET /sources/:id/discoveries',
      'POST /sources/:id/archive',
      'POST /sources/:id/restore',
      'POST /sources/:id/refresh',
    ]);
    expect(controller).not.toMatch(
      /@(Get|Post|Put|Patch|Delete)\('[^']*(resolve-selection|selection|research|basket|collection)/i
    );
    expect(between(controller, "@Get('/sources')", '\n  }\n')).toMatch(
      /listSources\(\{\s*organizationId: org\.id,\s*archived: query\.archived,\s*kind: query\.kind,\s*search: query\.search,\s*page: query\.page,\s*\}\)/
    );
  });

  it('P803-3 the search is in one where for the list and its count, with the organization', () => {
    const repository = handoff('repository');
    const where = between(repository, 'const sourceListWhere', '});\n');
    expect(where).toMatch(/organizationId: input\.organizationId,/);
    expect(where).toMatch(
      /OR: \[\s*\{\s*name: \{ contains: likeLiteral\(input\.search\), mode: 'insensitive' \},\s*\},\s*\{\s*canonicalUrl: \{\s*contains: likeLiteral\(input\.search\),\s*mode: 'insensitive',\s*\},\s*\},\s*\]/
    );
    // % _ and \ of the search are escaped for ILIKE: plain text, never a
    // pattern (measured on PostgreSQL in P803PG6)
    expect(repository).toContain(
      "const likeLiteral = (text: string) => text.replace(/[\\\\%_]/g, '\\\\$&');"
    );
    expect(repository.match(/where: sourceListWhere\(input\)/g)).toHaveLength(
      2
    );
    // Prisma only: no raw query, no pattern built by hand
    for (const file of [HANDOFF.repository, HANDOFF.service]) {
      expect(CODE.get(file)).not.toMatch(
        /\$queryRaw|\$executeRaw|Prisma\.sql|ILIKE|LIKE '|new RegExp\(.*search|to_tsvector|similarity\(/i
      );
    }
    // trimmed; blank is none; control text refused
    const service = between(handoff('service'), 'private search(', '\n  }\n');
    expect(service).toMatch(/CONTENT_STUDIO_SOURCE_SEARCH_MAX/);
    expect(service).toMatch(/includes\('\\u0000'\)/);
    expect(service).toMatch(/value\.trim\(\) \|\| undefined/);
  });

  it('P803-4/P803-5/P803-13 the pickers list web pages through the server, offer captured ones only and capture nothing', () => {
    const picker = handoff('picker');
    expect(picker).toContain(
      "useContentStudioSources(false, page, 'url', search)"
    );
    expect(picker).toMatch(/isContentStudioSourceUsable\(source\)/);
    expect(picker).not.toMatch(
      /refresh|capture\(|captureSource|useContentStudioSourceActions|method:|\/versions|safeFetch|setInterval|refreshInterval/
    );
    for (const file of [
      `${FRONTEND}/content-studio.ai-writing.tsx`,
      `${FRONTEND}/content-studio.grounding.tsx`,
    ]) {
      expect([file, /useContentStudioSources\(/.test(CODE.get(file)!)]).toEqual(
        [file, false]
      );
      expect(CODE.get(file)).toMatch(/<ContentStudioSourcePicker/);
    }
    // the server refuses anything but a captured web page, explicitly
    expect(handoff('aiWriting')).toMatch(
      /if \(row\.kind !== 'url' \|\| row\.latestVersionNumber < 1\) \{\s*throw sourceNotReady\(\);\s*\}\s*const version =/
    );
  });

  it('P803-7/P803-14 AI writing still takes source ids only and reads the current version when it runs', () => {
    const dto = handoff('aiWritingDto');
    expect(dto).not.toMatch(
      /versionId|versionNumber|contentHash|sourceHash|sourceVersion|blocks|sourceContent/
    );
    expect(dto).toMatch(
      /@ArrayMaxSize\(CONTENT_STUDIO_AI_MAX_SOURCES\)\s*@ArrayUnique\(\)\s*@IsUUID\(undefined, \{ each: true \}\)\s*sourceIds\?: string\[\] \| null;/
    );
    const sources = between(
      handoff('aiWriting'),
      'private async sources(',
      'return sources;'
    );
    expect(sources).toMatch(
      /getVersionDetailByNumber\(\s*organizationId,\s*row\.id,\s*row\.latestVersionNumber\s*\)/
    );
    expect(sources.match(/getSourceForOrganization\(/g)).toHaveLength(1);
    expect(sources.match(/getVersionDetailByNumber\(/g)).toHaveLength(1);
    // evidence is checked against the exact versions it names
    expect(handoff('grounding')).toMatch(
      /getVersionsByIdsForOrganization\(\s*organizationId,\s*ids\s*\)/
    );
    expect(handoff('grounding')).not.toMatch(/latestVersionNumber/);
  });

  it('P803-9/P803-10 Use in content opens the New package dialog; the package is created as before', () => {
    const modal = handoff('modal');
    const action = modal.slice(
      modal.indexOf('export const ContentStudioUseInContent')
    );
    expect(action).toMatch(/modals\.openModal\(/);
    expect(action).not.toMatch(
      /createPackage|\/packages|propose|\/ai\b|fetch|router\./
    );
    expect(action).toMatch(/isContentStudioSourceUsable\(source\)/);
    // only the dialog's Create writes, with the body it always had
    expect(modal.match(/createPackage\(/g)).toHaveLength(1);
    const body = between(modal, 'createPackage({', '});');
    expect(body).not.toMatch(/source|version|hash/i);
    const create = between(handoff('api'), 'createPackage: async', 'return');
    expect(create).not.toMatch(/source/i);
    expect(
      between(
        handoff('packageDto'),
        'export class CreateContentPackageDto',
        '\n}\n'
      ).match(/^\s+(\w+)\?:/gm)
    ).toEqual(['  name?:', '  projectId?:']);
    // the Radar opens the dialog through the shared action only
    const { frontend } = radarCode();
    expect(frontend).not.toMatch(/createPackage|\/packages|propose|AIWriting/);
  });

  it('P803-11 a link with sources opens no AI dialog and asks nothing of the AI', () => {
    const workspace = handoff('workspace');
    expect(workspace).toMatch(
      /parseContentStudioResearchSourceIds\(researchSources\)/
    );
    // the ids reach the dialog only when the user opens one
    expect(workspace).toMatch(
      /initialSourceIds=\{researchSourceIds\}\s*\/>\s*\),\s*\}\);\s*\},\s*\[modals, generate, t, researchSourceIds\]/
    );
    const effects = workspace
      .split('useEffect(')
      .slice(1)
      .map((part) => part.slice(0, part.indexOf('}, [')));
    for (const effect of effects) {
      expect(effect).not.toMatch(/researchSourceIds|openAIWriting|propose/);
    }
    // the parser: ids only, each once, at most five
    expect(
      between(
        handoff('api'),
        'export const parseContentStudioResearchSourceIds',
        'return ids;'
      )
    ).toMatch(
      /UUID\.test\(id\) && !ids\.includes\(id\)[\s\S]*RESEARCH_SOURCES_MAX/
    );
  });
});

// What changed in a source version (P8-04A): one same-capture rule shared
// with feed captures, a pure comparison, one read route and Source detail
// only. Nothing is stored, no AI is asked, News Radar is untouched
const CHANGE = {
  module: `${SOURCES}/source.change.ts`,
  ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
  service: HANDOFF.service,
  repository: HANDOFF.repository,
  controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
  api: `${FRONTEND}/content-studio.sources.api.ts`,
  detail: `${FRONTEND}/content-studio.source.detail.tsx`,
};
const change = (key: keyof typeof CHANGE) => CODE.get(CHANGE[key])!;

describe('P8-04A source change detection', () => {
  it('P804A-1/P804A-7 no schema change: no change model, table or field', () => {
    // P8-04A stored nothing; P8-04B1 adds the derived page-change fields
    // (P804B1-1) and nothing this forbids
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '0c0638c523fe2e1439b81130c7e05f9eacdc12465ffac41f5be04b9d377af6e5'
    );
    expect(schema).not.toMatch(/model \w*(Change|Diff|Comparison)\w* \{/);
    expect(schema).not.toMatch(
      /\b(lastContentChangedAt|lastChangedAt|contentChangedAt|previousHash|previousVersionId|changeKind|changeClass|isDuplicate|repeatOf|sameCapture)\b/i
    );
  });

  it('P804A-2/P804A-3 one new read route, 144 in all (145 with P8-04B1); it reads only', () => {
    const controller = change('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(145);
    expect(controller.match(/\/changes'/g)).toEqual(["/changes'"]);
    const handler = between(
      controller,
      "@Get('/sources/:id/versions/:versionId/changes')",
      '\n  }\n'
    );
    expect(handler).toMatch(
      /getVersionChanges\(\{\s*organizationId: org\.id,\s*sourceId: id,\s*versionId,\s*\}\)/
    );
    const method = between(
      change('service'),
      'async getVersionChanges(',
      'async listDiscoveries('
    );
    expect(method).not.toMatch(
      /appendVersion|\.create|\.update|\.delete|markFeedCaptured|\$transaction/
    );
  });

  it('P804A-4/P804A-5 no AI, network or capture in the comparison', () => {
    for (const key of ['module', 'service', 'repository'] as const) {
      expect([
        key,
        change(key).match(
          /ai-connection|ai-operation|ai-writing|AIConnection|AIOperation|AIUsage|openai|anthropic|embedding|vector|safeFetch|\bfetch\(/gi
        ),
      ]).toEqual([key, null]);
    }
    const method = between(
      change('service'),
      'async getVersionChanges(',
      'async listDiscoveries('
    );
    expect(method).not.toMatch(
      /ingestion|refresh|captureUrl|captureFeed|safeFetch/i
    );
    // the service is its one caller
    expect(users(/compareContentStudioSourceVersions\(/)).toEqual(
      [CHANGE.module, CHANGE.service].sort()
    );
    expect(
      change('service').match(/compareContentStudioSourceVersions\(/g)
    ).toHaveLength(1);
  });

  it('P804A-6 News Radar and the research handoff do not read changes', () => {
    for (const file of [
      ...RADAR_FRONTEND,
      `${FRONTEND}/content-studio.discovery.row.tsx`,
      `${FRONTEND}/content-studio.source.picker.tsx`,
      `${FRONTEND}/content-studio.package.modal.tsx`,
      `${FRONTEND}/content-studio.workspace.tsx`,
    ]) {
      expect([
        file,
        CODE.get(file)!.match(
          /VersionChanges|\/changes|what_changed|Updated|lastContentChanged/g
        ),
      ]).toEqual([file, null]);
    }
    expect(users(/useContentStudioSourceVersionChanges\(/)).toEqual([
      CHANGE.detail,
    ]);
    expect(radarCode().method).not.toMatch(/change/i);
  });

  it('P804A-8/M31 feed captures and change detection share one same-capture rule', () => {
    expect(change('module')).toMatch(
      /export const isSameContentStudioSourceCapture = \(\s*a: ContentStudioSourceCaptureIdentity,\s*b: ContentStudioSourceCaptureIdentity\s*\) =>\s*a\.contentHash === b\.contentHash &&\s*a\.title === b\.title &&\s*a\.extractionVersion === b\.extractionVersion;/
    );
    const ingestion = change('ingestion');
    // P8-04B1: through the one transition classifier, whose repeat is
    // exactly this rule
    expect(ingestion).toMatch(
      /if \(mode === 'if-changed' && transition === 'repeat'\) \{\s*return \{ status: 'unchanged' as const \};/
    );
    // no second copy of the rule in the Source layer
    const backend = PRODUCTION.filter(
      (file) =>
        file.startsWith(`${SOURCES}/`) ||
        /content-studio\.source[\w.-]*\.ts$/.test(file)
    );
    for (const pattern of [
      /\.contentHash === \w+\.contentHash/,
      /\.extractionVersion === \w+\.extractionVersion/,
    ]) {
      expect(backend.filter((file) => pattern.test(CODE.get(file)!))).toEqual([
        CHANGE.module,
      ]);
    }
  });

  it('P804A-9/M32 a refresh still always appends: only feed captures skip a repeat', () => {
    const ingestion = change('ingestion');
    expect(
      between(
        ingestion,
        'async refreshSource(',
        'async listFeedsDueForCapture('
      )
    ).toMatch(
      /this\.captureUrl\(\s*input\.organizationId,\s*source,\s*input\.userId,\s*'always'\s*\)/
    );
    // P8-04B1: both modes read the version a capture follows; only a feed
    // capture skips a repeat
    expect(ingestion).toMatch(
      /if \(mode === 'if-changed' && transition === 'repeat'\) \{/
    );
    // the one caller with if-changed is a feed's page
    expect(
      between(
        ingestion,
        'private async captureFeedEntry(',
        // P8-C1: the entries' page sources are read together
        'private async pageSources('
      )
    ).toMatch(
      /this\.captureUrl\(\s*organizationId,\s*page\.source,\s*userId,\s*'if-changed'\s*\)/
    );
    expect(
      ingestion.match(/this\.captureUrl\([^)]*'(always|if-changed)'\s*\)/g)
    ).toHaveLength(2);
  });

  it('P804A-10 blocks are compared by type, level and text, never by id', () => {
    const module = change('module');
    expect(module).toMatch(
      /const fingerprint = \(block: ContentStudioSourceBlock\) =>\s*canonicalJson\(\{ type: block\.type, level: block\.level, text: block\.text \}\);/
    );
    expect(module).not.toMatch(/\.id\b/);
  });

  it('P804A-11 the browser names the version only: no baseline, hash or content', () => {
    const api = change('api');
    expect(
      between(api, 'export const sourceVersionChangesPath', ';\n')
    ).toMatch(/`\$\{sourceVersionPath\(id, versionId\)\}\/changes`$/);
    expect(
      between(
        api,
        'export const useContentStudioSourceVersionChanges',
        '\n};\n'
      )
    ).not.toMatch(/method:|body:|before|baseline|hash|\?\w+=/);
    // the browser shows the answer: it does not compare or classify
    expect(change('detail')).not.toMatch(
      /contentHash ===|extractionVersion !==|isSameContentStudioSourceCapture|diffContentStudioSourceBlocks|Uint16Array/
    );
  });

  it('P804A-12 no raw SQL', () => {
    for (const key of [
      'module',
      'service',
      'repository',
      'ingestion',
    ] as const) {
      expect([
        key,
        change(key).match(/\$queryRaw|\$executeRaw|Prisma\.sql/g),
      ]).toEqual([key, null]);
    }
  });
});

// Organization page changes (P8-04B1): four fields on the source, derived
// from its versions by the one transition classifier, kept in the version
// append and rebuilt by an operator command; one read route and a Changes
// tab. Versions stay the record; News Radar does not use the fields yet
const PAGE_CHANGE = {
  ...CHANGE,
  dto: RADAR_BACKEND.dto,
  command: 'apps/commands/src/tasks/content.studio.page.changes.ts',
  commandModule: 'apps/commands/src/command.module.ts',
  changes: `${FRONTEND}/content-studio.page-changes.tsx`,
  changesApi: `${FRONTEND}/content-studio.page-changes.api.ts`,
  tabs: `${FRONTEND}/content-studio.research.tabs.tsx`,
};
const pageChange = (key: keyof typeof PAGE_CHANGE) =>
  CODE.get(PAGE_CHANGE[key]) ?? code(PAGE_CHANGE[key]);
const PAGE_CHANGE_FIELDS = [
  'lastPageChangeAt DateTime?',
  'lastPageChangeVersionNumber Int?',
  'lastPageChangeKind String?',
  'lastPageChangePreviousCaptureAt DateTime?',
];

describe('P8-04B1 organization page changes', () => {
  it('P804B1-1 exactly four new source fields, nullable, without a default', () => {
    const source = fields('ContentStudioSource');
    expect(source.filter((f) => /lastPageChange/.test(f))).toEqual(
      PAGE_CHANGE_FIELDS
    );
    // right after the P8-01 field, nothing else new
    expect(source.slice(10, 15)).toEqual([
      'lastCapturedAt DateTime?',
      ...PAGE_CHANGE_FIELDS,
    ]);
    expect(model('ContentStudioSource')).not.toMatch(
      /lastPageChange\w*\s+\w+\??\s+@/
    );
  });

  it('P804B1-2 exactly one new index: organization and last page change', () => {
    expect(
      model('ContentStudioSource')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('@@'))
    ).toEqual([
      '@@unique([id, organizationId])',
      '@@unique([organizationId, canonicalUrl])',
      '@@index([organizationId, archivedAt])',
      '@@index([organizationId, kind])',
      '@@index([createdById])',
      '@@index([kind, archivedAt, id])',
      '@@index([organizationId, lastPageChangeAt])',
    ]);
  });

  it('P804B1-3/P804B1-16 no foreign key to a version and no change or event model', () => {
    const source = model('ContentStudioSource');
    expect(source.match(/@relation\(/g)).toHaveLength(4);
    expect(source).not.toMatch(/lastPageChange\w*\s+ContentStudio/);
    expect(model('ContentStudioSourceVersion')).not.toMatch(/lastPageChange/);
    expect(schema).not.toMatch(
      /model ContentStudio\w*(Change|Diff|Comparison)\w* \{|model ContentStudioSource\w*Event\w* \{/
    );
    expect(schema).not.toMatch(/enum ContentStudioSource/);
  });

  it('P804B1-4 one transition classifier: the order of the changes is decided once', () => {
    const module = pageChange('module');
    expect(module).toMatch(
      /return previous\.extractionVersion !== next\.extractionVersion\s*\? 'extraction_changed'\s*: previous\.contentHash !== next\.contentHash\s*\? 'content_changed'\s*: 'title_changed';/
    );
    expect(users(/classifyContentStudioSourceCaptureTransition\(/)).toEqual(
      [PAGE_CHANGE.module, PAGE_CHANGE.ingestion, PAGE_CHANGE.service].sort()
    );
    const backend = PRODUCTION.filter(
      (file) =>
        file.startsWith(`${SOURCES}/`) ||
        /content-studio\.source[\w.-]*\.ts$/.test(file)
    );
    for (const pattern of [
      /\.extractionVersion !== \w+\.extractionVersion/,
      /\.contentHash !== \w+\.contentHash/,
      /'title_changed'\s*;/,
    ]) {
      expect(backend.filter((file) => pattern.test(CODE.get(file)!))).toEqual([
        PAGE_CHANGE.module,
      ]);
    }
    expect(module.match(/\.extractionVersion !== /g)).toHaveLength(1);
  });

  it('P804B1-5 the P8-04A comparison takes its class from the classifier', () => {
    const compare = between(
      pageChange('module'),
      'export function compareContentStudioSourceVersions(',
      '\n}\n'
    );
    expect(compare).toMatch(
      /const transition = classifyContentStudioSourceCaptureTransition\(\s*before,\s*after\s*\);/
    );
    expect(compare).toMatch(
      /if \(!before \|\| transition === 'initial' \|\| transition === 'repeat'\) \{\s*return \{\s*change: 'no_earlier_change',/
    );
    expect(compare).toMatch(/change: transition,/);
    expect(compare).not.toMatch(/extractionVersion !==|contentHash !==/);
  });

  it('P804B1-6 a feed capture skips exactly a repeat, by the classifier', () => {
    const ingestion = pageChange('ingestion');
    expect(ingestion.match(/transition === 'repeat'/g)).toHaveLength(1);
    expect(ingestion).not.toMatch(/isSameContentStudioSourceCapture/);
    // both modes read the version the capture follows; a missing one fails
    expect(ingestion).toMatch(
      /const previous =\s*expectedLatestVersionNumber > 0\s*\? await this\._contentStudioSourceRepository\.getVersionByNumber\(\s*organizationId,\s*source\.id,\s*expectedLatestVersionNumber\s*\)\s*: null;\s*if \(expectedLatestVersionNumber > 0 && !previous\) \{\s*throw integrityError\(\);/
    );
  });

  it('P804B1-7 only a content or title change is a page change', async () => {
    const {
      CONTENT_STUDIO_SOURCE_PAGE_CHANGES,
      isContentStudioSourcePageChange,
    } = await import(
      '@gitroom/nestjs-libraries/content-studio/sources/source.change'
    );
    expect([...CONTENT_STUDIO_SOURCE_PAGE_CHANGES]).toEqual([
      'content_changed',
      'title_changed',
    ]);
    for (const value of [
      'initial',
      'repeat',
      'extraction_changed',
      'no_earlier_change',
      'Content_changed',
      '',
      null,
      undefined,
      1,
      '__proto__',
    ]) {
      expect([value, isContentStudioSourcePageChange(value)]).toEqual([
        value,
        false,
      ]);
    }
    const ingestion = pageChange('ingestion');
    expect(ingestion).toMatch(
      /const pageChange =\s*previous && isContentStudioSourcePageChange\(transition\)\s*\? \{\s*at: version\.fetchedAt,\s*versionNumber: expectedLatestVersionNumber \+ 1,\s*kind: transition,\s*previousCaptureAt: previous\.fetchedAt,\s*\}\s*: null;/
    );
    const backfill = between(
      pageChange('service'),
      'private async lastPageChange(',
      'private async getRow('
    );
    expect(backfill).toMatch(
      /if \(previous && isContentStudioSourcePageChange\(transition\)\) \{\s*pageChange = \{\s*at: version\.fetchedAt,\s*versionNumber: version\.versionNumber,\s*kind: transition,\s*previousCaptureAt: previous\.fetchedAt,\s*\};/
    );
  });

  it('P804B1-8 the append writes the page change in the one source update, with the version number', () => {
    const append = between(
      pageChange('repository'),
      'appendVersionWithCompareAndSwap(input: {',
      '\n  }\n'
    );
    expect(append.match(/contentStudioSource\.updateMany\(/g)).toHaveLength(1);
    expect(append).not.toMatch(
      /contentStudioSource\.update\(|\$transaction[\s\S]*\$transaction/
    );
    expect(append).toMatch(
      /data: \{\s*latestVersionNumber: \{\s*increment: 1,\s*\},\s*\.\.\.\(input\.pageChange \? pageChangeData\(input\.pageChange\) : \{\}\),\s*\},\s*\}\);\s*if \(count !== 1\) \{\s*return \{ status: 'changed' as const \};\s*\}\s*const version = await tx\.contentStudioSourceVersion\.create\(/
    );
    // pageChange reaches the append from the ingestion only
    expect(pageChange('ingestion').match(/pageChange,\n/g) ?? []).toHaveLength(
      1
    );
  });

  it('P804B1-9 no block diff or content check while capturing', () => {
    expect(pageChange('ingestion')).not.toMatch(
      /diffContentStudioSourceBlocks|compareContentStudioSourceVersions|Uint16Array|parseVerifiedContentStudioSourceVersion|getVersionForSource|getVersionDetailByNumber/
    );
  });

  it('P804B1-10 the backfill reads no content, no fetched-bytes hash and no blocks', () => {
    const repository = pageChange('repository');
    const versions = between(
      repository,
      'listVersionCapturesForBackfill(input: {',
      '\n  }\n'
    );
    const select = between(versions, 'select: {', '}');
    expect(
      select
        .replace('select: {', '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    ).toEqual([
      'versionNumber: true',
      'contentHash: true',
      'title: true',
      'extractionVersion: true',
      'fetchedAt: true',
    ]);
    expect(versions).toMatch(/orderBy: \{\s*versionNumber: 'asc',\s*\}/);
    const service = between(
      pageChange('service'),
      'async backfillPageChanges(',
      'async getVersionChanges('
    );
    expect(service).not.toMatch(
      /content:|\.content\b|sourceHash|intactContent|parseVerified|VERSION_DETAIL|getVersionForSource/
    );
  });

  it('P804B1-11/P804B1-12 the backfill keeps updatedAt and writes only a source exactly as it was read', () => {
    const write = between(
      pageChange('repository'),
      'setPageChangeWithCompareAndSwap(input: {',
      '\n  }\n'
    );
    expect(write).toMatch(
      /where: \{\s*id: input\.sourceId,\s*organizationId: input\.organizationId,\s*kind: 'url',\s*latestVersionNumber: input\.expectedLatestVersionNumber,\s*updatedAt: input\.expectedUpdatedAt,\s*\},\s*data: \{\s*\.\.\.pageChangeData\(input\.pageChange\),\s*updatedAt: input\.expectedUpdatedAt,\s*\},/
    );
    expect(users(/setPageChangeWithCompareAndSwap\(/)).toEqual([
      PAGE_CHANGE.repository,
      PAGE_CHANGE.service,
    ]);
    const service = pageChange('service');
    expect(service).toMatch(/const BACKFILL_ATTEMPTS = 3;/);
    expect(service).toMatch(/const BACKFILL_PAGE_SIZE = 100;/);
    expect(service).toMatch(/const BACKFILL_VERSIONS_PAGE_SIZE = 1000;/);
  });

  it('P804B1-13 the Changes route only reads', () => {
    const controller = pageChange('controller');
    const handler = between(controller, "@Get('/source-changes')", '\n  }\n');
    expect(handler).toMatch(
      /listPageChanges\(\{\s*organizationId: org\.id,\s*page: query\.page,\s*since: query\.since,\s*\}\)/
    );
    const method = between(
      pageChange('service'),
      'async listPageChanges(',
      'async backfillPageChanges('
    );
    const repository = pageChange('repository');
    for (const part of [
      handler,
      method,
      between(repository, 'listPageChangesForOrganization(', '\n  }\n'),
      between(repository, 'countPageChangesForOrganization(', '\n  }\n'),
      between(repository, 'getVersionsByNumbersForOrganization(', '\n  }\n'),
    ]) {
      expect(part).not.toMatch(
        /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$transaction|appendVersion|setPageChange|backfill|refresh|capture\(|safeFetch|fetch\(/i
      );
    }
    expect(controller).not.toMatch(/backfill/i);
  });

  it('P804B1-14 News Radar uses the page change only for its Changed signal (P8-04B2)', () => {
    for (const file of [
      `${FRONTEND}/content-studio.source.picker.tsx`,
      `${FRONTEND}/content-studio.package.modal.tsx`,
    ]) {
      expect([
        file,
        CODE.get(file)!.match(
          /lastPageChange|pageChange|page-changes|source-changes|changedSinceFound|Changed since/gi
        ),
      ]).toEqual([file, null]);
    }
    // the Radar reads two of the four fields (pinned by P804B2-3) and never
    // the Changes list
    for (const file of [...RADAR_FRONTEND, RADAR_BACKEND.repository]) {
      expect([
        file,
        CODE.get(file)!.match(
          /lastPageChange(VersionNumber|Kind)|page-changes|source-changes|Changed since/gi
        ),
      ]).toEqual([file, null]);
    }
    const { method } = radarCode();
    expect(method).not.toMatch(/lastPageChange|pageChange/);
    // the Research page shows the Radar as it was, beside Changes
    expect(pageChange('tabs')).toMatch(
      /tab === 'changes' \? \(?\s*<ContentStudioPageChanges \/>\s*\)? : \(?\s*<ContentStudioResearch \/>\s*\)?/
    );
  });

  it('P804B1-15 no AI, ranking or importance', () => {
    for (const key of [
      'module',
      'changes',
      'changesApi',
      'tabs',
      'command',
    ] as const) {
      expect([
        key,
        pageChange(key).match(
          /ai-connection|ai-operation|ai-writing|AIConnection|AIOperation|AIUsage|openai|anthropic|embedding|vector|\bscore|relevan|importan|severity|ranking|summar/gi
        ),
      ]).toEqual([key, null]);
    }
    const methods = [
      between(
        pageChange('service'),
        'async listPageChanges(',
        'async getVersionChanges('
      ),
      between(
        pageChange('service'),
        'private async backfillPageChange(',
        'private async getRow('
      ),
    ];
    for (const part of methods) {
      expect(part).not.toMatch(/AI|openai|anthropic|score|relevan|importan/);
    }
  });

  it('P804B1-17 one new read route, 145 in all', () => {
    const controller = pageChange('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(145);
    expect(controller.match(/'\/source-changes'/g)).toEqual([
      "'/source-changes'",
    ]);
    expect(controller).not.toMatch(
      /@(Post|Put|Patch|Delete)\('\/source-changes|\/backfill|\/page-changes/
    );
  });

  it('P804B1-18 the backfill runs from its operator command only: never on start, deploy, schedule or request', () => {
    expect(users(/backfillPageChanges\(/)).toEqual([PAGE_CHANGE.service]);
    expect(users(/backfill-page-changes/)).toEqual([]);
    const command = pageChange('command');
    expect(command).toMatch(/command: 'content-studio:backfill-page-changes',/);
    expect(command.match(/backfillPageChanges\(/g)).toHaveLength(1);
    expect(command).toMatch(/process\.exitCode = 1;/);
    expect(command).not.toMatch(
      /process\.exit\(|onModuleInit|OnApplicationBootstrap|setInterval|cron/i
    );
    // nor does the service start it: no lifecycle hook
    for (const key of ['service', 'repository', 'ingestion'] as const) {
      expect([
        key,
        pageChange(key).match(
          /onModuleInit|onApplicationBootstrap|OnModuleInit|OnApplicationBootstrap/g
        ),
      ]).toEqual([key, null]);
    }
    expect(pageChange('commandModule')).toMatch(
      /providers: \[\s*RefreshTokens,\s*ConfigurationTask,\s*ContentStudioPageChangesBackfill,\s*\]/
    );
    const packageJson = raw('package.json');
    expect(packageJson).not.toMatch(/backfill/i);
    for (const file of PRODUCTION.filter((file) =>
      file.startsWith('apps/orchestrator/')
    )) {
      expect([file, /backfill|PageChange/.test(CODE.get(file)!)]).toEqual([
        file,
        false,
      ]);
    }
  });
});

// The operator command runtime (P8-04B1-R1): apps/commands builds with the
// image, starts with Temporal provided the way the backend provides it, and
// offers the backfill to an operator only. Its start is covered by
// apps/commands/src/command.module.spec.ts and the PostgreSQL command suite
const COMMANDS = {
  module: 'apps/commands/src/command.module.ts',
  main: 'apps/commands/src/main.ts',
  packageJson: 'apps/commands/package.json',
};

describe('P8-04B1-R1 the command runtime', () => {
  it('R1-1 the commands package starts the file nest build emits, under apps/commands', () => {
    const scripts = JSON.parse(raw(COMMANDS.packageJson)).scripts;
    expect(scripts).toEqual({
      dev: 'dotenv -e ../../.env -- nest start --watch --entryFile=./apps/commands/src/main',
      build: 'cross-env NODE_ENV=production nest build',
      start: 'node ./dist/apps/commands/src/main.js',
    });
    expect(raw(COMMANDS.packageJson)).not.toMatch(/apps\/command\//);
    // nest build writes the app under dist/ by its path from the repository
    expect(
      JSON.parse(raw('apps/commands/tsconfig.build.json')).compilerOptions
        .outDir
    ).toBe('./dist');
  });

  it('R1-2 CommandModule takes Temporal from the shared module, as the backend does: no workers, no stand-in', () => {
    const commandModule = code(COMMANDS.module);
    expect(commandModule).toMatch(
      /import \{ getTemporalModule \} from '@gitroom\/nestjs-libraries\/temporal\/temporal\.module';/
    );
    expect(commandModule).toMatch(
      /imports: \[ExternalCommandModule, DatabaseModule, getTemporalModule\(false\)\]/
    );
    expect(commandModule.match(/getTemporalModule\(/g)).toHaveLength(1);
    expect(commandModule).not.toMatch(
      /TemporalService|TemporalModule\.|provide:|useValue|useFactory|InfiniteWorkflowRegister|TemporalRegisterMissingSearchAttributes/
    );
    expect(code('apps/backend/src/app.module.ts')).toMatch(
      /getTemporalModule\(false\)/
    );
  });

  it('R1-3 the run:agent command is gone, and with it the call to a method that never existed', () => {
    expect(
      fs.existsSync(
        path.join(REPO_ROOT, 'apps/commands/src/tasks/agent.run.ts')
      )
    ).toBe(false);
    const commands = walk(path.join(REPO_ROOT, 'apps/commands/src')).map(
      (file) => code(path.relative(REPO_ROOT, file))
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const source of commands) {
      expect(source).not.toMatch(/AgentRun|run:agent|createGraph|AgentModule/);
    }
    expect(users(/createGraph\(/)).toEqual([]);
  });

  it('R1-4 the image builds the commands app from source with the other apps', () => {
    const scripts = JSON.parse(raw('package.json')).scripts;
    expect(scripts.build).toBe(
      'pnpm -r --workspace-concurrency=1 --filter ./apps/frontend --filter ./apps/backend --filter ./apps/orchestrator --filter ./apps/commands run build'
    );
    const dockerfile = raw('Dockerfile.dev');
    expect(dockerfile).toMatch(/\nCOPY \. \/app\n/);
    expect(dockerfile).toMatch(
      /\nRUN NODE_OPTIONS="--max-old-space-size=4096" pnpm run build\n/
    );
    expect(dockerfile.indexOf('COPY . /app')).toBeLessThan(
      dockerfile.indexOf('pnpm run build')
    );
    // never the host's build output
    expect(dockerfile).not.toMatch(/commands\/dist/);
    expect(raw('.dockerignore').split('\n')).toContain('/apps/commands/dist');
  });

  it('R1-5 nothing starts a command: not the image, pm2, the schema push or the orchestrator', () => {
    const scripts = JSON.parse(raw('package.json')).scripts;
    for (const name of [
      'pm2',
      'pm2-run',
      'prisma-db-push',
      'prisma-db-push-on-start',
      'start:prod:backend',
      'start:prod:orchestrator',
      'start:prod:frontend',
    ]) {
      expect([name, /commands|backfill/.test(scripts[name])]).toEqual([
        name,
        false,
      ]);
    }
    expect(JSON.parse(raw(COMMANDS.packageJson)).scripts.pm2).toBeUndefined();
    expect(raw('Dockerfile.dev')).toMatch(
      /\nCMD \["sh", "-c", "nginx && pnpm run pm2"\]\n?$/
    );
    expect(raw('Dockerfile.dev')).not.toMatch(/backfill|apps\/commands/);
    for (const file of PRODUCTION.filter((file) =>
      file.startsWith('apps/orchestrator/')
    )) {
      expect([
        file,
        /apps\/commands|command\.module|backfill-page-changes/.test(
          CODE.get(file)!
        ),
      ]).toEqual([file, false]);
    }
    // main runs what the operator typed, then closes
    expect(code(COMMANDS.main)).toMatch(
      /await app\.select\(CommandModule\)\.get\(CommandService\)\.exec\(\);\s*await app\.close\(\);/
    );
  });

  it('R1-6 the News Radar change signal is the P8-04B2 one: decided on the read, not in the Radar query', () => {
    const radar = radarCode();
    for (const part of ['method', 'repository', 'handler'] as const) {
      expect([
        part,
        radar[part].match(/lastPageChange|changedSinceFound/g),
      ]).toEqual([part, null]);
    }
    expect(users(/changedSinceFound/)).toEqual(B2_CHANGED_USERS);
  });
});

// News Radar change signals (P8-04B2): whether a found page changed after
// the feed found it, decided by the server on the read, from two of the
// source's P8-04B1 fields, for each discovery. No schema, route, filter, event
// or AI. The behavior is covered by content-studio.news-radar.spec.ts, the
// frontend specs and the PostgreSQL suite; these keep the decisions from
// drifting
const B2 = {
  service: RADAR_BACKEND.service,
  repository: RADAR_BACKEND.repository,
  dto: RADAR_BACKEND.dto,
  row: `${FRONTEND}/content-studio.discovery.row.tsx`,
  api: `${FRONTEND}/content-studio.sources.api.ts`,
  research: `${FRONTEND}/content-studio.research.tsx`,
  researchApi: `${FRONTEND}/content-studio.research.api.ts`,
  detail: `${FRONTEND}/content-studio.source.detail.tsx`,
};
const B2_CHANGED_USERS = [B2.row, B2.api, B2.service].sort();
const b2 = (key: keyof typeof B2) => CODE.get(B2[key])!;
const b2Rule = () =>
  between(
    b2('service'),
    'export const isContentStudioDiscoveryChangedSinceFound = (',
    '\n\n'
  );
const b2Mapper = () =>
  between(b2('service'), 'private toPublicDiscovery(', '\n  }\n');

describe('P8-04B2 News Radar change signals', () => {
  it('P804B2-1 no schema change: no discovery change field, table or enum', () => {
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '0c0638c523fe2e1439b81130c7e05f9eacdc12465ffac41f5be04b9d377af6e5'
    );
    expect(model('ContentStudioSourceDiscovery')).not.toMatch(/change/i);
    expect(schema).not.toMatch(/changedSinceFound/);
  });

  it('P804B2-2 no new route: 145 in all', () => {
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(145);
    expect(controller).not.toMatch(/changedSinceFound|radar-changes|\/changed/);
  });

  it('P804B2-3 a discovery reads exactly two of the page-change fields, with its page, in the one listing select', () => {
    const summary = between(
      b2('repository'),
      'const DISCOVERY_SUMMARY = {',
      '} as const;'
    );
    expect(summary).toMatch(
      /discoveredSource: \{\s*select: \{\s*id: true,\s*organizationId: true,\s*kind: true,\s*name: true,\s*canonicalUrl: true,\s*latestVersionNumber: true,\s*archivedAt: true,\s*lastPageChangeAt: true,\s*lastPageChangePreviousCaptureAt: true,\s*\},\s*\},\s*\}?$/
    );
    expect(b2('repository').match(/lastPageChange\w*/g)).toEqual([
      'lastPageChangeAt',
      'lastPageChangePreviousCaptureAt',
    ]);
    expect(b2('repository')).not.toMatch(
      /lastPageChangeVersionNumber|lastPageChangeKind|content:|Hash|blocks/
    );
    // the Radar select is the listing select with the feed
    expect(b2('repository')).toMatch(
      /const RADAR_DISCOVERY_SUMMARY = \{\s*\.\.\.DISCOVERY_SUMMARY,\s*feedSource:/
    );
  });

  it('P804B2-4/P804B2-12 changedSinceFound is decided by the server in the one discovery mapper both lists use', () => {
    expect(users(/changedSinceFound/)).toEqual(B2_CHANGED_USERS);
    expect(users(/isContentStudioDiscoveryChangedSinceFound/)).toEqual([
      B2.service,
    ]);
    expect(
      b2('service').match(/isContentStudioDiscoveryChangedSinceFound\(/g)
    ).toHaveLength(1);
    expect(b2Mapper()).toMatch(
      /changedSinceFound: isContentStudioDiscoveryChangedSinceFound\(\{\s*firstSeenAt: row\.firstSeenAt,\s*lastPageChangeAt: page\.lastPageChangeAt,\s*lastPageChangePreviousCaptureAt: page\.lastPageChangePreviousCaptureAt,\s*\}\),/
    );
    // the feed page and News Radar map their rows with it, and show them with
    // the one row
    expect(b2('service').match(/this\.toPublicDiscovery\(/g)).toHaveLength(2);
    expect(users(/<ContentStudioDiscoveryRow\b/)).toEqual(
      [B2.research, B2.detail].sort()
    );
    expect(users(/content_studio_discovery_changed/)).toEqual([B2.row]);
  });

  it('P804B2-5 the rule is the previous capture at or after the first sighting, never the change time', () => {
    expect(b2Rule()).toMatch(
      /=>\s*input\.lastPageChangeAt !== null &&\s*input\.lastPageChangePreviousCaptureAt !== null &&\s*input\.lastPageChangePreviousCaptureAt\.getTime\(\) >=\s*input\.firstSeenAt\.getTime\(\);$/
    );
    expect(b2Rule()).not.toMatch(
      /lastPageChangeAt\.getTime|lastPageChangeAt\s*[<>]/
    );
    expect(b2Rule().match(/>=|<=|>(?!=)|<(?!=)/g)).toEqual(['>', '>=']);
  });

  it('P804B2-6 the browser compares no dates: it shows the server answer', () => {
    expect(
      users(/lastPageChangePreviousCaptureAt/).filter((file) =>
        file.startsWith('apps/frontend/')
      )
    ).toEqual([]);
    const row = b2('row');
    expect(row).not.toMatch(
      /new Date|getTime|Date\.parse|Date\.now|>=|<=|firstSeenAt\s*[<>]|dayjs\(|isAfter|isBefore/
    );
    // the date is shown only with the answer
    expect(row).toMatch(
      /\{discovery\.changedSinceFound && discovery\.source\.lastPageChangeAt && \(/
    );
    expect(row).toMatch(
      /\{discovery\.changedSinceFound && \(\s*<Badge>\{t\('content_studio_discovery_changed', 'Changed'\)\}<\/Badge>/
    );
    expect(row).not.toMatch(/'New'|_new'|Updated|Important|Significant/);
  });

  it('P804B2-7 no changed-only filter in the Radar, its query or its address', () => {
    const { repository, handler, frontend } = radarCode();
    const dto = between(
      b2('dto'),
      'export class ListContentStudioDiscoveriesDto',
      'export class ListContentStudioSourceChangesDto'
    );
    for (const part of [repository, handler, dto, b2('researchApi')]) {
      expect(part).not.toMatch(/changed|onlyChanged|lastPageChange/i);
    }
    expect(frontend).not.toMatch(/onlyChanged|changed=|change=changed/);
  });

  it('P804B2-8 no change event model', () => {
    expect(schema).not.toMatch(/model \w*(Change|Discovery)\w*Event\w* \{/);
    expect(users(/contentStudioSourceChangeEvent|SourceChangeEvent/)).toEqual(
      []
    );
  });

  it('P804B2-9 no AI, ranking or importance in the signal', () => {
    for (const part of [b2Rule(), b2Mapper(), b2('row')]) {
      expect(part).not.toMatch(
        /AIConnection|AIOperation|AIUsage|ai-writing|openai|anthropic|embedding|\bscore|relevan|importan|severity|ranking|summar|topic|trend/i
      );
    }
  });

  it('P804B2-10/P804B2-11 the signal adds no query: no source or version lookup on the read', () => {
    const mapper = b2Mapper();
    expect(mapper).not.toMatch(
      /this\._|await|async|getVersion|contentStudioSourceVersion|versions/
    );
    const { method } = radarCode();
    const feed = between(
      b2('service'),
      'async listDiscoveries(',
      'async listOrganizationDiscoveries('
    );
    for (const part of [method, feed]) {
      expect(part).not.toMatch(
        /getVersions|VersionsByNumbers|getVersion\(|contentStudioSourceVersion|lastPageChange/
      );
      // the list, its count, and the one feed lookup of before
      expect(
        part.match(/this\._contentStudioSource\w*Repository\.\w+\(/g)
      ).toHaveLength(2);
      expect(part.match(/this\.getRow\(/g)).toHaveLength(1);
    }
  });
});

describe('P8-C1 organization safety caps', () => {
  const CAPS = {
    types: `${SOURCES}/source.types.ts`,
    ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
    repository:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    service:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
    controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
    api: 'apps/frontend/src/components/content-studio/content-studio.sources.api.ts',
    ui: 'apps/frontend/src/components/content-studio/content-studio.sources.tsx',
  };
  const caps = (key: keyof typeof CAPS) => CODE.get(CAPS[key])!;
  const repositoryMethod = (name: string) =>
    between(caps('repository'), `\n  ${name}(`, '\n  }\n');
  const backend = [
    CAPS.types,
    CAPS.ingestion,
    CAPS.repository,
    CAPS.service,
  ] as const;

  it('P8C1-1 no schema change: no limit, counter, pause or interval field or model', () => {
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '0c0638c523fe2e1439b81130c7e05f9eacdc12465ffac41f5be04b9d377af6e5'
    );
    expect(model('ContentStudioSource')).not.toMatch(
      /limit|quota|usage|paused|interval|nextCapture/i
    );
    expect(schema).not.toMatch(
      /model ContentStudio\w*(Limit|Quota|Counter|Slot|Cap)\w* \{/
    );
  });

  it('P8C1-2 no new route, no usage or limit route: 145 in all', () => {
    const controller = caps('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(145);
    expect(controller).not.toMatch(
      /\/limits|\/usage|\/quota|activeFeedsMax|urlSourcesMax|manualRefreshCooldownMs|contentStudioSourceLimits/
    );
  });

  it('P8C1-3/P8C1-4/P8C1-5/P8C1-14 nothing deletes a source, a version or a discovery; no retention', () => {
    expect(
      users(/contentStudioSource(Version|Discovery)?\.(delete|deleteMany)\(/)
    ).toEqual([]);
    const contentStudio = PRODUCTION.filter((file) =>
      /content-studio|content\.studio/.test(file)
    );
    expect(
      contentStudio.filter((file) =>
        /retention|purge|keepLast|prune|cleanup/i.test(CODE.get(file)!)
      )
    ).toEqual([]);
  });

  it('P8C1-6/P8C1-12 technical limits only: no pricing, billing, permission or environment in them', () => {
    for (const file of backend) {
      expect([file, CODE.get(file)!.match(/process\.env/g)]).toEqual([
        file,
        null,
      ]);
      expect([
        file,
        CODE.get(file)!.match(
          /pricing|stripe|subscription|billing|PermissionsService|AuthorizationActions|\bplan\b|upgrade/gi
        ),
      ]).toEqual([file, null]);
    }
    expect(
      users(/process\.env\.\w*(FEED|SOURCE)\w*(LIMIT|MAX|COOLDOWN)/)
    ).toEqual([]);
  });

  it('P8C1-7 the limits are three constants, defined once, read through one resolver', () => {
    const types = caps('types');
    expect(types).toContain(
      'export const CONTENT_STUDIO_ACTIVE_FEEDS_MAX = 100;'
    );
    expect(types).toContain(
      'export const CONTENT_STUDIO_URL_SOURCES_MAX = 100_000;'
    );
    expect(types).toContain(
      'export const CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;'
    );
    for (const name of [
      'CONTENT_STUDIO_ACTIVE_FEEDS_MAX',
      'CONTENT_STUDIO_URL_SOURCES_MAX',
      'CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS',
    ]) {
      // defined and read in the resolver only
      expect(users(new RegExp(`\\b${name}\\b`))).toEqual([CAPS.types]);
    }
    expect(users(/contentStudioSourceLimits = \(/)).toEqual([CAPS.types]);
    expect(users(/contentStudioSourceLimits\(/)).toEqual(
      [CAPS.ingestion, CAPS.service].sort()
    );
  });

  it('P8C1-8 every source is created by the one limited create, inside its serializable transaction', () => {
    expect(users(/contentStudioSource\.(create|createMany|upsert)\(/)).toEqual([
      CAPS.repository,
    ]);
    const repository = caps('repository');
    expect(repository.match(/contentStudioSource\.create\(/g)).toEqual([
      'contentStudioSource.create(',
    ]);
    const create = repositoryMethod('createSourcesWithinLimit');
    expect(create).toContain(
      'return this.withinLimitTransaction(async (tx) =>'
    );
    expect(create).toContain('tx.contentStudioSource.create(');
    // the URLs first, then the count, then the creates
    expect(create.indexOf('canonicalUrl: {')).toBeLessThan(
      create.indexOf('.count(')
    );
    expect(create.indexOf('.count(')).toBeLessThan(create.indexOf('.create('));
    expect(create).toMatch(/if \(found\) \{[\s\S]*?if \(room <= 0\) \{/);
    expect(repository).not.toMatch(/\n  createSource\(/);
    expect(users(/\.createSourcesWithinLimit\(/)).toEqual(
      [CAPS.ingestion, CAPS.service].sort()
    );
    expect(users(/\.restoreSourceWithinLimit\(/)).toEqual([CAPS.service]);
  });

  it('P8C1-9/P8C1-10 a feed limit counts live feeds, a page limit every page of the organization', () => {
    const repository = caps('repository');
    expect(repository).toMatch(
      /const limitedSourcesWhere = \(\s*organizationId: string,\s*kind: string\s*\): Prisma\.ContentStudioSourceWhereInput =>\s*kind === 'feed'\s*\? \{ organizationId, kind, archivedAt: null \}\s*: \{ organizationId, kind \};/
    );
    expect(repositoryMethod('createSourcesWithinLimit')).toContain(
      'where: limitedSourcesWhere(input.organizationId, input.kind)'
    );
    const restore = repositoryMethod('restoreSourceWithinLimit');
    expect(restore).toMatch(
      /source\.kind === 'feed' &&\s*\(await tx\.contentStudioSource\.count\(\{\s*where: limitedSourcesWhere\(input\.organizationId, 'feed'\),/
    );
    expect(
      repository.match(/\.count\(\{\s*where: limitedSourcesWhere/g)
    ).toHaveLength(2);
    // the service picks the limit of the kind, from the request organization
    expect(caps('service')).toMatch(
      /limit:\s*input\.kind === 'feed'\s*\? limits\.activeFeedsMax\s*: limits\.urlSourcesMax/
    );
    expect(caps('service')).toContain(
      'contentStudioSourceLimits(input.organizationId)'
    );
    expect(caps('ingestion')).toContain(
      'limit: contentStudioSourceLimits(organizationId).urlSourcesMax'
    );
  });

  it('P8C1-11 serializable, a bounded retry of P2034 only, no sleep and no raw SQL', () => {
    const repository = caps('repository');
    expect(repository).toContain('const LIMIT_TRANSACTION_ATTEMPTS = 3;');
    expect(repository.match(/isolationLevel:/g)).toHaveLength(1);
    const run = between(
      repository,
      'private async withinLimitTransaction<T>(',
      '\n  }\n'
    );
    expect(run).toMatch(
      /for \(let attempt = 1; attempt <= LIMIT_TRANSACTION_ATTEMPTS; attempt\+\+\)/
    );
    expect(run).toContain(
      'isolationLevel: Prisma.TransactionIsolationLevel.Serializable'
    );
    expect(run).toMatch(
      /if \(!isSerializationFailure\(err\)\) \{\s*throw err;/
    );
    expect(run).toContain("return { status: 'conflict' as const };");
    expect(repository).toMatch(
      /const isSerializationFailure = \(err: unknown\) =>\s*err instanceof Prisma\.PrismaClientKnownRequestError && err\.code === 'P2034';/
    );
    for (const file of backend) {
      expect([
        file,
        CODE.get(file)!.match(
          /\$queryRaw|\$executeRaw|Prisma\.sql|pg_advisory|FOR UPDATE|setTimeout|sleep\(/g
        ),
      ]).toEqual([file, null]);
    }
    expect(
      users(/isolationLevel|TransactionIsolationLevel/).filter((file) =>
        /content-studio/.test(file)
      )
    ).toEqual([CAPS.repository]);
  });

  it('P8C1-13 no Temporal change: the feed workflow, its activity and the worker are as they were', () => {
    const hash = (file: string) =>
      createHash('sha256').update(raw(file)).digest('hex');
    expect({
      workflow: hash(
        'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts'
      ),
      activity: hash(
        'apps/orchestrator/src/activities/content-studio.source.activity.ts'
      ),
      worker: hash(
        'libraries/nestjs-libraries/src/temporal/temporal.module.ts'
      ),
    }).toEqual({
      workflow:
        '67962393430dc765ee4e5da47074dd85f9f8114e3da1876d37ee0bf19ae2163b',
      activity:
        '1806d5912e2ab2dacfbeddd83773be96c9cb8b24932a173d409d964f9f6afc3b',
      worker:
        '9f71b835542268f7bbb38595203b119ddea2f1fda4aa6e8de1d0fa6909ff4327',
    });
    expect(caps('ingestion')).toContain(
      'export const FEED_CAPTURE_CONCURRENCY = 5;'
    );
  });

  it('P8C1-15 a new page past the limit is its own outcome: never failed, not recorded, not fetched', () => {
    const ingestion = caps('ingestion');
    expect(ingestion).toMatch(/default:\s*return 'limited';/);
    expect(ingestion).toMatch(
      /if \(result\.status === 'conflict'\) \{\s*return entries\.map\(\(\) => 'failed' as const\);/
    );
    expect(ingestion).toContain("entriesLimited: count('limited'),");
    expect(ingestion).toContain("failed: count('failed'),");
    expect(ingestion).toContain(
      "entriesAccepted: outcomes.length - count('skipped') - count('limited'),"
    );
    const entry = between(
      ingestion,
      'private async captureFeedEntry(',
      'private async pageSources('
    );
    // no source, so no discovery and no capture
    expect(entry.indexOf("typeof page === 'string'")).toBeLessThan(
      entry.indexOf('recordDiscovery(')
    );
    expect(entry.indexOf('recordDiscovery(')).toBeLessThan(
      entry.indexOf('this.captureUrl(')
    );
    // the feed capture records what it did whatever the limits
    const feed = between(
      ingestion,
      'private async captureFeed(',
      'private async captureFeedEntry('
    );
    expect(feed).toContain('markFeedCaptured(');
    expect(feed).not.toMatch(/if \([^)]*limit/i);
    expect(feed).not.toMatch(/throw[^;]*limit/i);
  });

  it('P8C1-16 the refresh cooldown is a member refresh only, after the archive check and before any fetch', () => {
    const ingestion = caps('ingestion');
    expect(ingestion.match(/assertRefreshDue\(/g)).toHaveLength(2);
    const refresh = between(
      ingestion,
      'async refreshSource(',
      'async listFeedsDueForCapture('
    );
    expect(refresh.match(/assertRefreshDue\(/g)).toHaveLength(2);
    expect(refresh.indexOf('throw sourceArchived()')).toBeLessThan(
      refresh.indexOf('assertRefreshDue(')
    );
    expect(refresh).toMatch(
      /assertRefreshDue\(source\.lastCapturedAt, manualRefreshCooldownMs\);\s*return this\.captureFeed\(/
    );
    expect(
      refresh.lastIndexOf('assertRefreshDue(latest.fetchedAt')
    ).toBeLessThan(refresh.indexOf('this.captureUrl('));
    expect(ingestion).toMatch(
      /Date\.now\(\) - lastCaptureAt\.getTime\(\) < cooldownMs/
    );
    const scheduled = between(
      ingestion,
      'async captureScheduledFeed(',
      'private async captureUrl('
    );
    expect(scheduled).not.toMatch(/assertRefreshDue|Cooldown/);
  });

  it('P8C1-17 the read routes count nothing new', () => {
    const service = caps('service');
    for (const [start, end] of [
      ['async listSources(', 'async createSource('],
      ['async listDiscoveries(', 'async listOrganizationDiscoveries('],
      ['async listOrganizationDiscoveries(', 'private toPublicDiscovery('],
      ['async listPageChanges(', 'async getVersionChanges('],
    ]) {
      expect(between(service, start, end)).not.toMatch(
        /contentStudioSourceLimits|WithinLimit|limit/i
      );
    }
  });

  it('P8C1-18 the browser maps the codes to fixed words, with no number and no commercial wording', () => {
    const api = caps('api');
    for (const code of [
      'CS_SOURCE_FEED_LIMIT',
      'CS_SOURCE_LIMIT',
      'CS_SOURCE_REFRESH_TOO_SOON',
      'CS_SOURCE_CONFLICT',
    ]) {
      expect(api).toContain(`case '${code}':`);
    }
    const translation = JSON.parse(
      raw(
        'libraries/react-shared-libraries/src/translation/locales/en/translation.json'
      )
    ) as Record<string, string>;
    for (const key of [
      'content_studio_source_error_feed_limit',
      'content_studio_source_error_source_limit',
      'content_studio_source_error_refresh_too_soon',
      'content_studio_source_error_sources_changed',
      'content_studio_feed_captured_limited',
    ]) {
      expect(translation[key]).toEqual(expect.any(String));
      expect(translation[key]).not.toMatch(
        /\d|upgrade|plan|billing|subscription|pay/i
      );
    }
    expect(caps('ui')).toMatch(/\.\.\.\(capture\.entriesLimited\s*\?/);
    // no usage endpoint and no limit numbers in the browser
    expect(
      PRODUCTION.filter(
        (file) =>
          file.startsWith('apps/frontend/') &&
          /\/limits|\/usage|ACTIVE_FEEDS_MAX|URL_SOURCES_MAX|REFRESH_COOLDOWN/.test(
            CODE.get(file)!
          )
      )
    ).toEqual([]);
  });
});
