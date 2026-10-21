import fs from 'fs';
import path from 'path';
import { HttpException } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { ContentStudioGroundingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import { ContentStudioDesignTemplateRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.repository';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { ContentStudioDesignPageSetRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.repository';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioDesignDocumentV1,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { storedContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import { parseContentStudioDesignTemplateGuidance } from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';
import { storedContentStudioDesignTemplateGuidance } from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance.revision';
import { getContentStudioSystemDesignPageSet } from '@gitroom/nestjs-libraries/content-studio/design/design.system.page.sets';
import { DESIGN_PACKAGE_TEXT_LAYER_NAME } from '@gitroom/nestjs-libraries/content-studio/design/design.package.source';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// the reference service is a stand-in below
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// P6-01: a design from a saved package revision, through the real package,
// design, template and page set services. Only the repositories, the Media
// reference and the review side are stand-ins: the package revision is
// stored canonical JSON with its hash, read back and verified as in
// production; the design is made by the real template and page set code
// and checked by the real Design Document parser. PostgreSQL pins the
// foreign key, the transaction and the organization scope itself
// (content-studio.phase6.postgres.integration.spec.ts)

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const USER = 'user-1';
const PKG = '60100000-0000-4000-8000-0000000000a1';
const OTHER_PKG = '60100000-0000-4000-8000-0000000000a2';
const REV_3 = '60100000-0000-4000-8000-0000000000b3';
const REV_4 = '60100000-0000-4000-8000-0000000000b4';
const FOREIGN_REV = '60100000-0000-4000-8000-0000000000c1';
const OTHER_PKG_REV = '60100000-0000-4000-8000-0000000000c2';
const TEMPLATE = '60100000-0000-4000-8000-0000000000d1';
const TEMPLATE_REV = '60100000-0000-4000-8000-0000000000d2';
const PLAIN_TEMPLATE = '60100000-0000-4000-8000-0000000000d3';
const PLAIN_TEMPLATE_REV = '60100000-0000-4000-8000-0000000000d4';
const T = new Date('2026-10-21T10:00:00.000Z');
const SHA = (c: string) => c.repeat(64);
const PRIVATE = 'PACKAGE_COPY_PRIVATE_MARKER_601';
// exact text: outer spaces, blank lines, tabs, emoji, non-Latin script
const EXACT = `  Spring sale 🌸 ${PRIVATE}\n\n\tTwo lines — été 春\n  `;
const SECOND = 'The follow-up, never copied';

type Row = Record<string, any>;

// A stored package revision as the revision service writes it
const packageRevision = (input: {
  id: string;
  organizationId?: string;
  packageId?: string;
  revisionNumber: number;
  thread: Array<{ id: string; text: string; mediaIds?: string[] }>;
}) => {
  const content = parseContentPackageDraft({
    schemaVersion: 1,
    copy: {
      global: {
        thread: input.thread.map((item) => ({ mediaIds: [], ...item })),
      },
    },
  });
  const text = canonicalJson(content);
  return {
    organizationId: input.organizationId ?? ORG,
    id: input.id,
    packageId: input.packageId ?? PKG,
    packageName: 'Spring launch',
    revisionNumber: input.revisionNumber,
    schemaVersion: 1,
    content: text,
    contentHash: sha256Hex(text),
    origin: 'manual',
    sourceDraftVersion: input.revisionNumber,
    createdAt: T,
    createdBy: { id: USER, name: 'Ann' },
  };
};

const page = (layers: unknown[]) => ({
  id: 'page_1',
  name: '',
  width: 1080,
  height: 1080,
  background: { type: 'solid', color: { type: 'literal', value: '#ffffff' } },
  layers,
});
const textLayer = (id: string, text: string) => ({
  id,
  name: '',
  x: 0,
  y: 0,
  width: 500,
  height: 200,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'text',
  text,
  font: { type: 'family', family: 'Inter', weight: 400, style: 'normal' },
  fontSize: 32,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: { type: 'literal', value: '#000000' },
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
});
const imageLayer = (id: string, mediaId: string) => ({
  id,
  name: '',
  x: 0,
  y: 300,
  width: 1080,
  height: 700,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'image',
  imageRef: { type: 'media', mediaId, sha256: SHA('e') },
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.5 },
});

// An organization template with a text and an image field, and one without
// any field
const templateDocument = parseContentStudioDesignDocument({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    page([imageLayer('photo', 'm_template'), textLayer('title', 'Title')]),
  ],
});
const templateGuidance = parseContentStudioDesignTemplateGuidance(
  {
    schemaVersion: 1,
    brandRebinding: false,
    slots: [
      {
        id: 'title',
        type: 'text',
        label: 'Title',
        pageId: 'page_1',
        layerId: 'title',
        required: true,
        multiline: true,
      },
      {
        id: 'photo',
        type: 'image',
        label: 'Photo',
        pageId: 'page_1',
        layerId: 'photo',
        required: false,
      },
    ],
  },
  templateDocument
);
const plainDocument = parseContentStudioDesignDocument({
  schemaVersion: 1,
  brandKit: null,
  pages: [page([textLayer('own', 'The template’s own words')])],
});

const setup = () => {
  const state = {
    packageRevisions: [
      packageRevision({
        id: REV_3,
        revisionNumber: 3,
        thread: [
          { id: 'main', text: EXACT, mediaIds: ['m1', 'm2'] },
          { id: 'second', text: SECOND },
        ],
      }),
      packageRevision({
        id: REV_4,
        revisionNumber: 4,
        thread: [{ id: 'main', text: 'Version four' }],
      }),
      packageRevision({
        id: FOREIGN_REV,
        organizationId: OTHER_ORG,
        revisionNumber: 1,
        thread: [{ id: 'main', text: 'Theirs' }],
      }),
      packageRevision({
        id: OTHER_PKG_REV,
        packageId: OTHER_PKG,
        revisionNumber: 1,
        thread: [{ id: 'main', text: 'Another package' }],
      }),
    ] as Row[],
    projects: [] as Row[],
    revisions: [] as Row[],
  };
  // the package side: one read, scoped like the real query (organization,
  // package and revision). Nothing else exists, so nothing else is called
  const packages = {
    getRevisionForPackage: jest.fn(
      async (organizationId: string, packageId: string, id: string) => {
        const row = state.packageRevisions.find(
          (r) =>
            r.organizationId === organizationId &&
            r.packageId === packageId &&
            r.id === id
        );
        if (!row) {
          return null;
        }
        const { organizationId: _o, packageName: _n, ...rest } = row;
        return { ...rest };
      }
    ),
  };
  const designRepository = {
    createProjectWithFirstRevision: jest.fn(async (input: Row) => {
      const project = {
        id: input.designProjectId,
        organizationId: input.organizationId,
        name: input.name,
        latestRevisionNumber: 1,
        archivedAt: null,
        createdById: input.createdById,
        createdAt: T,
        updatedAt: T,
        sourcePackageRevisionId: input.source?.packageRevisionId ?? null,
        sourcePackageContentHash: input.source?.contentHash ?? null,
      };
      const revision = {
        id: input.revisionId,
        organizationId: input.organizationId,
        designProjectId: input.designProjectId,
        revisionNumber: 1,
        ...input.revision,
        createdAt: T,
      };
      state.projects.push(project);
      state.revisions.push(revision);
      const {
        organizationId: _o,
        createdById: _c,
        sourcePackageRevisionId: _s,
        sourcePackageContentHash: _h,
        ...summary
      } = project;
      return {
        project: summary,
        revision: {
          id: revision.id,
          revisionNumber: 1,
          schemaVersion: revision.schemaVersion,
          contentHash: revision.contentHash,
          createdAt: T,
        },
      };
    }),
    // like the relation of the same organization
    getProjectDetailForOrganization: jest.fn(
      async (organizationId: string, id: string) => {
        const row = state.projects.find(
          (p) => p.organizationId === organizationId && p.id === id
        );
        if (!row) {
          return null;
        }
        const source = state.packageRevisions.find(
          (r) =>
            r.organizationId === organizationId &&
            r.id === row.sourcePackageRevisionId
        );
        return {
          id: row.id,
          name: row.name,
          latestRevisionNumber: row.latestRevisionNumber,
          archivedAt: row.archivedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          sourcePackageRevisionId: row.sourcePackageRevisionId,
          sourcePackageContentHash: row.sourcePackageContentHash,
          sourcePackageRevision: source
            ? {
                id: source.id,
                packageId: source.packageId,
                revisionNumber: source.revisionNumber,
                contentHash: source.contentHash,
                package: { name: source.packageName },
              }
            : null,
        };
      }
    ),
    getRevisionByNumber: jest.fn(
      async (organizationId: string, designProjectId: string, n: number) => {
        const row = state.revisions.find(
          (r) =>
            r.organizationId === organizationId &&
            r.designProjectId === designProjectId &&
            r.revisionNumber === n
        );
        return row
          ? {
              id: row.id,
              revisionNumber: row.revisionNumber,
              schemaVersion: row.schemaVersion,
              contentHash: row.contentHash,
              content: row.content,
              createdAt: row.createdAt,
            }
          : null;
      }
    ),
  };
  // no organization here has a Brand Kit: no document below names one
  const brandKits = {
    getBrandKitForOrganization: jest.fn(async () => null),
    getRevisionForBrandKit: jest.fn(),
  };
  // RA1-RA5: approved, reviewed, refused or required: creating a design asks
  // none of it
  const reviews = {
    requireApprovedRevision: jest.fn(),
    getRevisionApprovalStatus: jest.fn(),
    getRevisionApprovalStatuses: jest.fn(),
    requestReview: jest.fn(),
    getReviewForTarget: jest.fn(),
  };
  const policy = {
    isApprovalRequiredForHandoff: jest.fn(async () => true),
  };
  const media: Record<string, string[]> = {
    [ORG]: ['m1', 'm2', 'm9', 'm_template'],
    [OTHER_ORG]: ['m_theirs'],
  };
  const references = {
    getMediaReference: jest.fn(async (organizationId: string, id: string) => {
      if (!media[organizationId]?.includes(id)) {
        throw new HttpException(
          { msg: 'Not found.', code: 'CS_NOT_FOUND' },
          404
        );
      }
      return { mediaId: id, sha256: SHA(id === 'm1' ? 'a' : 'b') };
    }),
    getBrandKitReference: jest.fn(),
  };
  const templateRow = (id: string, name: string) => ({
    id,
    name,
    description: null,
    latestRevisionNumber: 1,
    archivedAt: null,
    createdAt: T,
    updatedAt: T,
  });
  const templateRevision = (
    id: string,
    document: ContentStudioDesignDocumentV1,
    guidance: typeof templateGuidance | null
  ) => ({
    id,
    revisionNumber: 1,
    createdAt: T,
    ...storedContentStudioDesignDocument(document),
    ...storedContentStudioDesignTemplateGuidance(guidance),
  });
  const templateRepository = {
    getTemplateForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId !== ORG
          ? null
          : id === TEMPLATE
          ? templateRow(TEMPLATE, 'Photo post')
          : id === PLAIN_TEMPLATE
          ? templateRow(PLAIN_TEMPLATE, 'Plain')
          : null
    ),
    getRevisionForTemplate: jest.fn(
      async (organizationId: string, templateId: string, id: string) =>
        organizationId !== ORG
          ? null
          : templateId === TEMPLATE && id === TEMPLATE_REV
          ? templateRevision(TEMPLATE_REV, templateDocument, templateGuidance)
          : templateId === PLAIN_TEMPLATE && id === PLAIN_TEMPLATE_REV
          ? templateRevision(PLAIN_TEMPLATE_REV, plainDocument, null)
          : null
    ),
  };
  const pageSetRepository = {
    getPageSetForOrganization: jest.fn(async () => null),
  };
  const designs = new ContentStudioDesignService(
    designRepository as unknown as ContentStudioDesignRepository,
    brandKits as unknown as ContentStudioBrandKitRepository,
    reviews as unknown as ContentStudioReviewService
  );
  const templates = new ContentStudioDesignTemplateService(
    templateRepository as unknown as ContentStudioDesignTemplateRepository,
    designs,
    references as unknown as ContentStudioDesignReferenceService
  );
  const pageSets = new ContentStudioDesignPageSetService(
    pageSetRepository as unknown as ContentStudioDesignPageSetRepository,
    designs
  );
  const service = new ContentStudioService(
    packages as unknown as ContentStudioRepository,
    {} as ContentStudioMediaService,
    {} as ContentStudioGroundingService,
    reviews as unknown as ContentStudioReviewService,
    policy as unknown as ContentStudioEditorialPolicyService,
    designs,
    templates,
    pageSets
  );
  return {
    state,
    packages,
    designRepository,
    brandKits,
    reviews,
    policy,
    references,
    templateRepository,
    designs,
    templates,
    service,
  };
};

type Setup = ReturnType<typeof setup>;

const create = (
  s: Setup,
  body: Record<string, unknown>,
  where: Partial<{
    organizationId: string;
    packageId: string;
    revisionId: string;
  }> = {}
) =>
  s.service.createDesignFromRevision({
    organizationId: where.organizationId ?? ORG,
    userId: USER,
    packageId: where.packageId ?? PKG,
    revisionId: where.revisionId ?? REV_3,
    name: 'From the package',
    itemId: 'main',
    ...body,
  });

const httpError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const body = (err as HttpException).getResponse() as Row;
  // fixed messages: no package text, id, hash or name
  expect(JSON.stringify(body)).not.toMatch(
    new RegExp(
      [
        PRIVATE,
        'Spring',
        PKG,
        REV_3,
        REV_4,
        FOREIGN_REV,
        'm1',
        'main',
        '[0-9a-f]{64}',
      ].join('|')
    )
  );
  return { status: (err as HttpException).getStatus(), code: body.code };
};

const storedDocument = (s: Setup, projectId: string) =>
  JSON.parse(
    s.state.revisions.find((r) => r.designProjectId === projectId)!.content
  ) as ContentStudioDesignDocumentV1;

const noApprovalAsked = (s: Setup) => {
  for (const spy of [
    ...Object.values(s.reviews),
    s.policy.isApprovalRequiredForHandoff,
  ]) {
    expect(spy).not.toHaveBeenCalled();
  }
};

describe('a design from a saved package revision (P6-01): the exact source', () => {
  it('PD1/PV1/PV5/PV7/M1/M10 reads exactly the revision asked for, of this organization and package, never the latest', async () => {
    const s = setup();
    const created = (await create(s, { canvas: 'square' })) as Row;
    expect(s.packages.getRevisionForPackage).toHaveBeenCalledTimes(1);
    expect(s.packages.getRevisionForPackage).toHaveBeenCalledWith(
      ORG,
      PKG,
      REV_3
    );
    const revision3 = s.state.packageRevisions[0];
    expect(s.state.projects).toEqual([
      expect.objectContaining({
        id: created.id,
        organizationId: ORG,
        createdById: USER,
        sourcePackageRevisionId: REV_3,
        sourcePackageContentHash: revision3.contentHash,
      }),
    ]);
    // revision 4 is newer, and nothing of it is used
    expect(JSON.stringify(s.state.revisions)).not.toContain('Version four');
    const detail = (await s.designs.getDesign(ORG, created.id)) as Row;
    expect(detail.source).toEqual({
      packageId: PKG,
      packageName: 'Spring launch',
      packageRevisionId: REV_3,
      packageRevisionNumber: 3,
      packageContentHash: revision3.contentHash,
    });
  });

  it('SEC1/M10 a revision of another organization, or of another package, is a plain not found and nothing is made', async () => {
    const s = setup();
    expect(
      await httpError(
        create(s, { canvas: 'square' }, { revisionId: FOREIGN_REV })
      )
    ).toEqual({
      status: 404,
      code: 'CS_NOT_FOUND',
    });
    expect(
      await httpError(
        create(s, { canvas: 'square' }, { revisionId: OTHER_PKG_REV })
      )
    ).toEqual({
      status: 404,
      code: 'CS_NOT_FOUND',
    });
    expect(
      await httpError(
        create(s, { canvas: 'square' }, { organizationId: OTHER_ORG })
      )
    ).toEqual({ status: 404, code: 'CS_NOT_FOUND' });
    expect(s.state.projects).toEqual([]);
    expect(
      s.designRepository.createProjectWithFirstRevision
    ).not.toHaveBeenCalled();
  });

  it('a stored revision that is no longer exactly what was written is an integrity error, and nothing is made', async () => {
    const s = setup();
    s.state.packageRevisions[0].content =
      s.state.packageRevisions[0].content.replace('Spring', 'Autumn');
    expect(await httpError(create(s, { canvas: 'square' }))).toEqual({
      status: 500,
      code: 'CS_STORED_REVISION_INVALID',
    });
    expect(s.state.projects).toEqual([]);
  });

  it('PD2/CM5/M9 a thread item the revision does not have is refused, never another item instead', async () => {
    const s = setup();
    for (const itemId of ['missing', 'Main', 0, undefined]) {
      expect(await httpError(create(s, { canvas: 'square', itemId }))).toEqual({
        status: 400,
        code: 'CS_DESIGN_SOURCE_ITEM_NOT_FOUND',
      });
    }
    expect(s.state.projects).toEqual([]);
  });

  it('API3/API5 one starting point exactly; template fields without a template are refused before anything is read', async () => {
    const s = setup();
    for (const body of [
      {},
      { canvas: 'square', pageSetId: 'system:page-set-social-core' },
      { canvas: 'square', templateId: 'system:square-post' },
      { canvas: 'square', textSlotId: 'body' },
      { canvas: 'square', mediaId: 'm1' },
      { pageSetId: 'system:page-set-social-core', values: {} },
      { canvas: 'square', templateRevisionNumber: 2 },
    ]) {
      expect(await httpError(create(s, body))).toEqual({
        status: 400,
        code: 'CS_INVALID_REQUEST',
      });
    }
    expect(s.packages.getRevisionForPackage).not.toHaveBeenCalled();
    // and a size that is not one of the fixed ones
    expect(await httpError(create(s, { canvas: 'huge' }))).toEqual({
      status: 400,
      code: 'CS_INVALID_REQUEST',
    });
    expect(s.state.projects).toEqual([]);
  });
});

describe('a design from a saved package revision (P6-01): the content', () => {
  it('CM1/CM2/PD3/CM4 a canvas size: one blank page with the item’s exact text in a layer, and nothing of the other items', async () => {
    const s = setup();
    const created = (await create(s, { canvas: 'portrait' })) as Row;
    const document = storedDocument(s, created.id);
    expect(document.brandKit).toBeNull();
    expect(document.pages).toHaveLength(1);
    expect(document.pages[0]).toMatchObject({
      width: 1080,
      height: 1350,
      name: '',
    });
    expect(document.pages[0].layers).toEqual([
      expect.objectContaining({
        type: 'text',
        name: DESIGN_PACKAGE_TEXT_LAYER_NAME,
        text: EXACT,
        overflow: 'shrink',
      }),
    ]);
    expect(JSON.stringify(document)).not.toContain(SECOND);
    // the answer is an ordinary new design with its revision 1
    expect(created).toMatchObject({
      latestRevisionNumber: 1,
      currentRevision: { revisionNumber: 1, content: document },
    });
  });

  it('CM4 another item is used only when it is the one chosen', async () => {
    const s = setup();
    const created = (await create(s, {
      canvas: 'square',
      itemId: 'second',
    })) as Row;
    const text = JSON.stringify(storedDocument(s, created.id));
    expect(text).toContain(SECOND);
    expect(text).not.toContain(PRIVATE);
  });

  it('TP1/TP2/TP6/CM1/CM2 a built-in template: the text goes into the chosen field through the template code itself, the rest exactly as when the template is used', async () => {
    const s = setup();
    const fromPackage = (await create(s, {
      templateSource: 'system',
      templateId: 'system:square-post',
      templateRevisionNumber: 2,
      textSlotId: 'body',
      values: { headline: 'Given headline' },
    })) as Row;
    const used = (await s.templates.instantiateTemplate({
      organizationId: ORG,
      userId: USER,
      source: 'system',
      templateId: 'system:square-post',
      revisionId: undefined,
      revisionNumber: 2,
      name: 'Template only',
      values: { headline: 'Given headline', body: EXACT },
    })) as Row;
    expect(storedDocument(s, fromPackage.id)).toEqual(
      storedDocument(s, used.id)
    );
    const body = storedDocument(s, fromPackage.id).pages[0].layers.find(
      (layer) => layer.id === 'body'
    );
    expect(body).toMatchObject({ type: 'text', text: EXACT });
    // only the design from the package has a source
    expect(s.state.projects.map((p) => p.sourcePackageRevisionId)).toEqual([
      REV_3,
      null,
    ]);
  });

  it('a required field the package does not fill still needs its value, as for any use of the template', async () => {
    const s = setup();
    expect(
      await httpError(
        create(s, {
          templateSource: 'system',
          templateId: 'system:square-post',
          templateRevisionNumber: 2,
          textSlotId: 'body',
        })
      )
    ).toEqual({ status: 400, code: 'CS_DESIGN_TEMPLATE_FIELD_REQUIRED' });
  });

  it('TP2/M2/SEC5 the field for the text must be chosen, a text field of this template, and never also typed', async () => {
    const s = setup();
    for (const extra of [
      {},
      { textSlotId: 'nope' },
      { textSlotId: 'headline', values: { headline: 'typed instead' } },
    ]) {
      expect(
        await httpError(
          create(s, {
            templateSource: 'system',
            templateId: 'system:square-post',
            templateRevisionNumber: 2,
            ...extra,
          })
        )
      ).toEqual({ status: 400, code: 'CS_DESIGN_SOURCE_SLOT_INVALID' });
    }
    expect(s.state.projects).toEqual([]);
  });

  it('TP3 a template without text fields gets the text as a layer on its first page, and takes no field for it', async () => {
    const s = setup();
    const created = (await create(s, {
      templateSource: 'organization',
      templateId: PLAIN_TEMPLATE,
      templateRevisionId: PLAIN_TEMPLATE_REV,
    })) as Row;
    const layers = storedDocument(s, created.id).pages[0].layers;
    expect(layers.map((layer) => layer.id)[0]).toBe('own');
    expect(layers[0]).toMatchObject({ text: 'The template’s own words' });
    expect(layers[1]).toMatchObject({ type: 'text', text: EXACT });
    expect(
      await httpError(
        create(s, {
          templateSource: 'organization',
          templateId: PLAIN_TEMPLATE,
          templateRevisionId: PLAIN_TEMPLATE_REV,
          textSlotId: 'own',
        })
      )
    ).toEqual({ status: 400, code: 'CS_DESIGN_SOURCE_SLOT_INVALID' });
  });

  it('TP4 a page set: its pages as the page set makes them, the text on the first page only', async () => {
    const s = setup();
    const created = (await create(s, {
      pageSetId: 'system:page-set-social-core',
    })) as Row;
    const document = storedDocument(s, created.id);
    const pageSet = getContentStudioSystemDesignPageSet(
      'system:page-set-social-core'
    )!;
    expect(document.pages.map((p) => [p.name, p.width, p.height])).toEqual(
      pageSet.content.pages.map((p) => [p.name, p.width, p.height])
    );
    expect(document.pages[0].layers).toEqual([
      expect.objectContaining({ type: 'text', text: EXACT }),
    ]);
    expect(document.pages.slice(1).every((p) => !p.layers.length)).toBe(true);
    expect(document.brandKit).toBeNull();
  });

  it('TP5 no Brand Kit is read or chosen for a document that names none, and none is added', async () => {
    const s = setup();
    for (const body of [
      { canvas: 'square' },
      { pageSetId: 'system:page-set-social-core' },
      {
        templateSource: 'system',
        templateId: 'system:story',
        templateRevisionNumber: 2,
        textSlotId: 'headline',
      },
    ]) {
      const created = (await create(s, body)) as Row;
      expect(storedDocument(s, created.id).brandKit).toBeNull();
    }
    expect(s.brandKits.getBrandKitForOrganization).not.toHaveBeenCalled();
  });
});

describe('a design from a saved package revision (P6-01): Media', () => {
  const photoTemplate = {
    templateSource: 'organization',
    templateId: TEMPLATE,
    templateRevisionId: TEMPLATE_REV,
    textSlotId: 'title',
  };

  it('MD1/MD3 one Media of the item goes into the chosen image field, referenced by the server for the organization, once', async () => {
    const s = setup();
    const created = (await create(s, {
      ...photoTemplate,
      mediaId: 'm1',
      imageSlotId: 'photo',
    })) as Row;
    expect(s.references.getMediaReference).toHaveBeenCalledTimes(1);
    expect(s.references.getMediaReference).toHaveBeenCalledWith(ORG, 'm1');
    const layers = storedDocument(s, created.id).pages[0].layers;
    expect(layers.find((layer) => layer.id === 'photo')).toMatchObject({
      imageRef: { type: 'media', mediaId: 'm1', sha256: SHA('a') },
      // the template's crop and geometry stay
      fit: 'cover',
      y: 300,
    });
    expect(layers.find((layer) => layer.id === 'title')).toMatchObject({
      text: EXACT,
    });
  });

  it('MD2/SEC2/M11 a Media the item does not have is refused before anything is read; one the organization cannot read is refused too', async () => {
    const s = setup();
    // m9 is a Media of the organization, but not of this item
    expect(
      await httpError(
        create(s, { ...photoTemplate, mediaId: 'm9', imageSlotId: 'photo' })
      )
    ).toEqual({ status: 400, code: 'CS_DESIGN_SOURCE_MEDIA_INVALID' });
    expect(s.references.getMediaReference).not.toHaveBeenCalled();
    // the item names m2, but it is gone from the organization's Media
    s.references.getMediaReference.mockImplementationOnce(async () => {
      throw new HttpException({ msg: 'Not found.', code: 'CS_NOT_FOUND' }, 404);
    });
    expect(
      await httpError(
        create(s, { ...photoTemplate, mediaId: 'm2', imageSlotId: 'photo' })
      )
    ).toEqual({ status: 400, code: 'CS_DESIGN_SOURCE_MEDIA_INVALID' });
    expect(s.state.projects).toEqual([]);
  });

  it('MD4 no Media is used unless one is chosen: the template keeps its own image', async () => {
    const s = setup();
    const created = (await create(s, photoTemplate)) as Row;
    // the template's own image is copied as it is, as for any use of it
    expect(s.references.getMediaReference).not.toHaveBeenCalled();
    expect(
      storedDocument(s, created.id).pages[0].layers.find(
        (layer) => layer.id === 'photo'
      )
    ).toMatchObject({ imageRef: { mediaId: 'm_template' } });
    const blank = (await create(s, { canvas: 'square' })) as Row;
    expect(
      storedDocument(s, blank.id).pages[0].layers.some(
        (layer) => layer.type === 'image'
      )
    ).toBe(false);
  });

  it('an image needs an image field, and the field the person picked an image for is not also filled by the package', async () => {
    const s = setup();
    for (const extra of [
      { mediaId: 'm1' },
      { mediaId: 'm1', imageSlotId: 'title' },
      { imageSlotId: 'photo' },
      {
        mediaId: 'm1',
        imageSlotId: 'photo',
        values: { photo: { mediaId: 'm9', sha256: SHA('b') } },
      },
    ]) {
      expect(
        await httpError(create(s, { ...photoTemplate, ...extra }))
      ).toEqual({
        status: 400,
        code: 'CS_DESIGN_SOURCE_SLOT_INVALID',
      });
    }
    expect(s.state.projects).toEqual([]);
  });
});

describe('a design from a saved package revision (P6-01): provenance', () => {
  it('PD6/PD7/PV3 one revision may start many designs, each its own, each recording that revision', async () => {
    const s = setup();
    const a = (await create(s, { canvas: 'square' })) as Row;
    const b = (await create(s, { canvas: 'square' })) as Row;
    const c = (await create(s, {
      pageSetId: 'system:page-set-square-story',
    })) as Row;
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(new Set(s.state.revisions.map((r) => r.id)).size).toBe(3);
    expect(s.state.projects.map((p) => p.sourcePackageRevisionId)).toEqual([
      REV_3,
      REV_3,
      REV_3,
    ]);
  });

  it('PV2/PV7/F10 a newer package revision changes nothing of a design made from an older one', async () => {
    const s = setup();
    const created = (await create(s, { canvas: 'square' })) as Row;
    s.state.packageRevisions.push(
      packageRevision({
        id: '60100000-0000-4000-8000-0000000000b5',
        revisionNumber: 5,
        thread: [{ id: 'main', text: 'Five' }],
      })
    );
    const detail = (await s.designs.getDesign(ORG, created.id)) as Row;
    expect(detail.source).toMatchObject({
      packageRevisionId: REV_3,
      packageRevisionNumber: 3,
    });
    expect(JSON.stringify(detail.currentRevision.content)).toContain(PRIVATE);
  });

  it('PV4 a design created on its own has no source, as before', async () => {
    const s = setup();
    const created = (await s.designs.createDesign({
      organizationId: ORG,
      userId: USER,
      name: 'Manual',
      content: { schemaVersion: 1, brandKit: null, pages: [page([])] },
    })) as Row;
    expect(s.state.projects[0]).toMatchObject({
      sourcePackageRevisionId: null,
      sourcePackageContentHash: null,
    });
    expect(
      ((await s.designs.getDesign(ORG, created.id)) as Row).source
    ).toBeNull();
  });

  it('PV6/M6 a stored source that no longer matches its revision is an integrity error, never another revision', async () => {
    for (const tamper of [
      (p: Row) => (p.sourcePackageContentHash = SHA('f')),
      (p: Row) => (p.sourcePackageContentHash = null),
      (p: Row) => (p.sourcePackageRevisionId = REV_4),
      (p: Row) => (p.sourcePackageRevisionId = FOREIGN_REV),
      (p: Row) => (p.sourcePackageRevisionId = null),
      (p: Row) => (p.sourcePackageContentHash = SHA('A')),
    ]) {
      const s = setup();
      const created = (await create(s, { canvas: 'square' })) as Row;
      tamper(s.state.projects[0]);
      expect(await httpError(s.designs.getDesign(ORG, created.id))).toEqual({
        status: 500,
        code: 'CS_DESIGN_SOURCE_INTEGRITY_ERROR',
      });
    }
  });
});

describe('a design from a saved package revision (P6-01): review and approval', () => {
  it('RA1-RA5/M12/M13 creating a design asks for no review, approval or policy, and the new design has no review', async () => {
    const s = setup();
    // the policy would require approval for a handoff: a design is not one
    for (const body of [
      { canvas: 'square' },
      { pageSetId: 'system:page-set-social-core' },
      {
        templateSource: 'system',
        templateId: 'system:square-post',
        templateRevisionNumber: 2,
        textSlotId: 'headline',
      },
    ]) {
      await create(s, body);
    }
    expect(s.state.projects).toHaveLength(3);
    noApprovalAsked(s);
  });

  it('nothing of the package is written: the one read is all the package side sees', async () => {
    const s = setup();
    const before = JSON.stringify(s.state.packageRevisions);
    await create(s, { canvas: 'square' });
    expect(JSON.stringify(s.state.packageRevisions)).toBe(before);
    expect(Object.keys(s.packages)).toEqual(['getRevisionForPackage']);
  });
});

describe('a design from a saved package revision (P6-01): source boundaries', () => {
  const ROOT = path.resolve(__dirname, '../../../../../..');
  const code = (file: string) =>
    fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const SERVICE =
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.service.ts';
  const method = (() => {
    const text = code(SERVICE);
    const start = text.indexOf('async createDesignFromRevision(');
    return text.slice(start, text.indexOf('\n  }\n', start));
  })();

  it('P601-2/M12 the bridge asks for no approval, review or policy and calls no handoff', () => {
    expect(method).toContain('getRevisionForPackage(');
    expect(method).not.toMatch(
      /requireApprovedRevision|_contentStudioReviewService|_contentStudioEditorialPolicyService|isApprovalRequired|handoff|Handoff/
    );
  });

  it('P601-1 no AI, network or Media read in the bridge itself', () => {
    expect(method).not.toMatch(
      /AIExecution|AIWriting|generate|\bfetch\(|_contentStudioMediaService|getPreviewMap|resolveForHandoff/
    );
  });

  it('P601-3/P601-4/M14 reads the exact revision only: no draft, latest revision or package write', () => {
    expect(method).not.toMatch(
      /getPackageForOrganization|getLatestRevision|latestRevisionNumber|draft\b|saveDraft|createRevision|updatePackage|archivePackage/
    );
  });
});
