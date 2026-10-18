import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const PRESET = {
  id: true,
  name: true,
  description: true,
  kind: true,
  schemaVersion: true,
  content: true,
  contentHash: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// A preset's style as the service canonicalized and hashed it
interface StoredPreset {
  schemaVersion: number;
  kind: string;
  content: string;
  contentHash: string;
}

// Style presets of an organization: every query filters on organizationId
// itself, so a preset of another organization reads exactly like a missing
// one (null or count 0). A preset is a mutable recipe: its name, description
// and style change in place while it is active; an archived one is
// read-only until it is restored. Nothing is deleted
@Injectable()
export class ContentStudioDesignStylePresetRepository {
  constructor(
    private _preset: PrismaRepository<'contentStudioDesignStylePreset'>
  ) {}

  listPresetsForOrganization(input: {
    organizationId: string;
    kind?: string;
    archived: boolean;
    skip: number;
    take: number;
  }) {
    return this._preset.model.contentStudioDesignStylePreset.findMany({
      where: {
        organizationId: input.organizationId,
        kind: input.kind,
        archivedAt: input.archived ? { not: null } : null,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: PRESET,
      skip: input.skip,
      take: input.take,
    });
  }

  countPresetsForOrganization(input: {
    organizationId: string;
    kind?: string;
    archived: boolean;
  }) {
    return this._preset.model.contentStudioDesignStylePreset.count({
      where: {
        organizationId: input.organizationId,
        kind: input.kind,
        archivedAt: input.archived ? { not: null } : null,
      },
    });
  }

  getPresetForOrganization(organizationId: string, id: string) {
    return this._preset.model.contentStudioDesignStylePreset.findFirst({
      where: {
        id,
        organizationId,
      },
      select: PRESET,
    });
  }

  createPreset(input: {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
    createdById: string;
    preset: StoredPreset;
  }) {
    return this._preset.model.contentStudioDesignStylePreset.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        kind: input.preset.kind,
        schemaVersion: input.preset.schemaVersion,
        content: input.preset.content,
        contentHash: input.preset.contentHash,
        createdById: input.createdById,
      },
      select: PRESET,
    });
  }

  // Only an active preset of the organization, and only of the same kind
  // when its style changes
  updatePreset(
    organizationId: string,
    id: string,
    details: {
      name?: string;
      description?: string | null;
      preset?: StoredPreset;
    }
  ) {
    return this._preset.model.contentStudioDesignStylePreset.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
        ...(details.preset ? { kind: details.preset.kind } : {}),
      },
      data: {
        ...(details.name === undefined ? {} : { name: details.name }),
        ...(details.description === undefined
          ? {}
          : { description: details.description }),
        ...(details.preset
          ? {
              schemaVersion: details.preset.schemaVersion,
              content: details.preset.content,
              contentHash: details.preset.contentHash,
            }
          : {}),
      },
    });
  }

  archivePreset(organizationId: string, id: string, archivedAt: Date) {
    return this._preset.model.contentStudioDesignStylePreset.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
      },
      data: {
        archivedAt,
      },
    });
  }

  restorePreset(organizationId: string, id: string) {
    return this._preset.model.contentStudioDesignStylePreset.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: { not: null },
      },
      data: {
        archivedAt: null,
      },
    });
  }
}
