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
    expect(ingestion.match(/createSource\(/g)).toHaveLength(1);
    expect(ingestion).toMatch(
      /createSource\(\{\s*id: randomUUID\(\),\s*organizationId,\s*kind: 'url',/
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
    ).toHaveLength(144);
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

  it('P802-5 schema.prisma is byte-identical to its P8-01 version', () => {
    // P8-02 changes no schema; a later phase that does updates this pin
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '1889855c5215d44c33e67f86ac01ccb9a90cbff40699a74bf7607d2f62ea8d6e'
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

  it('P802-9 one new read route, GET /discoveries (143; 144 with P8-04A)', () => {
    const controller = CODE.get(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    )!;
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(144);
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
    // the P8-01 schema, byte for byte (P802-5 pins the same hash)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '1889855c5215d44c33e67f86ac01ccb9a90cbff40699a74bf7607d2f62ea8d6e'
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
    ).toHaveLength(144);
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
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '1889855c5215d44c33e67f86ac01ccb9a90cbff40699a74bf7607d2f62ea8d6e'
    );
    expect(schema).not.toMatch(/model \w*(Change|Diff|Comparison)\w* \{/);
    expect(schema).not.toMatch(
      /\b(lastContentChangedAt|lastChangedAt|contentChangedAt|previousHash|previousVersionId|changeKind|changeClass|isDuplicate|repeatOf|sameCapture)\b/i
    );
  });

  it('P804A-2/P804A-3 one new read route, 144 in all; it reads only', () => {
    const controller = change('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(144);
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
    expect(ingestion).toMatch(
      /if \(isSameContentStudioSourceCapture\(current, version\)\) \{\s*return \{ status: 'unchanged' as const \};/
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
    expect(ingestion).toMatch(
      /if \(mode === 'if-changed' && expectedLatestVersionNumber > 0\) \{/
    );
    // the one caller with if-changed is a feed's page
    expect(
      between(
        ingestion,
        'private async captureFeedEntry(',
        'private async pageSource('
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
