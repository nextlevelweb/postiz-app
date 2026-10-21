import fs from 'fs';
import path from 'path';
import {
  CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION,
  CONTENT_PACKAGE_SCHEMA_VERSION,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  DESIGN_DOCUMENT_SCHEMA_VERSION,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// The package to design bridge (P6-01) in one place, pinned on the source:
// a design is made from exactly one saved package revision, as a copy, by
// the design services that already make designs, and keeps that revision
// and its hash as where it came from, written once with the project. It is
// not a handoff, asks for no review or approval, and syncs nothing either
// way. The behavior is covered by content-studio.design-package.spec.ts,
// design.package.source.spec.ts, the controller spec and the PostgreSQL
// suite; this spec keeps the decisions from drifting. Comments are
// stripped: they explain the rules and may name them
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
// The body of one class method: from its name to the next member
const method = (source: string, name: string) => {
  const start = source.search(new RegExp(`\\n  (async )?${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const next = source
    .slice(start + 1)
    .search(/\n  (async |private |private async )?[a-zA-Z]+\(/);
  return next === -1
    ? source.slice(start)
    : source.slice(start, start + 1 + next);
};

const LIB = 'libraries/nestjs-libraries/src';
const CS = `${LIB}/database/prisma/content-studio`;
const PACKAGE_SERVICE = `${CS}/content-studio.service.ts`;
const DESIGN_SERVICE = `${CS}/content-studio.design.service.ts`;
const DESIGN_REPOSITORY = `${CS}/content-studio.design.repository.ts`;
const TEMPLATE_SERVICE = `${CS}/content-studio.design-template.service.ts`;
const PAGE_SET_SERVICE = `${CS}/content-studio.design-page-set.service.ts`;
const HELPER = `${LIB}/content-studio/design/design.package.source.ts`;
const CONTROLLER = 'apps/backend/src/api/routes/content-studio.controller.ts';
const DTO = `${LIB}/dtos/content-studio/content-studio.design.dto.ts`;
const SCHEMA = fs.readFileSync(
  path.join(REPO_ROOT, `${LIB}/database/prisma/schema.prisma`),
  'utf8'
);
const model = (name: string) =>
  SCHEMA.slice(
    SCHEMA.indexOf(`model ${name} {`),
    SCHEMA.indexOf('\n}', SCHEMA.indexOf(`model ${name} {`))
  );
const BRIDGE = () =>
  method(CODE.get(PACKAGE_SERVICE)!, 'createDesignFromRevision');
const FROM_PACKAGE = () =>
  method(CODE.get(DESIGN_SERVICE)!, 'createDesignFromPackage');
// every piece of code a design from a package runs through
const BRIDGE_CODE = () =>
  [BRIDGE(), FROM_PACKAGE(), CODE.get(HELPER)!].join('\n');

describe('Phase 6 package to design bridge (P6-01)', () => {
  it('one route makes a design from a revision, under that exact revision, and it is the package service that reads it', () => {
    const controller = CODE.get(CONTROLLER)!;
    expect(
      controller.match(
        /@Post\('\/packages\/:id\/revisions\/:revisionId\/designs'\)/g
      )
    ).toHaveLength(1);
    expect(users(/createDesignFromRevision\(/)).toEqual([
      CONTROLLER,
      PACKAGE_SERVICE,
    ]);
    expect(BRIDGE()).toMatch(
      /getRevisionForPackage\(\s*input\.organizationId,\s*input\.packageId,\s*input\.revisionId\s*\)/
    );
    expect(BRIDGE()).toMatch(/this\.verifiedRevisionContent\(row\)/);
    // the source is the row the server read, never a field of the request
    expect(BRIDGE()).toMatch(
      /source: \{ packageRevisionId: row\.id, contentHash: row\.contentHash \}/
    );
  });

  it('P601-1 no AI, provider, network or credit in any part of the bridge', () => {
    expect(BRIDGE_CODE()).not.toMatch(
      /AIExecution|AIWriting|AIConnection|AIOperation|ai\.execution|ai\.provider|generateText|openai|anthropic|\bfetch\(|safeFetch|credit|billing/i
    );
  });

  it('P601-2/RA4/RA5 no review, approval or policy is asked for: a design is not a handoff', () => {
    for (const part of [BRIDGE(), FROM_PACKAGE(), CODE.get(HELPER)!]) {
      expect(part).not.toMatch(
        /requireApprovedRevision|_contentStudioReviewService|_contentStudioEditorialPolicyService|isApprovalRequiredForHandoff|Handoff|handoff/
      );
    }
    for (const file of [TEMPLATE_SERVICE, PAGE_SET_SERVICE]) {
      expect(CODE.get(file)).not.toMatch(
        /requireApprovedRevision|ContentStudioReviewService|EditorialPolicy|Handoff/
      );
    }
    // the one place approval is enforced is still the handoff (P5-07)
    expect(users(/\.requireApprovedRevision\(/)).toEqual([
      `${CS}/content-studio.handoff.service.ts`,
    ]);
  });

  it('RA1/RA2/RA3/M13 nothing of the package review or approval reaches the design: no review, decision or state is written or copied', () => {
    expect(BRIDGE_CODE()).not.toMatch(
      /contentStudioReview|contentStudioApproval|approvalVersion|targetRevisionId|READY_FOR_APPROVAL|APPROVED/
    );
    expect(model('ContentStudioDesignProject')).not.toMatch(
      /review|approv|Review|Approv/
    );
  });

  it('P601-3/P601-4 no sync either way: the bridge writes no package, and no design code reads or writes a package draft', () => {
    expect(BRIDGE()).not.toMatch(
      /saveDraft|createRevision|updatePackage|archivePackage|getPackageForOrganization|getLatestRevision|latestRevisionNumber|\.draft\b/
    );
    for (const file of [
      DESIGN_SERVICE,
      DESIGN_REPOSITORY,
      TEMPLATE_SERVICE,
      PAGE_SET_SERVICE,
      HELPER,
    ]) {
      expect(CODE.get(file)).not.toMatch(
        /ContentStudioRepository\b|contentPackage\.|contentPackageRevision\.|saveDraftCompareAndSwap|draftVersion/
      );
    }
    // nothing follows the package after the copy: no job, event or watcher
    expect(BRIDGE_CODE()).not.toMatch(
      /Temporal|workflow|EventEmitter|@OnEvent|setInterval|cron/i
    );
  });

  it('P601-5 there is no design handoff: a handoff is only ever of a package revision', () => {
    expect(model('ContentStudioHandoff')).not.toMatch(/design/i);
    const routes = CODE.get(CONTROLLER)!.match(
      /@(Get|Post|Put|Patch|Delete)\('[^']+'\)/g
    )!;
    expect(routes.filter((route) => /handoff/i.test(route))).toEqual([
      "@Post('/packages/:id/revisions/:revisionId/handoffs')",
      "@Get('/handoffs/:handoffId')",
      "@Post('/handoffs/:handoffId/revoke')",
    ]);
  });

  it('P601-6/TP1/TP4/TP6/M17 no second template or page set system: the package path runs through the template and page set services themselves', () => {
    expect(BRIDGE()).toMatch(
      /_contentStudioDesignTemplateService\.instantiateTemplate\(/
    );
    expect(BRIDGE()).toMatch(
      /_contentStudioDesignPageSetService\.createDesignFromPageSet\(/
    );
    expect(BRIDGE()).toMatch(
      /_contentStudioDesignService\.createDesignFromPackage\(/
    );
    expect(users(/applyContentStudioDesignTemplateCustomization\(/)).toEqual([
      `${LIB}/content-studio/design/design.template.guidance.ts`,
      TEMPLATE_SERVICE,
    ]);
    expect(users(/instantiateContentStudioDesignPageSet\(/)).toEqual([
      // the editor adds a page set's pages to a draft (P4-17)
      'apps/frontend/src/components/content-studio/content-studio.design.editor.ts',
      `${LIB}/content-studio/design/design.package.source.ts`,
      `${LIB}/content-studio/design/design.page.set.ts`,
      PAGE_SET_SERVICE,
    ]);
    // one project-and-first-revision write for every design, from a package or not
    expect(users(/createProjectWithFirstRevision\(/)).toEqual([
      DESIGN_REPOSITORY,
      DESIGN_SERVICE,
    ]);
    expect(FROM_PACKAGE()).toMatch(/return this\.createDesign\(\{/);
  });

  it('P6PG1/P6PG6/M18 the project, its source and its first revision are written in one transaction, never around it', () => {
    const create = method(
      CODE.get(DESIGN_REPOSITORY)!,
      'createProjectWithFirstRevision'
    );
    expect(create).toMatch(
      /this\._transaction\.model\.\$transaction\(async \(tx\) =>/
    );
    expect(create).toMatch(/await tx\.contentStudioDesignProject\.create\(/);
    expect(create).toMatch(/await tx\.contentStudioDesignRevision\.create\(/);
    expect(create).not.toMatch(/this\._(project|revision)\.model/);
  });

  it('P601-7/M16 Design Document stays schema version 1, with no package in it', () => {
    expect(DESIGN_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(() =>
      parseContentStudioDesignDocument({
        schemaVersion: 1,
        brandKit: null,
        sourcePackageRevisionId: 'x',
        pages: [
          {
            id: 'p',
            name: '',
            width: 100,
            height: 100,
            background: {
              type: 'solid',
              color: { type: 'literal', value: '#ffffff' },
            },
            layers: [],
          },
        ],
      })
    ).toThrow();
    expect(
      CODE.get(`${LIB}/content-studio/design/design.document.ts`)
    ).not.toMatch(/sourcePackage|packageRevision|PackageSource/);
  });

  it('P601-8 Content Package is still v1 and v2, unchanged by the bridge', () => {
    expect(CONTENT_PACKAGE_SCHEMA_VERSION).toBe(1);
    expect(CONTENT_PACKAGE_GROUNDED_SCHEMA_VERSION).toBe(2);
    expect(
      CODE.get(`${LIB}/content-studio/content.package.draft.ts`)
    ).not.toMatch(/design|Design/);
  });

  it('P601-9/P5S-15 general posting, scheduling, publishing and the public API know nothing of it', () => {
    const general = PRODUCTION.filter(
      (file) =>
        file.startsWith('apps/orchestrator/') ||
        /\/prisma\/posts\/|\/integrations\/|public-api|posts\.controller|\/launches\/|new-launch/.test(
          file
        )
    );
    expect(general.length).toBeGreaterThan(50);
    for (const file of general) {
      expect([file, CODE.get(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /createDesignFromRevision|createDesignFromPackage|sourcePackageRevision|design\.package\.source|ContentStudioDesignFromPackage/
        ),
      ]);
    }
  });

  it('M3/M7/PV1/PV5 the source is written once, with the project, and never changed: no update, no route and no field for it', () => {
    expect(users(/sourcePackageRevisionId|sourcePackageContentHash/)).toEqual([
      DESIGN_REPOSITORY,
      DESIGN_SERVICE,
    ]);
    const repository = CODE.get(DESIGN_REPOSITORY)!;
    const create = method(repository, 'createProjectWithFirstRevision');
    expect(create).toMatch(
      /sourcePackageRevisionId: input\.source\?\.packageRevisionId \?\? null,\s*sourcePackageContentHash: input\.source\?\.contentHash \?\? null/
    );
    for (const name of [
      'updateProjectName',
      'archiveProject',
      'restoreProject',
      'createRevisionWithCompareAndSwap',
    ]) {
      expect(method(repository, name)).not.toMatch(/sourcePackage/);
    }
    expect(repository).not.toMatch(
      /contentStudioDesignProject\.(update|upsert)\(/
    );
    // M4: the service hands down exactly the source it was given, or null
    expect(method(CODE.get(DESIGN_SERVICE)!, 'createDesign')).toMatch(
      /source: input\.source\s*\?\s*\{\s*packageRevisionId: input\.source\.packageRevisionId,\s*contentHash: input\.source\.contentHash,\s*\}\s*:\s*null/
    );
    // and the controller's own design create never passes one
    const controller = CODE.get(CONTROLLER)!;
    const manual = controller.slice(
      controller.indexOf("@Post('/designs')"),
      controller.indexOf("@Get('/designs/:id')")
    );
    expect(manual).not.toMatch(/source/);
  });

  it('SEC4/SEC5/SEC6 the body names ids only: no text, document, hash, organization or creator field', () => {
    const dto = CODE.get(DTO)!;
    const fields = dto
      .slice(dto.indexOf('class CreateContentStudioDesignFromPackageDto'))
      .match(/^\s+(\w+)\??:/gm)!
      .map((line) => line.trim().replace(/\??:$/, ''));
    expect(fields).toEqual([
      'name',
      'itemId',
      'canvas',
      'pageSetId',
      'templateSource',
      'templateId',
      'templateRevisionId',
      'templateRevisionNumber',
      'values',
      'textSlotId',
      'mediaId',
      'imageSlotId',
    ]);
  });

  it('PV7/M5/M6 the detail checks the stored source against exactly that revision, through the relation of the same organization', () => {
    expect(model('ContentStudioDesignProject')).toMatch(
      /sourcePackageRevision\s+ContentPackageRevision\?\s+@relation\(fields: \[sourcePackageRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    const source = method(CODE.get(DESIGN_SERVICE)!, 'private packageSource');
    expect(source).toMatch(/revision\.id !== row\.sourcePackageRevisionId/);
    expect(source).toMatch(
      /revision\.contentHash !== row\.sourcePackageContentHash/
    );
    expect(source).toMatch(/throw sourceIntegrityError\(\)/);
    expect(source).not.toMatch(/latest|findFirst|orderBy/);
  });
});

// Design Creative AI (P6-02) in one place: one route asks one suggestion for
// one exact saved design revision; the answer is operations on tokens of
// that document, never a document, and nothing of the design, its review,
// its provenance, a handoff or Media is written. The behavior is covered by
// design.ai.proposal.spec.ts, ai.design.prompt.spec.ts,
// content-studio.design-ai.service.spec.ts, the controller spec, the
// frontend spec and the PostgreSQL suite
const DESIGN_AI_SERVICE = `${CS}/content-studio.design-ai.service.ts`;
const PROPOSAL = `${LIB}/content-studio/design/design.ai.proposal.ts`;
const DESIGN_PROMPT = `${LIB}/content-studio/ai/ai.design.prompt.ts`;
const DESIGN_AI_DTO = `${LIB}/dtos/content-studio/content-studio.design-ai.dto.ts`;
const DESIGN_AI_PANEL =
  'apps/frontend/src/components/content-studio/content-studio.design-ai.tsx';
const EXECUTION = `${LIB}/content-studio/ai/ai.execution.service.ts`;
const DESIGN_AI_FILES = [
  DESIGN_AI_SERVICE,
  PROPOSAL,
  DESIGN_PROMPT,
  DESIGN_AI_DTO,
  DESIGN_AI_PANEL,
];
const AI_BASE = () => method(CODE.get(DESIGN_SERVICE)!, 'getDesignAIBase');

describe('Phase 6 Design Creative AI (P6-02)', () => {
  it('one route asks a suggestion for exactly one saved revision, answered by the design AI service', () => {
    const controller = CODE.get(CONTROLLER)!;
    expect(
      controller.match(
        /@Post\('\/designs\/:id\/revisions\/:revisionId\/ai\/propose'\)/g
      )
    ).toHaveLength(1);
    expect(users(/\.proposeDesign\(/)).toEqual([CONTROLLER]);
    expect(users(/\.executeForDesign\(/)).toEqual([DESIGN_AI_SERVICE]);
    expect(users(/\.getDesignAIBase\(/)).toEqual([DESIGN_AI_SERVICE]);
    // the revision of the route, of the design of the route, never the latest
    expect(AI_BASE()).toMatch(
      /getRevisionForProject\(\s*input\.organizationId,\s*project\.id,\s*input\.revisionId\s*\)/
    );
    expect(AI_BASE()).toMatch(
      /row\.revisionNumber !== project\.latestRevisionNumber[\s\S]*throw aiBaseStale\(\)/
    );
    expect(AI_BASE()).not.toMatch(/getRevisionByNumber|orderBy|findFirst/);
  });

  it('P602-1/M15 generation writes no design, revision, render, Media, review or package', () => {
    for (const part of [CODE.get(DESIGN_AI_SERVICE)!, AI_BASE()]) {
      expect(part).not.toMatch(
        /createDesign|createRevision|createProjectWithFirstRevision|CompareAndSwap|updateProject|archiveProject|restoreProject|renameDesign|render|Render|MediaService|uploadMedia|saveDraft|createHandoff/
      );
    }
    // the operation and its usage are the only rows written
    expect(CODE.get(DESIGN_AI_SERVICE)).not.toMatch(
      /_operation\b|\.create\(|\.update\(|\.upsert\(|\.delete\(/
    );
  });

  it('P602-2/P602-3/P602-4/M3 the prompt shows tokens: no id, Media reference, hash or URL is written into it', () => {
    const prompt = CODE.get(DESIGN_PROMPT)!;
    expect(prompt).not.toMatch(
      /imageRef|mediaId|sha256|contentHash|brandKitId|revisionId|organizationId|https?:/
    );
    // ids are only ever looked up to find their token
    expect(prompt.match(/\.id\b/g)).toEqual(['.id', '.id']);
  });

  it('P602-3/P602-5/M9/M10 the operations are a fixed list: no image source, mask, Media, URL, new layer, page or deletion', () => {
    const proposal = CODE.get(PROPOSAL)!;
    expect(proposal).toMatch(
      /DESIGN_AI_OPERATION_TYPES = \[\s*'set_text',\s*'set_text_style',\s*'set_shape_style',\s*'set_page_background',\s*'set_bounds',\s*\] as const/
    );
    // what the model may write: no field for an image, mask, fit or URL
    const model = proposal.slice(
      proposal.indexOf('const modelOperation'),
      proposal.indexOf('const modelProposal')
    );
    expect(model).not.toMatch(
      /imageRef|mediaId|sha256|mask|focalPoint|fit|url|href|svg|css|html|visible|opacity|rotation|layers|pages|delete|add/i
    );
    for (const file of DESIGN_AI_FILES) {
      expect(CODE.get(file)).not.toMatch(
        /\bfetch\(|safeFetch|axios|generateImage|images\.generate|dall-?e|imagen|stable.?diffusion|createSafeFetch/i
      );
    }
  });

  it('P602-6 Design Document stays schema version 1, with nothing of AI in it', () => {
    expect(DESIGN_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(
      CODE.get(`${LIB}/content-studio/design/design.document.ts`)
    ).not.toMatch(/AI|proposal|operationId|prompt/);
    // the revision gains only the back-relation of the operations on it
    expect(model('ContentStudioDesignRevision')).not.toMatch(
      /proposal|prompt|aiOperationId|\n\s+model\s+String/
    );
    expect(model('ContentStudioDesignRevision')).toMatch(
      /\n\s+aiOperations\s+ContentStudioAIOperation\[\]\n/
    );
    expect(model('ContentStudioDesignProject')).not.toMatch(/ai|AI/);
  });

  it('P602-7/PS2 the package provenance of a design is read, never written, by the AI path', () => {
    const service = CODE.get(DESIGN_AI_SERVICE)!;
    expect(service).not.toMatch(
      /sourcePackageRevisionId|sourcePackageContentHash/
    );
    expect(AI_BASE()).toMatch(/this\.packageSource\(project\)/);
    expect(AI_BASE()).not.toMatch(
      /sourcePackageRevisionId:|sourcePackageContentHash:/
    );
  });

  it('P602-8/P602-9/M17 no review, approval or handoff: AI asks for none and changes none', () => {
    for (const part of [CODE.get(DESIGN_AI_SERVICE)!, AI_BASE()]) {
      expect(part).not.toMatch(
        /Review|review|Approv|approv|Handoff|handoff|EditorialPolicyService/
      );
    }
    expect(CODE.get(DESIGN_AI_PANEL)).not.toMatch(
      /approv|reviews\.api|ReviewStatus|handoff/i
    );
    expect(users(/\.requireApprovedRevision\(/)).toEqual([
      `${CS}/content-studio.handoff.service.ts`,
    ]);
  });

  it('P602-10 general posting, scheduling, publishing and the public API know nothing of it', () => {
    expect(
      users(/DesignAI|design-ai|executeForDesign|design_improve_copy/)
    ).toEqual(
      [
        CONTROLLER,
        DESIGN_AI_SERVICE,
        `${LIB}/database/prisma/database.module.ts`,
        DESIGN_AI_DTO,
        PROPOSAL,
        DESIGN_PROMPT,
        `${LIB}/content-studio/ai/ai.operation.types.ts`,
        EXECUTION,
        `${CS}/content-studio.design.service.ts`,
        DESIGN_AI_PANEL,
        'apps/frontend/src/components/content-studio/content-studio.design.workspace.tsx',
      ].sort()
    );
  });

  it('P602-11 the new code imports only what the repository already uses: no new dependency', () => {
    const packages = new Set<string>();
    for (const file of DESIGN_AI_FILES) {
      for (const [, specifier] of CODE.get(file)!.matchAll(/from '([^']+)'/g)) {
        if (!specifier.startsWith('@gitroom/')) {
          packages.add(specifier);
        }
      }
    }
    expect(Array.from(packages).sort()).toEqual([
      '@nestjs/common',
      'class-validator',
      'next/link',
      'react',
      'zod',
    ]);
  });

  it('M18 the connection is the organization one the user chose, read in the organization, with its own model: no environment', () => {
    const service = CODE.get(DESIGN_AI_SERVICE)!;
    expect(service).toMatch(
      /getConnectionForOrganization\(\s*input\.organizationId,\s*selection\.connectionId\s*\)/
    );
    expect(service).toMatch(
      /if \(!connection\) \{\s*throw connectionRequired\(\);/
    );
    expect(service).not.toMatch(/process\.env|ConfigService|OPENAI|ANTHROPIC/);
    expect(service).toMatch(/connection\.defaultModel/);
    expect(service).not.toMatch(/selection\.model|input\.model/);
    expect(model('ContentStudioAIOperation')).toMatch(
      /designRevision\s+ContentStudioDesignRevision\?\s+@relation\(fields: \[designRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
  });
});
