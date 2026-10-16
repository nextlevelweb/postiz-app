import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

// What anyone may see of a mapping: no asset id, hash, size or storage key
const MAPPING_SUMMARY = {
  id: true,
  family: true,
  weight: true,
  style: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// For loading the exact font a mapping points to; server side only
const ASSET_DETAIL = {
  id: true,
  storageKey: true,
  sha256: true,
  byteSize: true,
  format: true,
} as const;

// at most this many mappings are listed
export const RENDER_FONT_MAPPINGS_LIST_MAX = 500;

export interface ContentStudioRenderFontTuple {
  family: string;
  weight: number;
  style: string;
}

// Render fonts of an organization: immutable font assets (one uploaded file
// each, only ever created) and the mapping of each exact family, weight and
// style to the asset it currently uses. Every query filters on
// organizationId itself, so another organization's mapping or asset reads
// exactly like a missing one, and a mapping can only point to an asset of
// its own organization (composite foreign key). Nothing is deleted, and no
// asset is ever updated
@Injectable()
export class ContentStudioRenderFontRepository {
  constructor(
    private _asset: PrismaRepository<'contentStudioRenderFontAsset'>,
    private _mapping: PrismaRepository<'contentStudioRenderFontMapping'>,
    private _transaction: PrismaTransaction
  ) {}

  listMappingsForOrganization(organizationId: string) {
    return this._mapping.model.contentStudioRenderFontMapping.findMany({
      where: {
        organizationId,
      },
      orderBy: [
        { family: 'asc' },
        { weight: 'asc' },
        { style: 'asc' },
        { id: 'asc' },
      ],
      select: MAPPING_SUMMARY,
      take: RENDER_FONT_MAPPINGS_LIST_MAX,
    });
  }

  getMappingForOrganization(organizationId: string, id: string) {
    return this._mapping.model.contentStudioRenderFontMapping.findFirst({
      where: {
        id,
        organizationId,
      },
      select: MAPPING_SUMMARY,
    });
  }

  // The mapping of exactly this family, weight and style, enabled or not
  getMappingBySpec(organizationId: string, font: ContentStudioRenderFontTuple) {
    return this._mapping.model.contentStudioRenderFontMapping.findFirst({
      where: {
        organizationId,
        family: font.family,
        weight: font.weight,
        style: font.style,
      },
      select: MAPPING_SUMMARY,
    });
  }

  // The enabled mapping of exactly this family, weight and style, with the
  // asset it points to at this moment
  getActiveMappingBySpec(
    organizationId: string,
    font: ContentStudioRenderFontTuple
  ) {
    return this._mapping.model.contentStudioRenderFontMapping.findFirst({
      where: {
        organizationId,
        family: font.family,
        weight: font.weight,
        style: font.style,
        disabledAt: null,
      },
      select: {
        id: true,
        family: true,
        weight: true,
        style: true,
        fontAsset: {
          select: ASSET_DETAIL,
        },
      },
    });
  }

  getFontAssetForOrganization(organizationId: string, id: string) {
    return this._asset.model.contentStudioRenderFontAsset.findFirst({
      where: {
        id,
        organizationId,
      },
      select: ASSET_DETAIL,
    });
  }

  countActiveMappings(organizationId: string) {
    return this._mapping.model.contentStudioRenderFontMapping.count({
      where: {
        organizationId,
        disabledAt: null,
      },
    });
  }

  // An uploaded font becomes the enabled font of its tuple, in one
  // transaction: the new asset is created and the tuple's mapping (created
  // with mappingId when there is none) points to it. A tuple that is not
  // enabled yet only becomes enabled while fewer than activeLimit mappings
  // are; otherwise nothing is written. The previous asset stays as it is
  createAssetAndSetMapping(input: {
    organizationId: string;
    createdById: string;
    mappingId: string;
    font: ContentStudioRenderFontTuple;
    asset: {
      id: string;
      storageKey: string;
      sha256: string;
      byteSize: number;
      format: string;
    };
    activeLimit: number;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const current = await tx.contentStudioRenderFontMapping.findFirst({
        where: {
          organizationId: input.organizationId,
          family: input.font.family,
          weight: input.font.weight,
          style: input.font.style,
        },
        select: { id: true, disabledAt: true },
      });
      if (!current || current.disabledAt) {
        const active = await tx.contentStudioRenderFontMapping.count({
          where: { organizationId: input.organizationId, disabledAt: null },
        });
        if (active >= input.activeLimit) {
          return { status: 'limit' as const };
        }
      }
      await tx.contentStudioRenderFontAsset.create({
        data: {
          id: input.asset.id,
          organizationId: input.organizationId,
          storageKey: input.asset.storageKey,
          sha256: input.asset.sha256,
          byteSize: input.asset.byteSize,
          format: input.asset.format,
          createdById: input.createdById,
        },
        select: { id: true },
      });
      const mapping = current
        ? await tx.contentStudioRenderFontMapping.update({
            where: { id: current.id, organizationId: input.organizationId },
            data: { fontAssetId: input.asset.id, disabledAt: null },
            select: MAPPING_SUMMARY,
          })
        : await tx.contentStudioRenderFontMapping.create({
            data: {
              id: input.mappingId,
              organizationId: input.organizationId,
              family: input.font.family,
              weight: input.font.weight,
              style: input.font.style,
              fontAssetId: input.asset.id,
              createdById: input.createdById,
            },
            select: MAPPING_SUMMARY,
          });
      return { status: 'set' as const, mapping };
    });
  }

  // Disabling a disabled mapping (or enabling an enabled one) changes
  // nothing. Neither touches the asset
  disableMapping(organizationId: string, id: string, disabledAt: Date) {
    return this._mapping.model.contentStudioRenderFontMapping.updateMany({
      where: {
        id,
        organizationId,
        disabledAt: null,
      },
      data: {
        disabledAt,
      },
    });
  }

  // Enables a disabled mapping while fewer than activeLimit mappings are
  // enabled, in one transaction
  enableMapping(organizationId: string, id: string, activeLimit: number) {
    return this._transaction.model.$transaction(async (tx) => {
      const current = await tx.contentStudioRenderFontMapping.findFirst({
        where: { id, organizationId },
        select: { disabledAt: true },
      });
      if (!current) {
        return { status: 'not-found' as const };
      }
      if (!current.disabledAt) {
        return { status: 'unchanged' as const };
      }
      const active = await tx.contentStudioRenderFontMapping.count({
        where: { organizationId, disabledAt: null },
      });
      if (active >= activeLimit) {
        return { status: 'limit' as const };
      }
      await tx.contentStudioRenderFontMapping.updateMany({
        where: { id, organizationId, disabledAt: { not: null } },
        data: { disabledAt: null },
      });
      return { status: 'enabled' as const };
    });
  }
}
