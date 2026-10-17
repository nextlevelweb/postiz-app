import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { HttpException } from '@nestjs/common';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ContentStudioRenderMediaBridge } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-media.bridge';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';
import { StoredMediaReadError } from '@gitroom/nestjs-libraries/upload/stored.media.reader';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// only the organization-scoped lookup is used, mocked below
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const MARKER = 'DESIGN_EDITOR_MEDIA_PRIVATE_789';
const KIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REV_3 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const REV_7 = '3d6f0a8e-2b4c-4e1a-9f7d-5c8b2a6e4d10';
const STORED = Buffer.from(`STORED_IMAGE_BYTES ${MARKER}`);
const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

const kit = (brandName: string) =>
  parseContentStudioBrandKitContent({
    schemaVersion: 1,
    identity: { brandName, tagline: '', description: '' },
    colors: [{ id: 'ink', name: 'Ink', value: '#111111', role: 'text' }],
    typography: [],
    visualDirection: { keywords: [], dos: [], donts: [] },
  });

type MediaRow = {
  org: string;
  status?: string;
  path: string;
  deleted?: boolean;
};

const setup = () => {
  const media: Record<string, MediaRow> = {
    'photo-1': {
      org: ORG,
      path: `https://app.example.com/uploads/${MARKER}/a.png`,
    },
    busy: { org: ORG, status: 'processing', path: 'x' },
    failed: { org: ORG, status: 'failed', path: 'x' },
    foreign: { org: OTHER_ORG, path: 'y' },
    gone: { org: ORG, path: 'z', deleted: true },
  };
  const calls: string[] = [];
  const reader = {
    readStoredMediaBytes: jest.fn(async (location: string, max: number) => {
      calls.push(`read ${location} ${max}`);
      return Buffer.from(STORED);
    }),
  };
  jest
    .spyOn(StoredAssetFactory, 'createStoredMediaReader')
    .mockReturnValue(reader);
  const mediaService = {
    getMediaByIdForOrganization: jest.fn(async (org: string, id: string) => {
      calls.push(`lookup ${org} ${id}`);
      const row = media[id];
      // the real lookup filters on organizationId and deletedAt null
      return row && row.org === org && !row.deleted
        ? {
            id,
            path: row.path,
            status: row.status ?? 'ready',
            name: MARKER,
            thumbnail: null,
            alt: null,
          }
        : null;
    }),
    getMediaById: jest.fn(),
    saveGeneratedFile: jest.fn(),
    deleteMedia: jest.fn(),
  };
  const bridge = new ContentStudioRenderMediaBridge(
    mediaService as unknown as MediaService
  );
  const revisions = [
    { id: REV_3, revisionNumber: 3, content: kit('Acme') },
    { id: REV_7, revisionNumber: 7, content: kit('Acme later') },
  ].map(({ id, revisionNumber, content }) => ({
    id,
    organizationId: ORG,
    brandKitId: KIT,
    revisionNumber,
    ...storedContentStudioBrandKitContent(content),
    createdAt: new Date(),
    createdBy: { id: 'u', name: MARKER },
  }));
  const kits = [{ id: KIT, organizationId: ORG, latestRevisionNumber: 7 }];
  const brandKits = {
    getBrandKitForOrganization: jest.fn(
      async (org: string) => kits.find((k) => k.organizationId === org) ?? null
    ),
    getRevisionForBrandKit: jest.fn(
      async (org: string, brandKitId: string, revisionId: string) =>
        revisions.find(
          (r) =>
            r.organizationId === org &&
            r.brandKitId === brandKitId &&
            r.id === revisionId
        ) ?? null
    ),
    getRevisionByNumber: jest.fn(),
    listRevisionsForBrandKit: jest.fn(),
    createRevisionWithCompareAndSwap: jest.fn(),
  };
  const service = new ContentStudioDesignReferenceService(
    mediaService as unknown as MediaService,
    bridge,
    brandKits as unknown as ContentStudioBrandKitRepository
  );
  return { service, mediaService, reader, calls, brandKits, revisions, kits };
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const http = err as HttpException;
    return { status: http.getStatus(), ...(http.getResponse() as object) };
  }
  throw new Error('expected a failure');
};

describe('ContentStudioDesignReferenceService Media references', () => {
  it('MDR1/MDR6/MDR7/MDR8/MDR10 an own ready Media: its id and the SHA-256 of its stored bytes, read through the trusted bridge', async () => {
    const { service, calls, reader } = setup();
    const ref = await service.getMediaReference(ORG, 'photo-1');
    expect(ref).toEqual({ mediaId: 'photo-1', sha256: sha(STORED) });
    expect(Object.keys(ref)).toEqual(['mediaId', 'sha256']);
    // the stored bytes, not the path text
    expect(ref.sha256).not.toBe(
      sha(`https://app.example.com/uploads/${MARKER}/a.png`)
    );
    expect(JSON.stringify(ref)).not.toMatch(/https?:|uploads|MARKER|png/);
    expect(calls).toEqual([
      `lookup ${ORG} photo-1`,
      `lookup ${ORG} photo-1`,
      `read https://app.example.com/uploads/${MARKER}/a.png 67108864`,
    ]);
    expect(reader.readStoredMediaBytes).toHaveBeenCalledTimes(1);
  });

  it('MDR2/MDR3/MDR4/M24 a foreign, missing, deleted or malformed Media is a plain 404 and nothing is read', async () => {
    const { service, reader, mediaService } = setup();
    for (const id of [
      'foreign',
      'missing',
      'gone',
      '../x',
      'https://evil.test/a.png',
      '',
    ]) {
      expect(await failure(service.getMediaReference(ORG, id))).toEqual({
        status: 404,
        msg: 'Not found.',
        code: 'CS_NOT_FOUND',
      });
    }
    expect(
      await failure(service.getMediaReference(OTHER_ORG, 'photo-1'))
    ).toMatchObject({
      status: 404,
    });
    expect(reader.readStoredMediaBytes).not.toHaveBeenCalled();
    expect(mediaService.getMediaById).not.toHaveBeenCalled();
    for (const [org] of mediaService.getMediaByIdForOrganization.mock.calls) {
      expect([ORG, OTHER_ORG]).toContain(org);
    }
  });

  it('MDR5 a Media that is not ready cannot be used, and is not read', async () => {
    const { service, reader } = setup();
    for (const id of ['busy', 'failed']) {
      expect(await failure(service.getMediaReference(ORG, id))).toEqual({
        status: 409,
        msg: 'This media item cannot be used in a design.',
        code: 'CS_DESIGN_MEDIA_UNAVAILABLE',
      });
    }
    expect(reader.readStoredMediaBytes).not.toHaveBeenCalled();
  });

  it('MDR11 a storage failure is a fixed read error, never the storage message', async () => {
    const { service, reader } = setup();
    for (const failing of [
      async () => {
        throw new StoredMediaReadError();
      },
      async () => {
        throw new Error(`/srv/private/${MARKER}`);
      },
      async () => Buffer.alloc(0),
    ]) {
      reader.readStoredMediaBytes.mockImplementationOnce(failing as never);
      const result = await failure(service.getMediaReference(ORG, 'photo-1'));
      expect(result).toEqual({
        status: 500,
        msg: 'The media item could not be read safely.',
        code: 'CS_DESIGN_MEDIA_READ_FAILED',
      });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
  });
});

describe('ContentStudioDesignReferenceService Brand Kit references', () => {
  it('BDR1/BDR2/BDR7/BDR8 the exact verified revision asked for, as the four reference fields only', async () => {
    const { service, revisions } = setup();
    const ref = await service.getBrandKitReference(ORG, REV_3);
    expect(ref).toEqual({
      brandKitId: KIT,
      revisionId: REV_3,
      revisionNumber: 3,
      contentHash: revisions[0].contentHash,
    });
    expect(Object.keys(ref)).toEqual([
      'brandKitId',
      'revisionId',
      'revisionNumber',
      'contentHash',
    ]);
    // an older revision stays itself, whatever the kit's latest is
    expect(ref.revisionNumber).not.toBe(7);
    expect(JSON.stringify(ref)).not.toMatch(
      /Acme|MARKER|DESIGN_EDITOR|content"/
    );
  });

  it('BDR3 a malformed, missing or foreign revision is a plain 404', async () => {
    const { service } = setup();
    for (const [org, id] of [
      [ORG, 'not-a-uuid'],
      [ORG, '11111111-1111-4111-8111-111111111111'],
      [OTHER_ORG, REV_3],
    ]) {
      expect(await failure(service.getBrandKitReference(org, id))).toEqual({
        status: 404,
        msg: 'Not found.',
        code: 'CS_NOT_FOUND',
      });
    }
  });

  it('BDR4/M28 a revision whose stored content no longer matches its hash is a fixed integrity error', async () => {
    const { service, revisions } = setup();
    // a valid kit, but not the bytes the hash names
    revisions[0].content = storedContentStudioBrandKitContent(
      kit(MARKER)
    ).content;
    const result = await failure(service.getBrandKitReference(ORG, REV_3));
    expect(result).toEqual({
      status: 500,
      msg: 'Stored Brand Kit data could not be read safely.',
      code: 'CS_BRAND_KIT_INTEGRITY_ERROR',
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('BDR6 changes nothing', async () => {
    const { service, brandKits, mediaService } = setup();
    await service.getBrandKitReference(ORG, REV_7);
    await service.getMediaReference(ORG, 'photo-1');
    expect(brandKits.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
    expect(mediaService.saveGeneratedFile).not.toHaveBeenCalled();
    expect(mediaService.deleteMedia).not.toHaveBeenCalled();
    const source = fs.readFileSync(
      path.join(__dirname, 'content-studio.design-reference.service.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /\.(create|update|delete|upsert|save|archive|restore)[A-Za-z]*\(|fetch\(|axios|readFile|createHash\(/
    );
    // the one SHA-256 helper the renderer uses
    expect(source).toContain('designRenderSha256(bytes)');
    expect(source.match(/readMediaBytesForOrganization\(/g)).toHaveLength(1);
    expect(source).toContain(
      'parseVerifiedContentStudioBrandKitRevision(revision)'
    );
  });
});
