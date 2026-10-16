import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { trimmedText } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  BRAND_FONT_STYLES,
  BRAND_FONT_WEIGHTS,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { DESIGN_FONT_FAMILY_MAX } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignRenderError,
  DESIGN_RENDER_FONT_MAX_BYTES,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';
import { validateContentStudioRenderFontBytes } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.fonts';
import { ContentStudioRenderFontRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.repository';
import { ContentStudioPrivateFontStorageError } from '@gitroom/nestjs-libraries/upload/content-studio.private-font.storage';
import { StoredAssetFactory } from '@gitroom/nestjs-libraries/upload/stored.asset.factory';

// Fixed messages only: never a family, file name, hash, storage key, path,
// bucket or storage message. A mapping of another organization is a plain
// 404; a refused manager is a plain 403 (HttpForbiddenException would log the
// user out)
const notFound = () =>
  new HttpException(
    { msg: 'Render font not found.', code: 'CS_NOT_FOUND' },
    404
  );
const adminRequired = () =>
  new HttpException(
    {
      msg: 'Only organization administrators can manage render fonts.',
      code: 'CS_RENDER_FONT_ADMIN_REQUIRED',
    },
    403
  );
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const fontInvalid = () =>
  new HttpException(
    { msg: 'The font file is invalid.', code: 'CS_RENDER_FONT_INVALID' },
    400
  );
const fontUnsupported = () =>
  new HttpException(
    {
      msg: 'The font file format is not supported.',
      code: 'CS_RENDER_FONT_UNSUPPORTED',
    },
    400
  );
const fontTooLarge = () =>
  new HttpException(
    { msg: 'The font file is too large.', code: 'CS_RENDER_FONT_TOO_LARGE' },
    413
  );
const fontLimit = () =>
  new HttpException(
    {
      msg: 'The organization has too many active render fonts.',
      code: 'CS_RENDER_FONT_LIMIT',
    },
    409
  );
const fontConflict = () =>
  new HttpException(
    {
      msg: 'The render font changed. Try again.',
      code: 'CS_RENDER_FONT_CONFLICT',
    },
    409
  );
export const renderFontStorageUnavailable = () =>
  new HttpException(
    {
      msg: 'Private render font storage is not configured.',
      code: 'CS_RENDER_FONT_STORAGE_UNAVAILABLE',
    },
    503
  );
const fontStorageFailed = () =>
  new HttpException(
    {
      msg: 'The render font could not be stored.',
      code: 'CS_RENDER_FONT_STORAGE_FAILED',
    },
    500
  );

// enabled mappings per organization: a render loads its fonts up front
export const RENDER_FONT_ACTIVE_MAX = 64;
// the renderer's font file limit (32 MiB)
export const RENDER_FONT_FILE_MAX_BYTES = DESIGN_RENDER_FONT_MAX_BYTES;

const MANAGER_ROLES: string[] = [Role.ADMIN, Role.SUPERADMIN];
// Mapping ids are uuids; anything else cannot exist
const MAPPING_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the family rule of a Design Document font: trimmed, 1-200 characters, case
// kept, so a mapping matches exactly what a design names
const fontFamily = trimmedText(DESIGN_FONT_FAMILY_MAX, 1);

const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// The organization as the auth middleware puts it on the request: `users`
// holds only the requesting user's own membership
export interface ContentStudioRenderFontActor {
  organization: {
    id: string;
    users?: Array<{ role?: string; disabled?: boolean; userId?: string }>;
  };
  user: { id: string };
}

interface MappingRow {
  id: string;
  family: string;
  weight: number;
  style: string;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Built field by field: no asset, hash, size, storage key or organization
const mappingSummary = (row: MappingRow) => ({
  id: row.id,
  family: row.family,
  weight: row.weight,
  style: row.style,
  disabledAt: row.disabledAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// Render fonts of an organization: which exact font file a design's family,
// weight and style is drawn with. Any member may list them; only ADMIN and
// SUPERADMIN members may upload, disable or enable (checked here from the
// request's own membership, as for AI connections; no CheckPolicies, plan or
// billing). An upload is checked with the renderer's own font rules, hashed
// by the server, stored once in private font storage (never Media, never a
// public URL) as a new immutable asset, and then becomes the enabled font of
// its tuple; the asset it replaces stays as it was, so renders that used it
// keep their exact provenance. Nothing is deleted
@Injectable()
export class ContentStudioRenderFontService {
  private _fontStorage =
    StoredAssetFactory.createContentStudioPrivateFontStorage();

  constructor(
    private _contentStudioRenderFontRepository: ContentStudioRenderFontRepository
  ) {}

  async listFonts(organizationId: string) {
    const rows =
      await this._contentStudioRenderFontRepository.listMappingsForOrganization(
        organizationId
      );
    return rows.map(mappingSummary);
  }

  // The file's name and declared type are not used: its bytes decide
  async uploadFont(
    actor: ContentStudioRenderFontActor,
    input: {
      family: unknown;
      weight: unknown;
      style: unknown;
      file: { buffer?: unknown } | undefined;
    }
  ) {
    this.assertManager(actor);
    const organizationId = actor.organization.id;
    const font = this.fontTuple(input);
    const bytes = input.file?.buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw fontInvalid();
    }
    if (bytes.length > RENDER_FONT_FILE_MAX_BYTES) {
      throw fontTooLarge();
    }
    let format: 'ttf' | 'otf';
    try {
      ({ format } = validateContentStudioRenderFontBytes(bytes));
    } catch (err) {
      if (
        err instanceof ContentStudioDesignRenderError &&
        err.code === 'FONT_ASSET_UNSUPPORTED'
      ) {
        throw fontUnsupported();
      }
      throw fontInvalid();
    }
    const sha256 = designRenderSha256(bytes);

    // refused before anything is stored when the tuple cannot be enabled;
    // the transaction checks again
    const current =
      await this._contentStudioRenderFontRepository.getMappingBySpec(
        organizationId,
        font
      );
    if (
      (!current || current.disabledAt) &&
      (await this._contentStudioRenderFontRepository.countActiveMappings(
        organizationId
      )) >= RENDER_FONT_ACTIVE_MAX
    ) {
      throw fontLimit();
    }

    const assetId = randomUUID();
    let storageKey: string;
    try {
      ({ storageKey } = await this._fontStorage.writeFontAsset({
        organizationId,
        assetId,
        bytes,
        extension: format,
      }));
    } catch (err) {
      if (
        err instanceof ContentStudioPrivateFontStorageError &&
        err.code === 'UNAVAILABLE'
      ) {
        throw renderFontStorageUnavailable();
      }
      throw fontStorageFailed();
    }

    // A failure from here on leaves the stored file without a row; it is
    // never referenced and never overwritten
    let result;
    try {
      result =
        await this._contentStudioRenderFontRepository.createAssetAndSetMapping({
          organizationId,
          createdById: actor.user.id,
          mappingId: randomUUID(),
          font,
          asset: {
            id: assetId,
            storageKey,
            sha256,
            byteSize: bytes.length,
            format,
          },
          activeLimit: RENDER_FONT_ACTIVE_MAX,
        });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw fontConflict();
      }
      throw err;
    }
    if (result.status === 'limit') {
      throw fontLimit();
    }
    return mappingSummary(result.mapping);
  }

  // Disabling a disabled mapping changes nothing. Its asset stays, and so do
  // the renders that used it
  async disableFont(actor: ContentStudioRenderFontActor, id: string) {
    this.assertManager(actor);
    this.assertId(id);
    const organizationId = actor.organization.id;
    await this._contentStudioRenderFontRepository.disableMapping(
      organizationId,
      id,
      new Date()
    );
    return mappingSummary(await this.getRow(organizationId, id));
  }

  // Enabling an enabled mapping changes nothing
  async enableFont(actor: ContentStudioRenderFontActor, id: string) {
    this.assertManager(actor);
    this.assertId(id);
    const organizationId = actor.organization.id;
    const result = await this._contentStudioRenderFontRepository.enableMapping(
      organizationId,
      id,
      RENDER_FONT_ACTIVE_MAX
    );
    if (result.status === 'not-found') {
      throw notFound();
    }
    if (result.status === 'limit') {
      throw fontLimit();
    }
    return mappingSummary(await this.getRow(organizationId, id));
  }

  // Exactly the Design Document font rules: the family trimmed (case kept),
  // a weight of 100-900 in steps of 100, normal or italic
  private fontTuple(input: {
    family: unknown;
    weight: unknown;
    style: unknown;
  }) {
    const family = fontFamily.safeParse(input.family);
    if (
      !family.success ||
      !(BRAND_FONT_WEIGHTS as readonly unknown[]).includes(input.weight) ||
      !(BRAND_FONT_STYLES as readonly unknown[]).includes(input.style)
    ) {
      throw invalidRequest();
    }
    return {
      family: family.data,
      weight: input.weight as number,
      style: input.style as string,
    };
  }

  // Exactly one membership, the requesting user's own, enabled, with a
  // manager role. Anything else is refused (the AI connection rule)
  private assertManager(actor: ContentStudioRenderFontActor) {
    const memberships = actor.organization.users;
    if (!Array.isArray(memberships) || memberships.length !== 1) {
      throw adminRequired();
    }
    const [membership] = memberships;
    if (
      !membership ||
      membership.disabled ||
      (membership.userId !== undefined &&
        membership.userId !== actor.user.id) ||
      !MANAGER_ROLES.includes(membership.role as string)
    ) {
      throw adminRequired();
    }
  }

  private assertId(id: unknown) {
    if (typeof id !== 'string' || !MAPPING_ID.test(id)) {
      throw notFound();
    }
  }

  private async getRow(organizationId: string, id: string) {
    const row =
      await this._contentStudioRenderFontRepository.getMappingForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }
}
