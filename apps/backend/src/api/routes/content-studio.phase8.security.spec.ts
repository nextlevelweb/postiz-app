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
import {
  CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
  CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
  CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

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
// The feed pause (P8-C3) and schedule (P8-C4) fields of a source, as lines
// of its model, for the pins of the phases before them
const SCHEDULE_FIELDS =
  /\n\s*(scanPausedAt|captureIntervalMinutes|nextCaptureAt|consecutiveCaptureFailures)\s+(DateTime|Int)\??[^\n]*/g;
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
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
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
    // P8-C3 adds the feed pause time, nothing this forbids (P8C3-1)
    // P8-C4 adds a feed's schedule, nothing this forbids (P8C4-1)
    // P8-O1 adds the capture history model, nothing this forbids (P8O1-1)
    // P8-G1 adds the HTTP validators and notModified, nothing this forbids
    // (P8G1-4)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      'a7622590115d8b660e7783196d0577335f4afb70379d2ce1d386368776d69aed'
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
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
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
    // P8-C3 adds the feed pause time, nothing this forbids (P8C3-1)
    // P8-C4 adds a feed's schedule, nothing this forbids (P8C4-1)
    // P8-O1 adds the capture history model, nothing this forbids (P8O1-1)
    // P8-G1 adds the HTTP validators and notModified, nothing this forbids
    // (P8G1-4)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      'a7622590115d8b660e7783196d0577335f4afb70379d2ce1d386368776d69aed'
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
      // P8-C3: a feed's schedule, not research
      'scanPausedAt',
      // P8-C4: the rest of a feed's schedule, not research
      'captureIntervalMinutes',
      'nextCaptureAt',
      'consecutiveCaptureFailures',
      // P8-G1: the HTTP validators of a capture, not research
      'httpEtag',
      'httpLastModified',
      'organization',
      'createdBy',
      'versions',
      'feedDiscoveries',
      'discoveredBy',
      // a relation only (P8-O1): the capture records
      'captureAttempts',
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
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
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
      // a feed's capture history (P8-O1)
      'GET /sources/:id/captures',
      'POST /sources/:id/archive',
      'POST /sources/:id/restore',
      // P8-C3, a feed's schedule
      'POST /sources/:id/pause',
      'POST /sources/:id/resume',
      'POST /sources/:id/refresh',
      // P8-C4, a feed's interval
      'POST /sources/:id/interval',
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
    // P8-C3 adds the feed pause time, nothing this forbids (P8C3-1)
    // P8-C4 adds a feed's schedule, nothing this forbids (P8C4-1)
    // P8-O1 adds the capture history model, nothing this forbids (P8O1-1)
    // P8-G1 adds the HTTP validators and notModified, nothing this forbids
    // (P8G1-4)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      'a7622590115d8b660e7783196d0577335f4afb70379d2ce1d386368776d69aed'
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
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
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
    // (P8-G1: the page's HTTP validators are kept first, nothing else)
    expect(ingestion).toMatch(
      /if \(mode === 'if-changed' && transition === 'repeat'\) \{\s*if \(page\) \{\s*await this\.keepPageValidators\(organizationId, page, answer\.validators\);\s*\}\s*return \{ status: 'unchanged' as const \};/
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
    // P8-R1A: source version protection checks a stored change with it
    expect(users(/classifyContentStudioSourceCaptureTransition\(/)).toEqual(
      [
        PAGE_CHANGE.module,
        PAGE_CHANGE.ingestion,
        PAGE_CHANGE.service,
        `${SOURCES}/source.retention.ts`,
      ].sort()
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
      expect(
        backend.filter(
          (file) =>
            pattern.test(CODE.get(file)!) &&
            // P8-R1A: a stored reference checked against the version it
            // names (as grounding does), never a capture transition
            !(
              file === `${SOURCES}/source.retention.ts` &&
              pattern.source.includes('contentHash') &&
              CODE.get(file)!.match(/\.contentHash !== \w+\.contentHash/g)!
                .length === 1 &&
              /version\.contentHash !== reference\.contentHash/.test(
                CODE.get(file)!
              )
            )
        )
      ).toEqual([PAGE_CHANGE.module]);
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
      /data: \{\s*latestVersionNumber: \{\s*increment: 1,\s*\},\s*\.\.\.\(input\.pageChange \? pageChangeData\(input\.pageChange\) : \{\}\),\s*\.\.\.validatorData\(input\.validators\),\s*\},\s*\}\);\s*if \(count !== 1\) \{\s*return \{ status: 'changed' as const \};\s*\}\s*const version = await tx\.contentStudioSourceVersion\.create\(/
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
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
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
    // P8-C3 adds the feed pause time, nothing this forbids (P8C3-1)
    // P8-C4 adds a feed's schedule, nothing this forbids (P8C4-1)
    // P8-O1 adds the capture history model, nothing this forbids (P8O1-1)
    // P8-G1 adds the HTTP validators and notModified, nothing this forbids
    // (P8G1-4)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      'a7622590115d8b660e7783196d0577335f4afb70379d2ce1d386368776d69aed'
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
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
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
    // P8-C3 adds the feed pause time, nothing this forbids (P8C3-1)
    // P8-C4 adds a feed's schedule, nothing this forbids (P8C4-1)
    // P8-O1 adds the capture history model, nothing this forbids (P8O1-1)
    // P8-G1 adds the HTTP validators and notModified, nothing this forbids
    // (P8G1-4)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      'a7622590115d8b660e7783196d0577335f4afb70379d2ce1d386368776d69aed'
    );
    // the feed pause came with P8-C3 (P8C3-1), the schedule with P8-C4
    // (P8C4-1); nothing else here
    expect(
      model('ContentStudioSource').replace(SCHEDULE_FIELDS, '')
    ).not.toMatch(/limit|quota|usage|paused|interval|nextCapture/i);
    expect(schema).not.toMatch(
      /model ContentStudio\w*(Limit|Quota|Counter|Slot|Cap(?!ture))\w* \{/
    );
  });

  it('P8C1-2 no new route, no usage or limit route: 145 in all', () => {
    const controller = caps('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
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
    // P8-R1A: the source version protection map, which only reads and
    // removes nothing (pinned in its own block below), is the one exception
    expect(
      contentStudio.filter((file) =>
        /retention|purge|keepLast|prune|cleanup/i.test(CODE.get(file)!)
      )
    ).toEqual([
      'libraries/nestjs-libraries/src/content-studio/sources/source.retention.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-retention.service.ts',
    ]);
    expect(
      contentStudio.filter((file) =>
        /purge|keepLast|prune|cleanup/i.test(CODE.get(file)!)
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

  // P8-C2 changed the workflow and the worker on purpose (the capture queue,
  // pinned below); the activity and the feed capture itself are untouched
  it('P8C1-13 no Temporal change: the feed workflow, its activity and the worker are as they were', () => {
    // P8-C4 changes the workflow and adds an activity (P8C4-4..P8C4-8);
    // P8-O1 the capture's record (P8O1-WF); the worker stays as it was
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
        'c12780dc43f49a574826390d732b99e567d6945839d0556a83ee46c2ac6ae723',
      activity:
        '45eb972ec1100fc174928f3e4b26d581522a20f46a5f7c378651590e6651a064',
      worker:
        '412efbac60853923ad81f0e2c2191fd8f5fa72bef6d4f7fb2812bede9b35a305',
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
      /assertRefreshDue\(source\.lastCapturedAt, manualRefreshCooldownMs\);\s*return this\.refreshFeed\(/
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
      'async recordScheduledFeedFailure('
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

describe('P8-C2 global feed-capture concurrency', () => {
  const C2 = {
    queue:
      'libraries/nestjs-libraries/src/temporal/content.studio.capture.queue.ts',
    module: 'libraries/nestjs-libraries/src/temporal/temporal.module.ts',
    workflow:
      'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts',
    activity:
      'apps/orchestrator/src/activities/content-studio.source.activity.ts',
    app: 'apps/orchestrator/src/app.module.ts',
    main: 'apps/orchestrator/src/main.ts',
    ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
    repository:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    types: `${SOURCES}/source.types.ts`,
    controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
  };
  const c2 = (key: keyof typeof C2) => CODE.get(C2[key])!;

  it('P8C2-1/NG1/NG4/NG5 no schema change: no pause, interval or queue field', () => {
    // P8-C3 adds the feed pause time, nothing this forbids (P8C3-1)
    // P8-C4 adds a feed's schedule (P8C4-1), and no queue or priority
    // P8-G1 adds the HTTP validators and notModified, nothing this forbids
    // (P8G1-4)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      'a7622590115d8b660e7783196d0577335f4afb70379d2ce1d386368776d69aed'
    );
    // the feed pause came with P8-C3 (P8C3-1), the schedule with P8-C4
    // (P8C4-1); nothing else here
    expect(
      model('ContentStudioSource').replace(SCHEDULE_FIELDS, '')
    ).not.toMatch(/paused|interval|nextCapture|queue|priority/i);
  });

  it('P8C2-2/NG2 no route: 145 in all, none about capture capacity', () => {
    const controller = c2('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
      // P8-C3: two more, pause and resume a feed
      // P8-C4: one more, a feed's interval
    ).toHaveLength(149);
    expect(controller).not.toMatch(
      /CAPTURE_CONCURRENCY|capture-queue|TaskQueue/
    );
  });

  it('P8C2-3/NG3 the P8-C1 limits and the capture itself are unchanged', () => {
    const types = c2('types');
    expect(types).toContain(
      'export const CONTENT_STUDIO_ACTIVE_FEEDS_MAX = 100;'
    );
    expect(types).toContain(
      'export const CONTENT_STUDIO_URL_SOURCES_MAX = 100_000;'
    );
    expect(types).toContain(
      'export const CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;'
    );
    const ingestion = c2('ingestion');
    for (const line of [
      'export const SOURCE_FETCH_MAX_BYTES = 2_097_152;',
      'export const SOURCE_FETCH_TIMEOUT_MS = 15_000;',
      'export const FEED_FETCH_MAX_BYTES = 5_242_880;',
      'export const FEED_FETCH_TIMEOUT_MS = 15_000;',
      'export const FEED_CAPTURE_CONCURRENCY = 5;',
      // P8-C4 replaces the 50-minute rule by each feed's next capture
      // (P8C4-2)
      'export const FEED_SCAN_PAGE_SIZE = 200;',
    ]) {
      expect(ingestion).toContain(line);
    }
    expect(CODE.get(`${SOURCES}/source.feed.ts`)).toContain(
      'export const SOURCE_FEED_MAX_ENTRIES = 25;'
    );
  });

  it('P8C2-4/M18 one queue name, defined once, read by the workflow, the worker and the start line only', () => {
    expect(c2('queue')).toContain(
      "export const CONTENT_STUDIO_CAPTURE_TASK_QUEUE = 'content-studio-capture';"
    );
    expect(users(/content-studio-capture/)).toEqual([C2.queue]);
    expect(users(/\bCONTENT_STUDIO_CAPTURE_TASK_QUEUE\b/)).toEqual(
      [C2.main, C2.workflow, C2.queue, C2.module].sort()
    );
  });

  it('P8C2-5 the queue module is safe in the workflow bundle: no import, no environment', () => {
    expect(c2('queue')).not.toMatch(/\bimport\b|\brequire\(|process\./);
    expect(c2('workflow')).not.toMatch(/process\.env/);
  });

  it('P8C2-6 the capacity is read once, on the worker servers, and validated before any Worker exists', () => {
    expect(users(/process\.env\.CONTENT_STUDIO_CAPTURE_CONCURRENCY/)).toEqual([
      C2.module,
    ]);
    const module = c2('module');
    // inside the worker branch only: the backend and the commands skip it
    expect(module.indexOf('contentStudioCaptureWorkers(\n')).toBeGreaterThan(
      module.indexOf('...(isWorkers')
    );
    expect(c2('queue')).toContain(
      'export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_DEFAULT = 8;'
    );
    expect(c2('queue')).toContain(
      'export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX = 32;'
    );
    // the main Worker keeps its capacity
    expect(module).toContain(
      'maxConcurrentActivityTaskExecutions: concurrency || 1000000,'
    );
  });

  it('P8C2-7 only the capture activity moves: the list and the workflows stay on main, with their deadlines and attempts', () => {
    const workflow = c2('workflow');
    expect(
      workflow.match(/taskQueue: CONTENT_STUDIO_CAPTURE_TASK_QUEUE/g)
    ).toHaveLength(1);
    // the list, the child start and the failure record (P8-C4)
    expect(workflow.match(/taskQueue: 'main'/g)).toHaveLength(3);
    expect(workflow).toMatch(
      /startChild\(contentStudioFeedCaptureWorkflowV1, \{\s*workflowId: `content-studio-feed-capture-\$\{feed\.sourceId\}`,\s*taskQueue: 'main',\s*parentClosePolicy: 'ABANDON',/
    );
    expect(workflow).not.toMatch(/executeChild|Promise\.all|scheduleToStart/);
    // the activity is as it was, but for the failure record of P8-C4
    // (P8C4-7/P8C4-8) and the capture's record of P8-O1 (P8O1-WF)
    expect(createHash('sha256').update(raw(C2.activity)).digest('hex')).toBe(
      '45eb972ec1100fc174928f3e4b26d581522a20f46a5f7c378651590e6651a064'
    );
  });

  it('P8C2-8 the orchestrator runs the capture Worker with the capture activities only, and says so once', () => {
    expect(c2('app')).toMatch(
      /getTemporalModule\(true, require\.resolve\('\.\/workflows'\), activities, \[\s*ContentStudioSourceActivity,\s*\]\)/
    );
    const main = c2('main');
    expect(main.match(/console\.(log|error)\(/g)).toHaveLength(4);
    expect(main).toContain('Content Studio capture worker started (queue');
    expect(main).toContain('Content Studio capture worker did not start');
  });

  it('P8C2-9 Temporal is the only limiter: no semaphore, lock or timer of its own', () => {
    for (const key of ['queue', 'module', 'workflow', 'main'] as const) {
      expect([
        key,
        c2(key).match(
          /p-limit|pLimit|Semaphore|Mutex|ioredis|redis|pg_advisory|setInterval|setTimeout/gi
        ),
      ]).toEqual([key, null]);
    }
  });

  it('P8C2-10 a scheduled capture re-reads its feed of a live organization, in the one query it had', () => {
    const repository = c2('repository');
    const method = between(repository, '\n  getSourceForCapture(', '\n  }\n');
    expect(method.match(/this\._source\.model\.\w+\.\w+\(/g)).toEqual([
      'this._source.model.contentStudioSource.findFirst(',
    ]);
    expect(method).toMatch(/organization: \{\s*deletedAt: null,\s*\}/);
    const scheduled = between(
      c2('ingestion'),
      'async captureScheduledFeed(',
      'async recordScheduledFeedFailure('
    );
    // P8-C3: a paused feed is skipped with it, from the same read (P8C3-9)
    expect(scheduled).toMatch(
      /if \(\s*!source \|\|\s*source\.archivedAt \|\|\s*source\.scanPausedAt \|\|\s*source\.kind !== 'feed'\s*\) \{\s*return \{ status: 'skipped' as const \};/
    );
  });

  it('P8C2-11/NG8 the member refresh and the browser are untouched by the queue', () => {
    expect(
      users(
        /CONTENT_STUDIO_CAPTURE|captureConcurrency|content\.studio\.capture\.queue/
      ).filter(
        (file) =>
          file.startsWith('apps/frontend/') || file.startsWith('apps/backend/')
      )
    ).toEqual([]);
    // the refresh route still captures in the request, never through Temporal
    expect(c2('ingestion')).not.toMatch(
      /@temporalio|TemporalService|taskQueue/
    );
  });

  it('P8C2-12 .env.example documents the optional setting, commented out, with its range', () => {
    const example = raw('.env.example');
    expect(example).toContain('#CONTENT_STUDIO_CAPTURE_CONCURRENCY="8"');
    expect(example).toMatch(/\(default 8,\s*\n# 1 to 32\)/);
    expect(example).not.toMatch(/^CONTENT_STUDIO_CAPTURE_CONCURRENCY=/m);
  });
});

// Feed pause (P8-C3): one nullable time on the source, two routes, the scan
// and the scheduled capture leave a paused feed out, and nothing else
// changes: a paused feed is live, listed, in News Radar, counted against the
// live feed limit and can be refreshed. The behavior is covered by the
// service, repository, controller, feed capture and frontend specs, the
// PostgreSQL suite and the real Temporal suite; these keep it from drifting
describe('P8-C3 feed pause', () => {
  const C3 = {
    repository:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    service:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
    discoveries:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-discovery.repository.ts',
    ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
    types: `${SOURCES}/source.types.ts`,
    controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
    queue:
      'libraries/nestjs-libraries/src/temporal/content.studio.capture.queue.ts',
    api: 'apps/frontend/src/components/content-studio/content-studio.sources.api.ts',
    ui: 'apps/frontend/src/components/content-studio/content-studio.sources.tsx',
    detail:
      'apps/frontend/src/components/content-studio/content-studio.source.detail.tsx',
  };
  const c3 = (key: keyof typeof C3) => CODE.get(C3[key])!;
  const repositoryMethod = (name: string) =>
    between(c3('repository'), `\n  ${name}(`, '\n  }\n');

  it('P8C3-1/M27/M28 one nullable pause time on the source, no default, no index, feed-neutral', () => {
    // P8-C4 adds a feed's schedule after it (P8C4-1)
    // P8-G1 adds the HTTP validators and notModified, nothing this forbids
    // (P8G1-4)
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      'a7622590115d8b660e7783196d0577335f4afb70379d2ce1d386368776d69aed'
    );
    const source = fields('ContentStudioSource');
    expect(source.filter((f) => /paus/i.test(f))).toEqual([
      'scanPausedAt DateTime?',
    ]);
    // after the P8-04B1 fields, then the P8-C4 ones, the P8-G1 HTTP
    // validators, then the relations
    expect(source.slice(15, 16)).toEqual(['scanPausedAt DateTime?']);
    expect(source[21]).toBe('organization Organization');
    // P8-O1: one relation more, no column (captureAttempts)
    expect(source).toHaveLength(27);
    expect(model('ContentStudioSource')).toMatch(
      /\n\s*scanPausedAt\s+DateTime\?\n/
    );
    // the indexes P8-04B1 left: the scan reads kind, archivedAt and id
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
    expect(schema.match(/scanPausedAt/g)).toHaveLength(2);
    expect(schema).not.toMatch(/model \w*(Pause|Schedule|Interval)\w* \{/);
  });

  it('P8C3-2/P8C3-3/M27/M28/M32 no capture history or schedule of its own; the next capture, interval and backoff came with P8-C4', () => {
    // P8-C4 adds the next capture, the interval and the failure count
    // (P8C4-1); still no capture history or error. The HTTP validators
    // came with P8-G1 (P8G1-4), as those two fields only
    expect(
      schema
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s+http(Etag|LastModified)\s+String\?$/gm, '')
    ).not.toMatch(/lastCaptureError|failureDelay|backoff|etag|lastModified/i);
    expect(
      users(/lastCaptureError|ScheduleClient|scheduleHandle|\.schedule\.create/)
    ).toEqual([]);
    expect(c3('ingestion')).toContain(
      'export const FEED_SCAN_PAGE_SIZE = 200;'
    );
    // and Temporal knows nothing of the pause: the database is the truth
    expect(
      users(/scanPausedAt/).filter((file) =>
        file.startsWith('apps/orchestrator/')
      )
    ).toEqual([]);
  });

  it('P8C3-4/M29 nothing deletes or prunes: no retention', () => {
    expect(
      users(/contentStudioSource(Version|Discovery)?\.(delete|deleteMany)\(/)
    ).toEqual([]);
    for (const key of ['repository', 'service', 'ingestion'] as const) {
      expect([
        key,
        c3(key).match(/retention|purge|prune|cleanup|keepLast/gi),
      ]).toEqual([key, null]);
    }
  });

  it('P8C3-5/M30 the P8-C1 limits are unchanged, and a paused feed still counts as live', () => {
    const types = c3('types');
    expect(types).toContain(
      'export const CONTENT_STUDIO_ACTIVE_FEEDS_MAX = 100;'
    );
    expect(types).toContain(
      'export const CONTENT_STUDIO_URL_SOURCES_MAX = 100_000;'
    );
    expect(types).toContain(
      'export const CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;'
    );
    // the live feeds the limit counts: archivedAt only, never the pause
    expect(
      between(c3('repository'), 'const limitedSourcesWhere', ';\n')
    ).toMatch(
      /kind === 'feed'\s*\?\s*\{ organizationId, kind, archivedAt: null \}\s*:\s*\{ organizationId, kind \}/
    );
    expect(
      between(c3('repository'), 'const limitedSourcesWhere', ';\n')
    ).not.toMatch(/scanPausedAt/);
  });

  it('P8C3-6/M31 the P8-C2 queue and its capacity are unchanged', () => {
    const queue = c3('queue');
    expect(queue).toContain(
      "export const CONTENT_STUDIO_CAPTURE_TASK_QUEUE = 'content-studio-capture';"
    );
    expect(queue).toContain(
      'export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_DEFAULT = 8;'
    );
    expect(queue).toContain(
      'export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX = 32;'
    );
    const hash = (file: string) =>
      createHash('sha256').update(raw(file)).digest('hex');
    // P8-C4 changes the workflow and the activity (P8C4-4..P8C4-8), P8-O1
    // adds the capture's record to both (P8O1-WF)
    expect({
      queue: hash(C3.queue),
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
      queue: '0013e83698f582fd597a5a7a7f70f4248cae5a3e5491e087a1d7f217e3061c13',
      workflow:
        'c12780dc43f49a574826390d732b99e567d6945839d0556a83ee46c2ac6ae723',
      activity:
        '45eb972ec1100fc174928f3e4b26d581522a20f46a5f7c378651590e6651a064',
      worker:
        '412efbac60853923ad81f0e2c2191fd8f5fa72bef6d4f7fb2812bede9b35a305',
    });
  });

  it('P8C3-7/M20 News Radar never filters on the pause: a paused feed and its pages stay visible', () => {
    const radar = between(c3('discoveries'), 'const radarWhere', '});\n');
    expect(radar).toContain('feedSource: { archivedAt: null },');
    expect(c3('discoveries')).not.toMatch(/scanPausedAt|paused/i);
    expect(
      between(
        c3('service'),
        'async listOrganizationDiscoveries(',
        'private toPublicDiscovery('
      )
    ).not.toMatch(/scanPausedAt|paused/i);
    expect(
      between(
        c3('service'),
        'async listDiscoveries(',
        'async listOrganizationDiscoveries('
      )
    ).not.toMatch(/scanPausedAt|paused/i);
    // the Radar's feed choice is the active feeds list, paused ones included
    expect(CODE.get(RADAR_FRONTEND[0])).toContain(
      "useContentStudioSources(false, 1, 'feed')"
    );
    for (const file of RADAR_FRONTEND) {
      expect([file, CODE.get(file)!.match(/scanPausedAt|paused/gi)]).toEqual([
        file,
        null,
      ]);
    }
  });

  it('P8C3-8/M9/M15 the scan lists only feeds that are not paused', () => {
    const due = repositoryMethod('listFeedsDueForCapture');
    expect(due).toMatch(
      /where: \{\s*kind: 'feed',\s*archivedAt: null,\s*scanPausedAt: null,/
    );
    expect(due.match(/scanPausedAt/g)).toHaveLength(1);
    // the Source list keeps paused feeds with the active ones (M21)
    expect(
      between(c3('repository'), 'const sourceListWhere', '});\n')
    ).not.toMatch(/scanPausedAt/);
  });

  it('P8C3-9/M10 a scheduled capture skips a paused feed, from the one read it had', () => {
    const method = repositoryMethod('getSourceForCapture');
    expect(method.match(/this\._source\.model\.\w+\.\w+\(/g)).toEqual([
      'this._source.model.contentStudioSource.findFirst(',
    ]);
    expect(method).toContain('...SOURCE_SUMMARY,');
    expect(
      between(c3('repository'), 'const SOURCE_SUMMARY', '} as const;')
    ).toContain('scanPausedAt: true,');
    const scheduled = between(
      c3('ingestion'),
      'async captureScheduledFeed(',
      'async recordScheduledFeedFailure('
    );
    expect(scheduled).toMatch(/source\.scanPausedAt \|\|/);
    // skipped as an expected state: never an error, a retry or a write
    expect(
      scheduled.match(/return \{ status: 'skipped' as const \};/g)
    ).toHaveLength(2);
    expect(scheduled).not.toMatch(/paused_|throw|markFeedCaptured/);
  });

  it('P8C3-10/M16/M17 a member refresh never refuses or clears a pause; the capture mark keeps it', () => {
    const refresh = between(
      c3('ingestion'),
      'async refreshSource(',
      'async listFeedsDueForCapture('
    );
    expect(refresh).not.toMatch(/scanPausedAt|paused/i);
    expect(refresh).toContain(
      'assertRefreshDue(source.lastCapturedAt, manualRefreshCooldownMs);'
    );
    // P8-C4: only a later read than the last one, with the next capture and
    // no failure; never the pause (P8C4-9)
    const mark = repositoryMethod('markFeedCaptured');
    expect(mark).toMatch(
      /where: \{\s*id,\s*organizationId,\s*kind: 'feed',\s*archivedAt: null,\s*OR: \[\s*\{ lastCapturedAt: null \},\s*\{ lastCapturedAt: \{ lt: capturedAt \} \},\s*\],\s*\},\s*data: \{\s*lastCapturedAt: capturedAt,\s*nextCaptureAt,\s*consecutiveCaptureFailures: 0,\s*\.\.\.validatorData\(validators\),\s*\}/
    );
    expect(mark).not.toMatch(/scanPausedAt/);
    // only the two pause writes set the field
    expect(c3('repository').match(/scanPausedAt: (pausedAt|null),/g)).toEqual([
      'scanPausedAt: null,',
      'scanPausedAt: pausedAt,',
      'scanPausedAt: null,',
      'scanPausedAt: null,',
    ]);
    // archive and restore keep it (M6/M8)
    for (const name of ['archiveSource', 'restoreSourceWithinLimit']) {
      expect([name, repositoryMethod(name).match(/scanPausedAt/g)]).toEqual([
        name,
        null,
      ]);
    }
  });

  it('P8C3-11 pause and resume take the request organization and the path id only, for any member', () => {
    const controller = c3('controller');
    const block = between(
      controller,
      "@Post('/sources/:id/pause')",
      "@Post('/sources/:id/refresh')"
    );
    expect(block.match(/@Post\(/g)).toHaveLength(2);
    expect(block).toContain("@Post('/sources/:id/resume')");
    expect(
      block.match(/@GetOrgFromRequest\(\) org: Organization/g)
    ).toHaveLength(2);
    expect(block).toContain(
      'this._contentStudioSourceService.pauseFeed(org.id, id)'
    );
    expect(block).toContain(
      'this._contentStudioSourceService.resumeFeed(org.id, id)'
    );
    expect(block).not.toMatch(
      /@Body|@Query|@Req|GetUserFromRequest|Role|Polic|ingestion|refresh/
    );
    for (const name of ['pauseFeed', 'resumeFeed']) {
      expect(c3('service')).toContain(
        `async ${name}(organizationId: string, id: string) {`
      );
    }
  });

  it('P8C3-12/M4/M22 only a live feed has a pause: the repository, the service and the browser say so', () => {
    for (const name of ['pauseFeed', 'resumeFeed']) {
      expect(repositoryMethod(name)).toMatch(
        /where: \{\s*id,\s*organizationId,\s*kind: 'feed',\s*archivedAt: null,\s*scanPausedAt:/
      );
    }
    const live = between(c3('service'), 'private async liveFeed(', '\n  }\n');
    expect(live).toMatch(
      /if \(source\.kind !== 'feed'\) \{\s*throw kindNotScheduled\(\);\s*\}\s*if \(source\.archivedAt\) \{\s*throw sourceArchived\(\);/
    );
    // the source type error the other kinds get, with its own words
    expect(c3('service')).toMatch(
      /const kindNotScheduled = \(\) =>\s*new HttpException\(\s*\{\s*msg: 'This source type has no scheduled captures\.',\s*code: 'CS_SOURCE_KIND_UNSUPPORTED',\s*\},\s*400\s*\);/
    );
    const button = between(
      c3('ui'),
      'export const FeedScheduleButton',
      '\n};\n'
    );
    expect(button).toContain(
      "if (source.kind !== 'feed' || source.archivedAt) {"
    );
    // the browser sends nothing but the path
    expect(c3('api')).toMatch(
      /`\$\{sourcePath\(id\)\}\/pause`, \{ method: 'POST' \}/
    );
    expect(c3('api')).toMatch(
      /`\$\{sourcePath\(id\)\}\/resume`, \{ method: 'POST' \}/
    );
  });

  it('the copy says pause, never disable, archive or stop for good, and no limit place is freed by it', () => {
    const copy = JSON.parse(
      raw(
        'libraries/react-shared-libraries/src/translation/locales/en/translation.json'
      )
    ) as Record<string, string>;
    expect(copy.content_studio_feed_pause).toBe('Pause feed');
    expect(copy.content_studio_feed_resume).toBe('Resume feed');
    expect(copy.content_studio_feed_paused_status).toBe('Paused');
    expect(copy.content_studio_feed_paused).toBe('Feed paused.');
    expect(copy.content_studio_feed_resumed).toBe('Feed resumed.');
    expect(copy.content_studio_feed_paused_note).toBe(
      'Automatic scans are paused. You can still refresh this feed manually.'
    );
    for (const key of [
      'content_studio_feed_pause',
      'content_studio_feed_resume',
      'content_studio_feed_paused_status',
      'content_studio_feed_paused',
      'content_studio_feed_resumed',
      'content_studio_feed_paused_note',
    ]) {
      expect([key, copy[key]]).not.toEqual([
        key,
        expect.stringMatching(/disable|archive|permanent|forever|limit|slot/i),
      ]);
    }
    expect(copy.content_studio_source_error_feed_limit).toBe(
      'This organization has reached its limit of active feeds. Archive a feed to add or restore another.'
    );
  });
});

// A feed's schedule (P8-C4): three fields on the source, one route, the
// scan reads the next capture only, a success schedules the next one, a
// scheduled failure of the feed delays it (once, after its attempts), and
// the scan survives a list that failed. The behavior is covered by the feed
// capture, repository, service, controller, workflow and frontend specs, the
// PostgreSQL suite and the real Temporal suite; these keep it from drifting
describe('P8-C4 feed schedule and retries', () => {
  const C4 = {
    repository:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    service:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
    ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
    types: `${SOURCES}/source.types.ts`,
    controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
    workflow:
      'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts',
    activity:
      'apps/orchestrator/src/activities/content-studio.source.activity.ts',
    queue:
      'libraries/nestjs-libraries/src/temporal/content.studio.capture.queue.ts',
    register:
      'libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts',
    api: 'apps/frontend/src/components/content-studio/content-studio.sources.api.ts',
  };
  const c4 = (key: keyof typeof C4) => CODE.get(C4[key])!;
  const repositoryMethod = (name: string) =>
    between(c4('repository'), `\n  ${name}(`, '\n  }\n');

  it('P8C4-1/P8C4-12 exactly three schedule fields after the pause, no index, no other model', () => {
    const source = fields('ContentStudioSource');
    expect(source.slice(15, 19)).toEqual([
      'scanPausedAt DateTime?',
      'captureIntervalMinutes Int?',
      'nextCaptureAt DateTime?',
      'consecutiveCaptureFailures Int',
    ]);
    const block = model('ContentStudioSource');
    expect(block).toMatch(/\n\s*captureIntervalMinutes\s+Int\?\n/);
    expect(block).toMatch(/\n\s*nextCaptureAt\s+DateTime\?\n/);
    expect(block).toMatch(
      /\n\s*consecutiveCaptureFailures\s+Int\s+@default\(0\)\n/
    );
    expect(
      schema.match(
        /\b(captureIntervalMinutes|nextCaptureAt|consecutiveCaptureFailures)\b/g
      )
    ).toHaveLength(6);
    // the scan keeps the id order and the indexes it had (P8-C3)
    expect(block).not.toMatch(
      /@@index\(\[[^\]]*(nextCaptureAt|captureInterval|consecutiveCapture)/
    );
    // the capture records came with P8-O1 (P8O1-1), nothing else
    expect(
      schema.match(
        /model \w*(Schedule|Interval|Attempt|CaptureHistory|CaptureRun)\w* \{/g
      )
    ).toEqual(['model ContentStudioSourceCaptureAttempt {']);
  });

  it('P8C4-2 the 50-minute rule is gone: the old constant exists nowhere', () => {
    expect(users(/FEED_CAPTURE_INTERVAL_MS|capturedBefore/)).toEqual([]);
    expect(c4('ingestion')).not.toMatch(/50 \* 60 \* 1000/);
  });

  it('P8C4-3/M1-M8 the scan is due by the next capture alone, at or before now, in id order', () => {
    const due = repositoryMethod('listFeedsDueForCapture');
    expect(due).toMatch(
      /where: \{\s*kind: 'feed',\s*archivedAt: null,\s*scanPausedAt: null,\s*\.\.\.\(input\.afterId \? \{ id: \{ gt: input\.afterId \} \} : \{\}\),\s*OR: \[\{ nextCaptureAt: null \}, \{ nextCaptureAt: \{ lte: input\.dueAt \} \}\],\s*organization: \{\s*deletedAt: null,\s*\},\s*\},\s*orderBy: \{\s*id: 'asc',\s*\},/
    );
    expect(due).not.toMatch(
      /lastCapturedAt|consecutiveCaptureFailures|captureIntervalMinutes/
    );
    expect(
      between(
        c4('ingestion'),
        'async listFeedsDueForCapture(',
        'async captureScheduledFeed('
      )
    ).toContain('dueAt: new Date(),');
  });

  it('P8C4-4/M39 one scan cadence of 10 minutes, a fixed value of the workflow', () => {
    const workflow = c4('workflow');
    expect(workflow).toContain("const SCAN_CADENCE = '10 minutes';");
    expect(workflow.match(/await sleep\(SCAN_CADENCE\);/g)).toHaveLength(2);
    expect(workflow).not.toMatch(
      /sleep\('|'1 hour'|process\.env|Date\.now|new Date|Math\.random/
    );
  });

  it('P8C4-5/M40-M42 a list that failed every attempt: the cadence, then the same page; anything else still fails', () => {
    const scan = between(
      c4('workflow'),
      'export async function contentStudioFeedScanWorkflowV1(',
      '\n}\n'
    );
    expect(scan).toMatch(
      /\} catch \(err\) \{\s*if \(!\(err instanceof ActivityFailure\)\) \{\s*throw err;\s*\}\s*await sleep\(SCAN_CADENCE\);\s*return continueAsNew<typeof contentStudioFeedScanWorkflowV1>\(\{\s*afterId: input\.afterId \?\? null,\s*\}\);\s*\}/
    );
    // the backend still starts exactly one scan, under RUN_CRON
    expect(
      c4('register').match(/contentStudioFeedScanWorkflowV1/g)
    ).toHaveLength(1);
  });

  it('P8C4-6/M28/M29 a capture records a CS_ failure of its last attempt, then fails with it', () => {
    const capture = between(
      c4('workflow'),
      'export async function contentStudioFeedCaptureWorkflowV1(',
      '\n}\n'
    );
    // P8-O1: the run's record ends after the failure was recorded
    // (P8O1-WF), and a cancellation is left alone
    expect(capture).toMatch(
      /\} catch \(err\) \{\s*if \(!\(err instanceof ActivityFailure\) \|\| isCancellation\(err\)\) \{\s*throw err;\s*\}[\s\S]*const code =\s*err\.cause instanceof ApplicationFailure &&\s*typeof err\.cause\.type === 'string' &&\s*err\.cause\.type\.startsWith\('CS_'\)\s*\? err\.cause\.type\s*: null;\s*if \(code\) \{\s*await recordContentStudioFeedCaptureFailure\(\{\s*organizationId: input\.organizationId,\s*sourceId: input\.sourceId,\s*code,\s*\}\);\s*\}[\s\S]*await finishContentStudioFeedCaptureAttempt\([\s\S]*\}\);\s*throw err;\s*\}/
    );
    expect(
      capture.match(/recordContentStudioFeedCaptureFailure\(/g)
    ).toHaveLength(1);
  });

  it('P8C4-7/P8C4-8 the failure record takes the ids and the code, runs on main, three attempts a minute apart', () => {
    expect(c4('activity')).toMatch(
      /async recordContentStudioFeedCaptureFailure\(input: \{\s*organizationId: string;\s*sourceId: string;\s*code: string;\s*\}\)/
    );
    expect(c4('activity')).toContain(
      'this._contentStudioSourceIngestionService.recordScheduledFeedFailure(\n      input\n    );'
    );
    // with the end of the run's record (P8-O1), the same options
    expect(c4('workflow')).toMatch(
      /const \{\s*recordContentStudioFeedCaptureFailure,\s*finishContentStudioFeedCaptureAttempt,\s*\} = proxyActivities<ContentStudioSourceActivity>\(\{\s*startToCloseTimeout: '1 minute',\s*taskQueue: 'main',\s*retry: \{\s*maximumAttempts: 3,\s*backoffCoefficient: 1,\s*initialInterval: '1 minute',\s*\},\s*\}\);/
    );
    // the ingestion reads the code and stores nothing of it; the run's
    // record keeps it (P8-O1)
    const record = between(
      c4('ingestion'),
      'async recordScheduledFeedFailure(',
      'async finishScheduledFeedCapture('
    );
    expect(record).toContain('code: string;');
    expect(record).not.toMatch(/input\.code/);
  });

  it('P8C4-9 the capture keeps its queue, deadline and attempts; the queue its capacity', () => {
    expect(c4('workflow')).toMatch(
      /const \{ captureContentStudioFeed \} =\s*proxyActivities<ContentStudioSourceActivity>\(\{\s*startToCloseTimeout: '10 minute',\s*taskQueue: CONTENT_STUDIO_CAPTURE_TASK_QUEUE,\s*retry: \{\s*maximumAttempts: 3,\s*backoffCoefficient: 1,\s*initialInterval: '2 minutes',\s*\},\s*\}\);/
    );
    expect(c4('queue')).toContain(
      "export const CONTENT_STUDIO_CAPTURE_TASK_QUEUE = 'content-studio-capture';"
    );
    expect(c4('queue')).toContain(
      'export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_DEFAULT = 8;'
    );
    expect(c4('queue')).toContain(
      'export const CONTENT_STUDIO_CAPTURE_CONCURRENCY_MAX = 32;'
    );
    expect(createHash('sha256').update(raw(C4.queue)).digest('hex')).toBe(
      '0013e83698f582fd597a5a7a7f70f4248cae5a3e5491e087a1d7f217e3061c13'
    );
    // the activity maps codes as it did
    expect(c4('activity')).toContain(
      "const RETRYABLE_CODES = ['CS_SOURCE_FETCH_FAILED', 'CS_SOURCE_FETCH_TIMEOUT'];"
    );
  });

  it('P8C4-10 the pause is unchanged: the only pause writes, and the scheduled capture still skips a paused feed', () => {
    expect(c4('repository').match(/scanPausedAt: (pausedAt|null),/g)).toEqual([
      'scanPausedAt: null,',
      'scanPausedAt: pausedAt,',
      'scanPausedAt: null,',
      'scanPausedAt: null,',
    ]);
    for (const name of [
      'pauseFeed',
      'resumeFeed',
      'archiveSource',
      'restoreSourceWithinLimit',
    ]) {
      expect([
        name,
        repositoryMethod(name).match(
          /nextCaptureAt|consecutiveCaptureFailures|captureIntervalMinutes/g
        ),
      ]).toEqual([name, null]);
    }
  });

  it('P8C4-11 the P8-C1 limits and cooldown are unchanged, and a feed of any interval counts as live', () => {
    const types = c4('types');
    for (const line of [
      'export const CONTENT_STUDIO_ACTIVE_FEEDS_MAX = 100;',
      'export const CONTENT_STUDIO_URL_SOURCES_MAX = 100_000;',
      'export const CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;',
    ]) {
      expect(types).toContain(line);
    }
    expect(
      between(c4('repository'), 'const limitedSourcesWhere', ';\n')
    ).not.toMatch(
      /scanPausedAt|nextCaptureAt|captureInterval|consecutiveCapture/
    );
    // the cooldown reads the last successful capture, never the schedule
    expect(
      between(
        c4('ingestion'),
        'async refreshSource(',
        'async listFeedsDueForCapture('
      )
    ).not.toMatch(/nextCaptureAt|consecutiveCaptureFailures/);
  });

  it('P8C4-13 nothing deletes or prunes: no retention', () => {
    expect(
      users(/contentStudioSource(Version|Discovery)?\.(delete|deleteMany)\(/)
    ).toEqual([]);
    for (const key of ['repository', 'service', 'ingestion'] as const) {
      expect([
        key,
        c4(key).match(/retention|purge|prune|cleanup|keepLast/gi),
      ]).toEqual([key, null]);
    }
  });

  it('P8C4-14 no Temporal schedule, cron or signal of its own: the database is the truth', () => {
    expect(
      users(
        /ScheduleClient|scheduleHandle|\.schedule\.create|cronSchedule|defineSignal\([^)]*[Ff]eed/
      )
    ).toEqual([]);
    expect(
      users(
        /nextCaptureAt|consecutiveCaptureFailures|captureIntervalMinutes/
      ).filter((file) => file.startsWith('apps/orchestrator/'))
    ).toEqual([]);
  });

  it('P8C4-15/P8C4-16 no error code, attempt time, capture history or conditional request is stored', () => {
    // the conditional request came with P8-G1 (P8G1-1/P8G1-4): the two
    // HTTP validators of the source, nothing else
    expect(
      schema
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s+http(Etag|LastModified)\s+String\?$/gm, '')
    ).not.toMatch(
      /lastCaptureErrorCode|lastCaptureAttemptAt|lastCaptureError|etag|lastModified/i
    );
    // the capture history came with P8-O1 as its own model (P8O1-1), never
    // as fields of the source
    expect(model('ContentStudioSource')).not.toMatch(
      /\n\s*(errorCode|attemptCount|startedAt|finishedAt)\s/
    );
    // Content Studio's own code: SafeFetch itself knows the headers, and
    // ingestion alone sends them (P8-G1)
    expect(
      users(
        /lastCaptureErrorCode|lastCaptureAttemptAt|If-None-Match|If-Modified-Since/i
      ).filter((file) => /content-studio|content\.studio/.test(file))
    ).toEqual([
      'libraries/nestjs-libraries/src/content-studio/sources/ingestion/source.ingestion.service.ts',
    ]);
    expect(c4('ingestion')).not.toMatch(/jitter|Math\.random/);
  });

  it('P8C4-17 one more route, the interval: 148 (149 with P8-O1), for the request organization, the path id and a preset', () => {
    const controller = c4('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(149);
    const block = between(
      controller,
      "@Post('/sources/:id/interval')",
      '\n  }\n'
    );
    expect(block).toContain('@GetOrgFromRequest() org: Organization');
    expect(block).toContain('@Body() body: SetContentStudioFeedIntervalDto');
    expect(block).not.toMatch(
      /GetUserFromRequest|@Query|@Req|Role|Polic|ingestion/
    );
    expect(c4('types')).toContain(
      'export const CONTENT_STUDIO_FEED_INTERVALS = [60, 180, 360, 720, 1440] as const;'
    );
    expect(c4('types')).toMatch(
      /export const CONTENT_STUDIO_FEED_INTERVAL_DEFAULT_MINUTES: ContentStudioFeedInterval =\s*60;/
    );
    // the service checks the preset again, for the organization
    expect(
      between(c4('service'), 'private feedInterval(', '\n  }\n')
    ).toContain('contentStudioFeedIntervals(organizationId)');
    // the browser sends the value only
    expect(c4('api')).toMatch(
      /`\$\{sourcePath\(id\)\}\/interval`, \{\s*method: 'POST',\s*body: JSON\.stringify\(\{ intervalMinutes \}\),\s*\}/
    );
  });

  it('the failure delay: an hour, doubled each time, a day at most, whatever the interval', () => {
    const ingestion = c4('ingestion');
    expect(ingestion).toContain(
      'export const FEED_CAPTURE_FAILURE_DELAY_BASE_MINUTES = 60;'
    );
    expect(ingestion).toContain(
      'export const FEED_CAPTURE_FAILURE_DELAY_MAX_MINUTES = 1440;'
    );
    expect(
      between(ingestion, 'export const captureFailureDelayMinutes', '\n};\n')
    ).not.toMatch(/interval/i);
  });
});

describe('P8-O1 feed capture history', () => {
  const O1 = {
    attempts:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-capture-attempt.repository.ts',
    repository:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    discoveries:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-discovery.repository.ts',
    service:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
    ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
    types: `${SOURCES}/source.types.ts`,
    dto: 'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.source.dto.ts',
    controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
    workflow:
      'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts',
    activity:
      'apps/orchestrator/src/activities/content-studio.source.activity.ts',
    queue:
      'libraries/nestjs-libraries/src/temporal/content.studio.capture.queue.ts',
    api: 'apps/frontend/src/components/content-studio/content-studio.sources.api.ts',
    list: 'apps/frontend/src/components/content-studio/content-studio.sources.tsx',
    detail:
      'apps/frontend/src/components/content-studio/content-studio.source.detail.tsx',
    research:
      'apps/frontend/src/components/content-studio/content-studio.research.tsx',
  };
  const o1 = (key: keyof typeof O1) => CODE.get(O1[key])!;
  const MODEL = 'ContentStudioSourceCaptureAttempt';

  it('P8O1-1 exactly one capture history model: one row per feed capture, its one read index and the member index', () => {
    expect(
      schema.match(
        /model \w*(Attempt|CaptureHistory|CaptureRun|CaptureLog|CaptureEvent)\w* \{/g
      )
    ).toEqual([`model ${MODEL} {`]);
    expect(model(MODEL).match(/@@\w+\(.*\)/g)).toEqual([
      '@@index([organizationId, sourceId, startedAt])',
      '@@index([requestedByUserId])',
    ]);
    // the id is the row's only key: a scheduled capture's run id
    expect(model(MODEL)).not.toMatch(/@unique|@@unique/);
    // the schedule keeps its fields and indexes (P8-C4)
    expect(model('ContentStudioSource')).not.toMatch(
      /@@index\(\[[^\]]*(nextCaptureAt|captureInterval|consecutiveCapture)/
    );
  });

  it('P8O1-2 no version, discovery or page reference: the history can be kept apart from versions', () => {
    expect(model(MODEL)).not.toMatch(
      /ContentStudioSourceVersion|ContentStudioSourceDiscovery|versionId|discoveryId|pageId/
    );
    expect(
      fields(MODEL)
        .map((f) => f.split(' ')[1])
        .filter((type) => /^ContentStudio/.test(type))
    ).toEqual(['ContentStudioSource']);
  });

  it('P8O1-3 counts, codes and times only: no message, stack, body, header, URL, title or address field', () => {
    expect(
      fields(MODEL)
        .map((f) => f.split(' ')[0])
        .filter((name) =>
          /message|stack|body|header|url|title|xml|content|redirect|address|agent|detail|raw|json/i.test(
            name
          )
        )
    ).toEqual([]);
    expect(
      fields(MODEL)
        .map((f) => f.split(' ')[1])
        .filter((type) => /Json|Bytes/.test(type))
    ).toEqual([]);
    // a failure keeps its fixed code, never what the error said
    const ingestion = o1('ingestion');
    expect(
      between(ingestion, 'const feedCaptureFailure =', '\n};\n')
    ).not.toMatch(/\.message|\.stack|String\(err|JSON\.stringify/);
    expect(
      between(
        o1('service'),
        'const storedFeedCaptureAttempt',
        'export const toPublicContentStudioSource ='
      )
    ).not.toMatch(
      /\.message|\.stack|requestedByUserId|organizationId|sourceId/
    );
  });

  it('P8O1-4 every query of the history names the organization and the feed; none looks a record up by its id alone', () => {
    const attempts = o1('attempts');
    expect(attempts).not.toMatch(
      /findUnique|\.update\(|upsert|\$queryRaw|\$executeRaw/
    );
    const wheres = Array.from(
      attempts.matchAll(/where: \{([\s\S]*?)\}/g),
      (m) => m[1]
    );
    expect(wheres.length).toBeGreaterThanOrEqual(4);
    for (const where of wheres) {
      expect(where).toMatch(/organizationId/);
      expect(where).toMatch(/sourceId/);
    }
    // the success ends the record inside the feed's own transaction, scoped
    // the same way
    expect(
      between(
        o1('repository'),
        'tx.contentStudioSourceCaptureAttempt.updateMany({',
        '});'
      )
    ).toMatch(
      /where: \{\s*id: attempt\.id,\s*organizationId,\s*sourceId: id,\s*status: 'running',\s*\}/
    );
  });

  it('P8O1-5 the read is bounded: one page of 20, a page number only, no size from the request', () => {
    const list = between(o1('service'), 'async listFeedCaptures(', '\n  }\n');
    expect(list).toContain('take: PAGE_SIZE,');
    expect(list).toContain('skip: (input.page - 1) * PAGE_SIZE,');
    expect(o1('service')).toMatch(/\nconst PAGE_SIZE = 20;/);
    const dto = between(
      o1('dto'),
      'export class ListContentStudioFeedCapturesDto',
      '\n}\n'
    );
    expect(dto.match(/^\s+\w+(\?)?:/gm)).toEqual(['  page:']);
    expect(dto).toContain('@Max(PAGE_MAX)');
  });

  it('P8O1-6/P8O1-15 one history route, for a feed of the request organization: 149 routes, no organization-wide history', () => {
    const controller = o1('controller');
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(149);
    expect(
      Array.from(
        controller.matchAll(/@(Get|Post|Put|Patch|Delete)\('([^']*)'\)/g),
        (m) => `${m[1].toUpperCase()} ${m[2]}`
      ).filter((route) => /captur|attempt|histor/i.test(route))
    ).toEqual(['GET /sources/:id/captures']);
    const block = between(
      controller,
      "@Get('/sources/:id/captures')",
      '\n  }\n'
    );
    expect(block).toContain('@GetOrgFromRequest() org: Organization');
    expect(block).toContain('@Query() query: ListContentStudioFeedCapturesDto');
    expect(block).not.toMatch(/@Body|GetUserFromRequest|@Req|Role|Polic/);
  });

  it('P8O1-7 News Radar never reads the history', () => {
    expect(o1('discoveries')).not.toMatch(/CaptureAttempt|captureAttempt/);
    const { method } = radarCode();
    expect(method).not.toMatch(
      /CaptureAttempt|captureAttempt|listFeedCaptures/
    );
    expect(o1('research')).not.toMatch(/Captures|captures/);
  });

  it('P8O1-8 the Source list never reads a history: one feed at a time, on its own page', () => {
    expect(between(o1('service'), 'async listSources(', '\n  }\n')).not.toMatch(
      /CaptureAttempt|listFeedCaptures/
    );
    expect(o1('list')).not.toMatch(/useContentStudioFeedCaptures|\/captures/);
    expect(
      users(/useContentStudioFeedCaptures\(/).filter((file) =>
        /content-studio/.test(file)
      )
    ).toEqual([O1.detail]);
    // the history is read alone, never joined from a source
    expect(o1('repository')).not.toMatch(/captureAttempts:\s*\{/);
  });

  it('P8O1-9 the P8-C4 schedule is as it was: presets, cadence, failure delays', () => {
    expect(o1('types')).toContain(
      'export const CONTENT_STUDIO_FEED_INTERVALS = [60, 180, 360, 720, 1440] as const;'
    );
    expect(o1('workflow')).toContain("const SCAN_CADENCE = '10 minutes';");
    expect(o1('ingestion')).toContain(
      'export const FEED_CAPTURE_FAILURE_DELAY_BASE_MINUTES = 60;'
    );
    expect(o1('ingestion')).toContain(
      'export const FEED_CAPTURE_FAILURE_DELAY_MAX_MINUTES = 1440;'
    );
    // the success write and the failure record are the P8-C4 ones
    expect(o1('repository')).toMatch(
      /data: \{\s*lastCapturedAt: capturedAt,\s*nextCaptureAt,\s*consecutiveCaptureFailures: 0,\s*\.\.\.validatorData\(validators\),\s*\}/
    );
    expect(o1('repository')).toMatch(
      /consecutiveCaptureFailures: input\.expectedFailures,\s*OR: \[\s*\{ nextCaptureAt: null \},\s*\{ nextCaptureAt: \{ lte: input\.failedAt \} \},\s*\],/
    );
  });

  it('P8O1-10 the P8-C2 queue is as it was; the capture keeps its queue, the record ends on main', () => {
    expect(createHash('sha256').update(raw(O1.queue)).digest('hex')).toBe(
      '0013e83698f582fd597a5a7a7f70f4248cae5a3e5491e087a1d7f217e3061c13'
    );
    expect(o1('workflow')).toMatch(
      /const \{ captureContentStudioFeed \} =\s*proxyActivities<ContentStudioSourceActivity>\(\{\s*startToCloseTimeout: '10 minute',\s*taskQueue: CONTENT_STUDIO_CAPTURE_TASK_QUEUE,\s*retry: \{\s*maximumAttempts: 3,\s*backoffCoefficient: 1,\s*initialInterval: '2 minutes',\s*\},\s*\}\);/
    );
    expect(o1('workflow')).toMatch(
      /finishContentStudioFeedCaptureAttempt,\s*\} = proxyActivities<ContentStudioSourceActivity>\(\{\s*startToCloseTimeout: '1 minute',\s*taskQueue: 'main',/
    );
    expect(
      o1('workflow').match(/taskQueue: CONTENT_STUDIO_CAPTURE_TASK_QUEUE/g)
    ).toHaveLength(1);
  });

  it('P8O1-11 the P8-C1 limits are as they were', () => {
    expect(o1('types')).toContain(
      'export const CONTENT_STUDIO_ACTIVE_FEEDS_MAX = 100;'
    );
    expect(o1('types')).toContain(
      'export const CONTENT_STUDIO_URL_SOURCES_MAX = 100_000;'
    );
    expect(o1('types')).toContain(
      'export const CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;'
    );
    // the cooldown comes before the record: a refused refresh has none
    expect(
      between(
        o1('ingestion'),
        'async refreshSource(',
        'async listFeedsDueForCapture('
      )
    ).toMatch(
      /assertRefreshDue\(source\.lastCapturedAt, manualRefreshCooldownMs\);\s*return this\.refreshFeed\(/
    );
  });

  it('P8O1-12 the pause is as it was: a paused feed is never scheduled, and skipped before any record', () => {
    const scheduled = between(
      o1('ingestion'),
      'async captureScheduledFeed(',
      'async recordScheduledFeedFailure('
    );
    expect(scheduled).toMatch(
      /source\.scanPausedAt \|\|[\s\S]*return \{ status: 'skipped' as const \};[\s\S]*this\.captureFeed\(/
    );
    expect(scheduled).not.toMatch(/beginFeedCaptureAttempt|throw/);
    expect(o1('repository')).toMatch(/archivedAt: null,\s*scanPausedAt: null,/);
  });

  it('P8O1-13 nothing deletes a record: no retention, purge or cleanup', () => {
    expect(
      users(
        /contentStudioSourceCaptureAttempt\.(delete|deleteMany)\(|captureAttempts?:\s*\{\s*delete/
      )
    ).toEqual([]);
    expect(o1('attempts')).not.toMatch(/delete|retention|purge|cleanup/i);
    expect(schema).not.toMatch(/onDelete: Cascade[^\n]*ContentStudioSource\b/);
    expect(model(MODEL)).toMatch(
      /source\s+ContentStudioSource\s+@relation\(fields: \[sourceId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
  });

  it('P8O1-14 the P8-C4 failure record keeps its contract: the ids and the code, nothing more', () => {
    expect(o1('activity')).toMatch(
      /async recordContentStudioFeedCaptureFailure\(input: \{\s*organizationId: string;\s*sourceId: string;\s*code: string;\s*\}\)/
    );
    expect(o1('workflow')).toMatch(
      /await recordContentStudioFeedCaptureFailure\(\{\s*organizationId: input\.organizationId,\s*sourceId: input\.sourceId,\s*code,\s*\}\);/
    );
    // the capture activity's input is as it was too
    expect(o1('activity')).toMatch(
      /async captureContentStudioFeed\(input: \{\s*organizationId: string;\s*sourceId: string;\s*\}\)/
    );
    expect(o1('workflow')).toMatch(
      /await captureContentStudioFeed\(\{\s*organizationId: input\.organizationId,\s*sourceId: input\.sourceId,\s*\}\)/
    );
  });

  it('P8O1-16 one record per run: its id is the run id, from Temporal, never made up in the workflow', () => {
    const workflow = o1('workflow');
    expect(workflow).toContain('attemptId: workflowInfo().runId,');
    expect(workflow).not.toMatch(
      /Date\.now|new Date|Math\.random|randomUUID|uuid4|crypto/
    );
    expect(o1('activity')).toContain(
      'const { workflowExecution, attempt } = activityInfo();'
    );
    expect(o1('activity')).toMatch(
      /attemptId: workflowExecution\.runId,\s*attemptCount: attempt,/
    );
    // a try never lowers the count, and never restarts the record
    const begin = between(
      o1('attempts'),
      'async beginFeedCaptureAttempt(',
      'finishFeedCaptureAttempt('
    );
    expect(begin).toMatch(/attemptCount: \{ lt: input\.attemptCount \}/);
    expect(begin).not.toMatch(
      /startedAt: input\.startedAt,\s*\},\s*\}\);\s*return \{ status: 'resumed'/
    );
  });

  it('P8O1-17 a record ends once, from running only', () => {
    for (const block of [
      between(
        o1('attempts'),
        'finishFeedCaptureAttempt(',
        'listFeedCaptureAttempts('
      ),
      between(
        o1('repository'),
        'tx.contentStudioSourceCaptureAttempt.updateMany({',
        '});'
      ),
    ]) {
      expect(block).toMatch(/status: 'running',\s*\}/);
    }
  });

  it('P8O1-18 who asked comes from the request only, and is never shown', () => {
    const block = between(
      o1('controller'),
      "@Post('/sources/:id/refresh')",
      '\n  }\n'
    );
    expect(block).toContain('@GetUserFromRequest() user: User');
    expect(block).toContain('userId: user.id,');
    expect(o1('dto')).not.toMatch(/requestedBy|userId/);
    expect(o1('api')).not.toMatch(/requestedBy/);
    expect(
      between(
        o1('service'),
        'export const toPublicContentStudioFeedCapture',
        '\n};\n'
      )
    ).not.toMatch(/requestedBy/);
  });
});

// P8-G1: conditional fetching. A source's HTTP validators are sent back to
// its server through SafeFetch only, a 304 is a success with nothing read,
// and nothing else of P8 moves
describe('P8-G1 conditional source fetching', () => {
  const G1 = {
    safeFetch: 'libraries/nestjs-libraries/src/dtos/webhooks/safe.fetch.ts',
    ingestion: `${SOURCES}/ingestion/source.ingestion.service.ts`,
    repository:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    attempts:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-capture-attempt.repository.ts',
    service:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
    dto: 'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.source.dto.ts',
    controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
    types: `${SOURCES}/source.types.ts`,
    queue:
      'libraries/nestjs-libraries/src/temporal/content.studio.capture.queue.ts',
    workflow:
      'apps/orchestrator/src/workflows/content.studio.feed.capture.workflow.ts',
    activity:
      'apps/orchestrator/src/activities/content-studio.source.activity.ts',
    worker: 'libraries/nestjs-libraries/src/temporal/temporal.module.ts',
    api: 'apps/frontend/src/components/content-studio/content-studio.sources.api.ts',
    detail:
      'apps/frontend/src/components/content-studio/content-studio.source.detail.tsx',
  };
  const g1 = (key: keyof typeof G1) => CODE.get(G1[key])!;
  const hash = (file: string) =>
    createHash('sha256').update(raw(file)).digest('hex');
  const VALIDATORS = /httpEtag|httpLastModified/;
  const method = (text: string, name: string) =>
    between(text, `\n  ${name}(`, '\n  }\n');

  it('P8G1-1 conditional requests go through SafeFetch only, which is as it was', () => {
    expect(hash(G1.safeFetch)).toBe(
      '3d6640c5bb58941bafdcc846130d41e33d8361cb9cc4277b7b69f563ba88b979'
    );
    expect(
      users(/If-None-Match|If-Modified-Since/i).filter(
        (file) => file !== G1.safeFetch
      )
    ).toEqual([G1.ingestion]);
    const ingestion = g1('ingestion');
    expect(ingestion.match(/\bsafeFetch\(/g)).toHaveLength(1);
    expect(between(ingestion, 'const fetchSource = async (', '\n};\n')).toMatch(
      /fetched = await safeFetch\(url, \{/
    );
    expect(ingestion).not.toMatch(
      /createSafeFetch|\bfetch\(|axios|undici|node:http|getSsrfSafeDispatcher/
    );
  });

  it('P8G1-2/P8G1-6 the two conditional headers only, from stored validators only; never Authorization or Cookie', () => {
    const ingestion = g1('ingestion');
    const headers = between(
      ingestion,
      'export const conditionalRequestHeaders = (',
      '\n});\n'
    );
    expect(headers.match(/'[A-Za-z-]+':/g)).toEqual([
      "'If-None-Match':",
      "'If-Modified-Since':",
    ]);
    expect(between(ingestion, 'const fetchSource = async (', '\n};\n')).toMatch(
      /const headers = conditionalRequestHeaders\(sent\);[\s\S]*\.\.\.\(conditional \? \{ headers \} : \{\}\),/
    );
    expect(ingestion).not.toMatch(
      /authorization|cookie|user-agent|referer|x-[a-z]+-/i
    );
    // SafeFetch still lets a caller send these four only
    expect(g1('safeFetch')).toMatch(
      /const CALLER_HEADERS = new Set\(\[\s*'accept',\s*'accept-language',\s*'if-none-match',\s*'if-modified-since',\s*\]\);/
    );
  });

  it('P8G1-3/P8G1-4 validators never come from or go to a route, the frontend or the Source list', () => {
    for (const key of ['dto', 'controller', 'api', 'detail'] as const) {
      expect([
        key,
        g1(key).match(/etag|lastModified|If-None|If-Modified/gi),
      ]).toEqual([key, null]);
    }
    expect(
      users(VALIDATORS).filter((file) => !file.startsWith('libraries/'))
    ).toEqual([]);
    expect(users(VALIDATORS)).toEqual([G1.repository, G1.ingestion].sort());
    expect(
      between(
        g1('service'),
        'export const toPublicContentStudioSource =',
        '\n});\n'
      )
    ).not.toMatch(VALIDATORS);
    expect(
      between(g1('repository'), 'const SOURCE_SUMMARY = {', '}')
    ).not.toMatch(VALIDATORS);
    // the schema: two nullable texts on the source, no default and no index
    expect(
      fields('ContentStudioSource').filter((f) => /^http/i.test(f))
    ).toEqual(['httpEtag String?', 'httpLastModified String?']);
    expect(model('ContentStudioSource')).toMatch(
      /\n\s*httpEtag\s+String\?\n\s*httpLastModified\s+String\?\n/
    );
    expect(model('ContentStudioSource')).not.toMatch(/@@\w+\([^)]*http/);
  });

  it('P8G1-5 no raw response header, status or body is stored', () => {
    for (const name of [
      'ContentStudioSource',
      'ContentStudioSourceVersion',
      'ContentStudioSourceCaptureAttempt',
      'ContentStudioSourceDiscovery',
    ]) {
      expect([
        name,
        fields(name).filter((f) =>
          /header|etag|modified|cache|vary|expires/i.test(f.split(' ')[0])
        ),
      ]).toEqual([
        name,
        {
          ContentStudioSource: ['httpEtag String?', 'httpLastModified String?'],
          ContentStudioSourceVersion: [],
          ContentStudioSourceCaptureAttempt: ['notModified Boolean?'],
          ContentStudioSourceDiscovery: [],
        }[name],
      ]);
    }
    expect(fields('ContentStudioSourceCaptureAttempt')).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^httpStatus /)])
    );
    // of an answer's headers only these are read: the type, the ETag and
    // the Last-Modified
    expect(
      [...new Set(g1('ingestion').match(/\.headers\.\w+/g))].sort()
    ).toEqual([
      '.headers.contentType',
      '.headers.etag',
      '.headers.lastModified',
    ]);
  });

  it('P8G1-7 a member refresh of a page never asks conditionally', () => {
    const ingestion = g1('ingestion');
    const capture = between(
      ingestion,
      'private async captureUrl(\n    organizationId: string,\n    source: SourceRow | PageRow,',
      '\n  }\n'
    );
    expect(capture).toMatch(
      /const page =\s*mode === 'if-changed' && expectedLatestVersionNumber > 0\s*\? \(source as PageRow\)\s*: null;\s*const sent = page \? storedValidators\(page\) : NO_VALIDATORS;/
    );
    expect(between(ingestion, 'async refreshSource(input', '\n  }\n')).toMatch(
      /this\.captureUrl\(\s*input\.organizationId,\s*source,\s*input\.userId,\s*'always'\s*\)/
    );
  });

  it('P8G1-8/P8G1-9 a 304 of a page stores no version and no page change: its validators only, updatedAt kept', () => {
    const capture = between(
      g1('ingestion'),
      'private async captureUrl(\n    organizationId: string,\n    source: SourceRow | PageRow,',
      '\n  }\n'
    );
    expect(capture).toMatch(
      /if \(answer\.status === 'not-modified'\) \{\s*await this\.keepPageValidators\(organizationId, page!, answer\.validators\);\s*return \{ status: 'not-modified' as const \};\s*\}/
    );
    expect(capture.indexOf("answer.status === 'not-modified'")).toBeLessThan(
      capture.indexOf('extractContentStudioSource(')
    );
    const unchanged = method(g1('repository'), 'markPageUnchanged');
    expect(between(unchanged, 'data: {', '}')).toMatch(
      /^data: \{\s*\.\.\.validatorData\(input\.validators\),\s*updatedAt: input\.expected\.updatedAt,\s*$/
    );
    expect(unchanged).not.toMatch(
      /lastPageChange|increment|contentStudioSourceVersion|fetchedAt/
    );
    expect(unchanged).toMatch(
      /latestVersionNumber: input\.expected\.latestVersionNumber,\s*updatedAt: input\.expected\.updatedAt,\s*httpEtag: input\.expected\.httpEtag,\s*httpLastModified: input\.expected\.httpLastModified,/
    );
    // nothing updates a version, ever
    expect(
      users(/contentStudioSourceVersion\.(update|updateMany|upsert)\(/)
    ).toEqual([]);
  });

  it('P8G1-10 a 304 of a feed is a success: the same monotonic write, schedule and failures, and its record', () => {
    const ingestion = g1('ingestion');
    const feed = between(ingestion, 'private async captureFeed(', '\n  }\n');
    expect(feed).toMatch(
      /if \(answer\.status === 'not-modified'\) \{\s*return this\.feedCaptured\([\s\S]*?NOT_MODIFIED_CAPTURE,\s*true\s*\);\s*\}/
    );
    expect(feed.indexOf("answer.status === 'not-modified'")).toBeLessThan(
      feed.indexOf('parseContentStudioSourceFeed(')
    );
    expect(
      between(ingestion, 'const NOT_MODIFIED_CAPTURE', '\n};\n').match(/: 0,/g)
    ).toHaveLength(10);
    const mark = method(g1('repository'), 'markFeedCaptured');
    expect(mark).toMatch(
      /OR: \[\s*\{ lastCapturedAt: null \},\s*\{ lastCapturedAt: \{ lt: capturedAt \} \},\s*\],\s*\},\s*data: \{\s*lastCapturedAt: capturedAt,\s*nextCaptureAt,\s*consecutiveCaptureFailures: 0,\s*\.\.\.validatorData\(validators\),\s*\}/
    );
    expect(mark).toMatch(/notModified: attempt\.notModified,/);
  });

  it('P8G1-11/P8G1-12/P8G1-13/P8G1-16 the P8-C1 caps, P8-C2 queue, P8-C4 schedule and the scan are as they were', () => {
    expect({
      queue: hash(G1.queue),
      workflow: hash(G1.workflow),
      activity: hash(G1.activity),
      worker: hash(G1.worker),
    }).toEqual({
      queue: '0013e83698f582fd597a5a7a7f70f4248cae5a3e5491e087a1d7f217e3061c13',
      workflow:
        'c12780dc43f49a574826390d732b99e567d6945839d0556a83ee46c2ac6ae723',
      activity:
        '45eb972ec1100fc174928f3e4b26d581522a20f46a5f7c378651590e6651a064',
      worker:
        '412efbac60853923ad81f0e2c2191fd8f5fa72bef6d4f7fb2812bede9b35a305',
    });
    const types = g1('types');
    for (const line of [
      'export const CONTENT_STUDIO_ACTIVE_FEEDS_MAX = 100;',
      'export const CONTENT_STUDIO_URL_SOURCES_MAX = 100_000;',
      'export const CONTENT_STUDIO_MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;',
    ]) {
      expect(types).toContain(line);
    }
    expect(types).toMatch(
      /CONTENT_STUDIO_FEED_INTERVALS = \[60, 180, 360, 720, 1440\]/
    );
    const ingestion = g1('ingestion');
    for (const line of [
      'export const FEED_CAPTURE_CONCURRENCY = 5;',
      'export const FEED_SCAN_PAGE_SIZE = 200;',
      'export const FEED_CAPTURE_FAILURE_DELAY_BASE_MINUTES = 60;',
      'export const FEED_CAPTURE_FAILURE_DELAY_MAX_MINUTES = 1440;',
      'export const SOURCE_FETCH_MAX_BYTES = 2_097_152;',
      'export const SOURCE_FETCH_TIMEOUT_MS = 15_000;',
      'export const FEED_FETCH_MAX_BYTES = 5_242_880;',
      'export const FEED_FETCH_TIMEOUT_MS = 15_000;',
    ]) {
      expect(ingestion).toContain(line);
    }
    // P8G1-16: the scan reads by nextCaptureAt, in id order, as it did, and
    // no index came with the validators
    expect(method(g1('repository'), 'listFeedsDueForCapture')).toMatch(
      /orderBy: \{\s*id: 'asc',\s*\}/
    );
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
    expect(
      g1('controller').match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(149);
  });

  it('P8G1-14 still one record per feed capture, written by the capture, whatever the answer', () => {
    expect(model('ContentStudioSourceCaptureAttempt')).toMatch(
      /\n\s*notModified\s+Boolean\?\n/
    );
    expect(model('ContentStudioSourceCaptureAttempt')).not.toMatch(
      /notModified[^\n]*@default/
    );
    // set by a success only, in its one transaction (and read back by the
    // history's mapper); never by a failure
    expect(users(/notModified: attempt\.notModified/)).toEqual(
      [G1.repository, G1.service].sort()
    );
    expect(
      between(
        g1('service'),
        'export const toPublicContentStudioFeedCapture',
        '\n};\n'
      )
    ).toContain('notModified: attempt.notModified,');
    // the begin and a failure's end never write it: it stays null
    expect(
      between(
        g1('attempts'),
        'async beginFeedCaptureAttempt(',
        'listFeedCaptureAttempts('
      )
    ).not.toMatch(/notModified/);
    expect(
      between(g1('ingestion'), 'private async captureFeed(', '\n  }\n').match(
        /beginFeedCaptureAttempt\(/g
      )
    ).toHaveLength(1);
  });

  it('P8G1-15 nothing is deleted or pruned: no retention', () => {
    expect(
      users(
        /contentStudioSource(Version|Discovery|CaptureAttempt)?\.(delete|deleteMany)\(/
      )
    ).toEqual([]);
    for (const key of ['repository', 'ingestion', 'service'] as const) {
      expect([
        key,
        g1(key).match(/retention|purge|prune|cleanup|keepLast/gi),
      ]).toEqual([key, null]);
    }
  });
});

describe('P8-R1A source version protection', () => {
  const R1 = {
    pure: `${SOURCES}/source.retention.ts`,
    service:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source-retention.service.ts',
    sources:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.repository.ts',
    packages:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.repository.ts',
    reviews:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.review.repository.ts',
    operations:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-operation.repository.ts',
    sourceService:
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.source.service.ts',
    draft:
      'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts',
    context:
      'libraries/nestjs-libraries/src/content-studio/ai/ai.operation.types.ts',
    picker:
      'apps/frontend/src/components/content-studio/content-studio.grounding.tsx',
    module: 'libraries/nestjs-libraries/src/database/prisma/database.module.ts',
    controller: 'apps/backend/src/api/routes/content-studio.controller.ts',
  };
  const r1 = (key: keyof typeof R1) => CODE.get(R1[key])!;
  // the repository reads protection makes, by file, and nothing else
  const READS: Array<[keyof typeof R1, string, string]> = [
    ['sources', 'listSourcesForVersionProtection', 'contentStudioSource'],
    ['sources', 'listVersionsForProtection', 'contentStudioSourceVersion'],
    ['packages', 'listPackageDraftsForVersionProtection', 'contentPackage'],
    [
      'reviews',
      'listPackageReviewsForVersionProtection',
      'contentStudioReview',
    ],
    [
      'packages',
      'listPackageRevisionsForVersionProtection',
      'contentPackageRevision',
    ],
    [
      'operations',
      'listOperationContextsForVersionProtection',
      'contentStudioAIOperation',
    ],
  ];
  const read = (file: keyof typeof R1, name: string) =>
    between(r1(file), `\n  ${name}(`, '\n  }\n');
  const WRITES =
    /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/;

  it('R1-1/R1-2 nothing removes a version: no delete anywhere in production, no write in protection', () => {
    expect(users(/contentStudioSourceVersion\.(delete|deleteMany)\(/)).toEqual(
      []
    );
    expect(users(/sourceVersion[s]?:\s*\{\s*delete/i)).toEqual([]);
    for (const key of ['pure', 'service'] as const) {
      expect([key, r1(key).match(WRITES)]).toEqual([key, null]);
      expect([
        key,
        r1(key).match(
          /deletable|safeToDelete|deleteCandidate|purge|prune|cleanup|keepLast/i
        ),
      ]).toEqual([key, null]);
    }
    // the reads are reads: findMany, nothing else
    for (const [file, name] of READS) {
      const body = read(file, name);
      expect([name, body.match(WRITES)]).toEqual([name, null]);
      expect([name, body.match(/\.(\w+)\(\{/g)]).toEqual([
        name,
        ['.findMany({'],
      ]);
    }
  });

  it('R1-3 every stored document and every field naming a source or version of Content Studio is classified', () => {
    // documents: Json, or a String holding JSON
    const DOCUMENTS: Record<string, 'enumerated' | 'no-reference'> = {
      'ContentPackage.draft': 'enumerated',
      'ContentPackageRevision.content': 'enumerated',
      'ContentStudioAIOperation.context': 'enumerated',
      // the version itself
      'ContentStudioSourceVersion.content': 'no-reference',
      // profiles, policy, brand and design: no source, ever
      'ContentStudioWritingProfileRevision.content': 'no-reference',
      'ContentStudioEditorialPolicyRevision.content': 'no-reference',
      'ContentStudioAudienceProfileRevision.content': 'no-reference',
      'ContentStudioExpertiseProfileRevision.content': 'no-reference',
      'ContentStudioBrandKitRevision.content': 'no-reference',
      'ContentStudioDesignRevision.content': 'no-reference',
      'ContentStudioDesignTemplateRevision.content': 'no-reference',
      'ContentStudioDesignStylePreset.content': 'no-reference',
      'ContentStudioDesignLayoutPattern.content': 'no-reference',
      'ContentStudioDesignPageSet.content': 'no-reference',
      'ContentStudioDesignBlock.content': 'no-reference',
      'ContentStudioDesignRender.assetSnapshot': 'no-reference',
    };
    // fields naming a source or a version, or holding one by relation
    const REFERENCES: Record<string, string> = {
      'ContentStudioSource.versions': 'the versions themselves',
      'ContentStudioSourceVersion.sourceId': 'its own source',
      'ContentStudioSourceVersion.source': 'its own source',
      'ContentStudioSourceCaptureAttempt.sourceId': 'no-reference (P8-O1)',
      'ContentStudioSourceCaptureAttempt.source': 'no-reference (P8-O1)',
      'ContentStudioSourceDiscovery.feedSourceId': 'no-reference (sources)',
      'ContentStudioSourceDiscovery.discoveredSourceId':
        'no-reference (sources)',
      'ContentStudioSourceDiscovery.feedSource': 'no-reference (sources)',
      'ContentStudioSourceDiscovery.discoveredSource': 'no-reference (sources)',
    };
    const documents: string[] = [];
    const references: string[] = [];
    for (const [, name, body] of schema.matchAll(
      /\nmodel (\w+) \{([\s\S]*?)\n\}/g
    )) {
      if (!/^(ContentStudio|ContentPackage)/.test(name)) {
        continue;
      }
      for (const line of body.split('\n')) {
        const [field, type] = line.trim().split(/\s+/);
        if (!field || !type || field.startsWith('@@')) {
          continue;
        }
        const scalar = type.replace(/\?$/, '');
        if (
          scalar === 'Json' ||
          (scalar === 'String' &&
            /(content|draft|document|context|snapshot|payload|metadata)$/i.test(
              field
            ))
        ) {
          documents.push(`${name}.${field}`);
        }
        if (
          /versionId|sourceId/i.test(field) ||
          /^ContentStudioSource(Version)?(\[\])?\??$/.test(type)
        ) {
          references.push(`${name}.${field}`);
        }
      }
    }
    expect(documents.sort()).toEqual(Object.keys(DOCUMENTS).sort());
    expect(references.sort()).toEqual(Object.keys(REFERENCES).sort());
    // nothing holds a version by a foreign key: only its parents' lists
    expect(
      [...schema.matchAll(/\n\s+(\w+)\s+ContentStudioSourceVersion\[\]/g)].map(
        (match) => match[1]
      )
    ).toEqual([
      'contentStudioSourceVersions',
      'contentStudioSourceVersions',
      'versions',
    ]);
    expect(schema).not.toMatch(/sourceVersionId|\bversionId\b/);
    // each enumerated document is read by its protection read
    expect(read('packages', 'listPackageDraftsForVersionProtection')).toMatch(
      /draft: true/
    );
    expect(
      read('packages', 'listPackageRevisionsForVersionProtection')
    ).toMatch(/content: true,\s*contentHash: true/);
    expect(
      read('operations', 'listOperationContextsForVersionProtection')
    ).toMatch(/context: true/);
    // the code that names a version id: the two stored schemas protection
    // parses, the grounding and AI writing that write them, the source
    // routes and capture, protection itself and the frontend's requests.
    // A new place that stores one must be classified here and in protection
    expect(users(/\bversionId\b/)).toEqual(
      [
        R1.controller,
        'apps/frontend/src/components/content-studio/content-studio.ai-proposal.tsx',
        'apps/frontend/src/components/content-studio/content-studio.ai-writing.tsx',
        'apps/frontend/src/components/content-studio/content-studio.api.ts',
        R1.picker,
        'apps/frontend/src/components/content-studio/content-studio.sources.api.ts',
        R1.context,
        R1.draft,
        `${SOURCES}/ingestion/source.ingestion.service.ts`,
        R1.pure,
        'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.ai-writing.service.ts',
        'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.grounding.service.ts',
        R1.service,
        R1.sources,
        R1.sourceService,
      ].sort()
    );
  });

  it('R1-4 every protection read is of the request organization, in id order, after an id, a bounded page', () => {
    for (const [file, name, model] of READS) {
      const body = read(file, name);
      expect([name, body]).toEqual([
        name,
        expect.stringMatching(
          new RegExp(
            `^\\n  ${name}\\(input: \\{\\n    organizationId: string;\\n    afterId: string \\| null;\\n    take: number;\\n  \\}\\) \\{\\n    return this\\._\\w+\\.model\\.${model}\\.findMany\\(\\{\\n      where: \\{\\n        organizationId: input\\.organizationId,`
          )
        ),
      ]);
      expect([name, body]).toEqual([
        name,
        expect.stringMatching(
          /\.\.\.\(input\.afterId \? \{ id: \{ gt: input\.afterId \} \} : \{\}\),\s*\},\s*orderBy: \{\s*id: 'asc',\s*\},\s*select: \{[\s\S]*\},\s*take: input\.take,\s*\}\);$/
        ),
      ]);
      expect([name, body.match(/organizationId: true/g)]).toEqual([
        name,
        ['organizationId: true'],
      ]);
    }
    // and the service checks every row it gets is of that organization
    const service = r1('service');
    expect(service.match(/scoped\('(\w+)'\)/g)).toEqual([
      "scoped('ContentPackage')",
      "scoped('ContentStudioReview')",
      "scoped('ContentPackageRevision')",
      "scoped('ContentStudioAIOperation')",
    ]);
    expect(
      [...service.matchAll(/this\._\w+Repository\.(\w+)\(/g)].map((m) => m[1])
    ).toEqual(READS.map(([, name]) => name));
    expect(
      service.match(/organizationId,\n\s+afterId,\n\s+take,/g)
    ).toHaveLength(4);
    expect(service.match(/\{ organizationId, afterId, take \}/g)).toHaveLength(
      2
    );
    // and the pure rules check the sources and versions themselves
    expect(
      between(
        r1('pure'),
        'export function deriveContentStudioSourceVersionProtections(',
        '\n}\n'
      )
    ).toMatch(
      /source\.organizationId !== organizationId[\s\S]*version\.organizationId !== organizationId/
    );
  });

  it('R1-5 a reference that does not resolve fails the organization: never skipped, never empty', () => {
    const resolve = between(
      r1('pure'),
      'export function resolveContentStudioSourceVersionReferences(',
      '\n}\n'
    );
    expect(resolve).not.toMatch(/continue|return \[\]|console|logger|warn/i);
    expect(resolve).toMatch(
      /if \(\s*!version \|\|\s*version\.organizationId !== input\.organizationId \|\|\s*version\.sourceId !== reference\.sourceId \|\|\s*version\.versionNumber !== reference\.versionNumber \|\|\s*version\.contentHash !== reference\.contentHash\s*\) \{\s*throw integrity\(reference\.referenceType, reference\.referenceId\);\s*\}/
    );
    const service = r1('service');
    expect(service).not.toMatch(
      /continue|return \[\]|catch \{\s*\}|console|_logger|\.warn\(/
    );
    expect(service.match(/catch \{\s*throw integrity\(/g)).toHaveLength(2);
    expect(service).toMatch(
      /if \(!context\) \{\s*throw integrity\('ContentStudioAIOperation', row\.id\);/
    );
  });

  it('R1-6 the latest version, the last page change with its predecessor and baseline, and the in-flight guard are derived', () => {
    const derive = between(
      r1('pure'),
      'export function deriveContentStudioSourceVersionProtections(',
      '\n}\n'
    );
    for (const call of [
      "protect(latest, 'LATEST', 'ContentStudioSource', source.id, 'latest')",
      "'changed'",
      "'predecessor'",
      "'comparison_baseline'",
      "'picker_window'",
      "'age'",
      'storedContentStudioSourcePageChange(source)',
      'classifyContentStudioSourceCaptureTransition(predecessor, changed)',
      'isSameContentStudioSourceCapture(versions[first - 1], predecessor)',
      'versions.slice(-input.pickerWindow)',
      'version.createdAt.getTime() >= cutoff',
    ]) {
      expect([call, derive.includes(call)]).toEqual([call, true]);
    }
    // the predecessor is the version before it that exists, never number - 1
    expect(derive).not.toMatch(
      /versionNumber - 1|latestVersionNumber - |- input\.pickerWindow/
    );
    // the stored change is read as the Changes list reads it, from one place
    expect(users(/storedContentStudioSourcePageChange/)).toEqual(
      [`${SOURCES}/source.version.ts`, R1.pure, R1.sourceService].sort()
    );
    expect(r1('sourceService')).not.toMatch(/const storedPageChange =/);
    expect(CONTENT_STUDIO_SOURCE_VERSION_PROTECTION_REASONS).toEqual([
      'LATEST',
      'PAGE_CHANGE',
      'DRAFT_EVIDENCE',
      'REVISION_EVIDENCE',
      'REVIEW_EVIDENCE',
      'AI_OPERATION',
      'IN_FLIGHT',
    ]);
  });

  it("R1-7/R1-8 a review protects through its revision's grounding; an AI operation through its context sources", () => {
    const service = r1('service');
    expect(service).toMatch(
      /const refs = revisionEvidence\.get\(review\.packageRevisionId\);\s*if \(!refs\) \{\s*throw integrity\('ContentStudioReview', review\.id\);\s*\}\s*refer\('REVIEW_EVIDENCE', 'ContentStudioReview', review\.id, refs\);/
    );
    expect(service.match(/'REVIEW_EVIDENCE'/g)).toHaveLength(1);
    expect(service).toMatch(
      /parseVerifiedContentPackageRevision\(row\)[\s\S]*revisionEvidence\.set\(row\.id, refs\);/
    );
    expect(service).toMatch(
      /contentPackageClaims\(\s*parseContentPackageDraft\(JSON\.parse\(row\.draft\)\)\s*\)\.flatMap\(\(claim\) => claim\.evidence\)/
    );
    expect(service).toMatch(
      /const context = parseContentStudioAIOperationContext\(row\.context\);[\s\S]*distinctEvidence\(context\.sources \?\? \[\]\)/
    );
    // no status, state or archive filter: every record of each kind counts
    for (const [file, name] of READS) {
      expect([
        name,
        read(file, name).match(/status|state|archivedAt|deletedAt/),
      ]).toEqual([name, null]);
    }
    // no reason of its own for approvals, handoffs, designs or research
    expect(r1('pure')).not.toMatch(/APPROVAL|HANDOFF|DESIGN|RESEARCH|HISTORY/);
  });

  it('R1-9/R1-10 capture history and HTTP validators hold no version and protect nothing', () => {
    expect(
      fields('ContentStudioSourceCaptureAttempt').filter((f) =>
        /version/i.test(f)
      )
    ).toEqual(['versionsCreated Int?']);
    expect(model('ContentStudioSourceCaptureAttempt')).not.toMatch(
      /ContentStudioSourceVersion|versionId/
    );
    for (const key of ['pure', 'service'] as const) {
      expect([
        key,
        r1(key).match(
          /httpEtag|httpLastModified|CaptureAttempt|captureAttempt|scanPausedAt|nextCaptureAt|captureIntervalMinutes|Discovery|discovery/g
        ),
      ]).toEqual([key, null]);
    }
    expect(read('sources', 'listSourcesForVersionProtection')).not.toMatch(
      /http|scanPausedAt|nextCaptureAt|lastCapturedAt|captureAttempts|discover|feedDiscoveries/
    );
  });

  it('R1-11 the rules are pure: the caller passes the time', () => {
    const pure = r1('pure');
    expect(pure).not.toMatch(
      /Date\.now|new Date\(|Math\.random|randomUUID|process\.env|@prisma|@nestjs|fetch\(/
    );
    expect(r1('service')).not.toMatch(/Date\.now|new Date\(/);
    expect(r1('service')).toMatch(/now: input\.now,/);
    expect(CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS).toBe(
      24 * 60 * 60 * 1000
    );
  });

  it('R1-12 the picker window is the page of versions the evidence picker offers', () => {
    expect(CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW).toBe(20);
    const sourceService = r1('sourceService');
    expect(sourceService).toContain(
      `const PAGE_SIZE = ${CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW};`
    );
    expect(
      between(sourceService, 'async listVersions(input', '\n  }\n')
    ).toMatch(/skip: \(input\.page - 1\) \* PAGE_SIZE,\s*take: PAGE_SIZE,/);
    expect(
      between(r1('sources'), 'listVersionsForSource(input', '\n  }\n')
    ).toMatch(/orderBy: \{\s*versionNumber: 'desc',\s*\}/);
    // the first page, newest first, and nothing else
    expect(
      r1('picker').match(/useContentStudioSourceVersions\([^)]*\)/g)
    ).toEqual(['useContentStudioSourceVersions(sourceId, 1)']);
  });

  it('R1-13 internal only: a provider, and no route, command, activity, workflow or frontend reaches it', () => {
    expect(
      users(
        /ContentStudioSourceRetentionService|explainRetentionEligibility|computeProtectionMap|source\.retention'/
      )
    ).toEqual([R1.service, R1.module].sort());
    expect(r1('module')).toMatch(
      /ContentStudioSourceService,\n\s*ContentStudioSourceRetentionService,\n/
    );
    const commands = walk(path.join(REPO_ROOT, 'apps/commands/src'));
    expect(
      commands.filter((file) =>
        /retention|Retention|ForVersionProtection|ForProtection/.test(
          fs.readFileSync(file, 'utf8')
        )
      )
    ).toEqual([]);
    expect(users(/ForVersionProtection|ForProtection\(/)).toEqual(
      [R1.service, R1.sources, R1.packages, R1.reviews, R1.operations].sort()
    );
    expect(r1('controller')).not.toMatch(/retention|eligib|protection/i);
    expect(
      r1('controller').match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(149);
    // and no schema for it: no table, flag or index of retention
    expect(schema).not.toMatch(
      /retention|Retention|eligib|protected|quarantine|pendingAt/
    );
    expect(fields('ContentStudioSourceVersion')).toEqual([
      'id String',
      'organizationId String',
      'sourceId String',
      'versionNumber Int',
      'schemaVersion Int',
      'extractionVersion String',
      'requestedUrl String',
      'finalUrl String',
      'redirectCount Int',
      'fetchedAt DateTime',
      'httpStatus Int?',
      'contentType String?',
      'contentLength Int?',
      'title String?',
      'content String',
      'contentHash String',
      'sourceHash String?',
      'createdById String',
      'createdAt DateTime',
      'organization Organization',
      'source ContentStudioSource',
      'createdBy User',
    ]);
  });

  it('R1-14 the references protection parses are pinned: a change of grounding or AI context must change protection', () => {
    const shape = (text: string, start: string) =>
      [...between(text, start, '.strict()').matchAll(/\n\s+(\w+): /g)].map(
        (match) => match[1]
      );
    expect(shape(r1('draft'), 'const evidenceSchema = z')).toEqual([
      'sourceId',
      'versionId',
      'versionNumber',
      'contentHash',
      'blockId',
      'quote',
    ]);
    expect(shape(r1('context'), 'const sourceRef = z')).toEqual([
      'sourceId',
      'versionId',
      'versionNumber',
      'contentHash',
    ]);
    expect(shape(r1('context'), 'const contextV1 = z')).toEqual([
      'v',
      'itemId',
      'profiles',
      'editorialPolicy',
      'sources',
      'design',
    ]);
    expect(r1('draft')).toMatch(
      /export const contentPackageClaims = \(\s*draft: ContentPackageDraft\s*\): readonly ContentPackageClaimV2\[\] =>\s*draft\.schemaVersion === CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION\s*\? draft\.grounding\.claims\s*: \[\];/
    );
    expect([
      CONTENT_PACKAGE_SCHEMA_VERSION,
      CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION,
    ]).toEqual([1, 2]);
    // what protection compares of a reference: all four, as grounding does
    expect(
      between(r1('service'), 'const distinctEvidence = (', '\n};\n')
    ).toMatch(
      /sourceId: entry\.sourceId,\s*versionId: entry\.versionId,\s*versionNumber: entry\.versionNumber,\s*contentHash: entry\.contentHash,/
    );
  });
});
