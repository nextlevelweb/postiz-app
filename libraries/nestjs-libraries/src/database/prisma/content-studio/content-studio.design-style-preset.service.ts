import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContentStudioDesignStylePresetRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-style-preset.repository';
import {
  ContentStudioDesignStylePresetError,
  DESIGN_STYLE_PRESET_DESCRIPTION_MAX,
  DESIGN_STYLE_PRESET_KINDS,
  DESIGN_STYLE_PRESET_NAME_MAX,
  parseContentStudioDesignStylePresetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';
import {
  ContentStudioDesignStylePresetIntegrityError,
  parseVerifiedContentStudioDesignStylePreset,
  storedContentStudioDesignStylePreset,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset.stored';
import {
  ContentStudioSystemDesignStylePreset,
  listContentStudioSystemDesignStylePresets,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.style.presets';

// Fixed messages only: never preset names, styles, ids, zod or Prisma
// errors. A preset of another organization is a plain 404
const notFound = () =>
  new HttpException(
    { msg: 'Style preset not found.', code: 'CS_NOT_FOUND' },
    404
  );
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const presetInvalid = () =>
  new HttpException(
    {
      msg: 'The style preset is invalid.',
      code: 'CS_DESIGN_STYLE_PRESET_INVALID',
    },
    400
  );
const presetArchived = () =>
  new HttpException(
    {
      msg: 'This style preset is archived.',
      code: 'CS_DESIGN_STYLE_PRESET_ARCHIVED',
    },
    409
  );
const kindMismatch = () =>
  new HttpException(
    {
      msg: 'A style preset keeps its kind.',
      code: 'CS_DESIGN_STYLE_PRESET_KIND_MISMATCH',
    },
    400
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored style preset data could not be read safely.',
      code: 'CS_DESIGN_STYLE_PRESET_INTEGRITY_ERROR',
    },
    500
  );

// Preset ids are Prisma uuid() values; anything else cannot exist (a
// built-in id is "system:…" and is never a row)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the editor lists a page of presets of one kind at a time
const PAGE_SIZE = 50;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface PresetRow {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  schemaVersion: number;
  content: string;
  contentHash: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// A built-in preset as the catalog shows it: never archived or changed
const systemSummary = (preset: ContentStudioSystemDesignStylePreset) => ({
  source: 'system' as const,
  id: preset.id,
  name: preset.name,
  description: preset.description,
  kind: preset.kind,
  archivedAt: null as Date | null,
  contentHash: preset.contentHash,
  content: preset.content,
});

// Line endings normalized, trimmed, within a length, no NUL or unpaired
// surrogate
const plainText = (value: unknown, max: number, required: boolean) => {
  if (value === undefined && !required) {
    return undefined;
  }
  const trimmed =
    typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : null;
  if (
    trimmed === null ||
    (required && !trimmed) ||
    trimmed.length > max ||
    trimmed.includes('\u0000') ||
    UNPAIRED_SURROGATE.test(trimmed)
  ) {
    throw invalidRequest();
  }
  return trimmed;
};

// Design style presets: reusable text and shape styles, of one organization
// (rows) or built in (code, the same everywhere, never changed by a route).
// Every member may create, change, archive, restore and use the
// organization's presets: no role, plan or billing check. A preset is Style
// Preset v1 only, checked by its parser (which checks every value as Design
// Document v1 does) and stored as canonical JSON with its hash. The editor
// applies a preset by copying its style into a layer of the draft; nothing
// here touches a design, a template, a Brand Kit, Media or a render, and a
// change to a preset reaches no design that used it before
@Injectable()
export class ContentStudioDesignStylePresetService {
  constructor(
    private _contentStudioDesignStylePresetRepository: ContentStudioDesignStylePresetRepository
  ) {}

  // The built-in presets (not when archived ones are asked for) and one page
  // of the organization's, of one kind or both
  async listPresets(input: {
    organizationId: string;
    kind?: string;
    archived: boolean;
    page: number;
  }) {
    if (
      input.kind !== undefined &&
      !(DESIGN_STYLE_PRESET_KINDS as string[]).includes(input.kind)
    ) {
      throw invalidRequest();
    }
    const filter = {
      organizationId: input.organizationId,
      kind: input.kind,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioDesignStylePresetRepository.listPresetsForOrganization(
        {
          ...filter,
          skip: (input.page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }
      ),
      this._contentStudioDesignStylePresetRepository.countPresetsForOrganization(
        filter
      ),
    ]);
    return {
      system: input.archived
        ? []
        : listContentStudioSystemDesignStylePresets()
            .filter((preset) => !input.kind || preset.kind === input.kind)
            .map(systemSummary),
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => this.presetDetail(row)),
    };
  }

  // The kind is the content's own
  async createPreset(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    description: unknown;
    content: unknown;
  }) {
    const name = plainText(
      input.name,
      DESIGN_STYLE_PRESET_NAME_MAX,
      true
    ) as string;
    const description = this.description(input.description);
    const stored = storedContentStudioDesignStylePreset(
      this.parseContent(input.content)
    );
    const row =
      await this._contentStudioDesignStylePresetRepository.createPreset({
        id: randomUUID(),
        organizationId: input.organizationId,
        name,
        description,
        createdById: input.userId,
        preset: stored,
      });
    return this.presetDetail(row);
  }

  // The name, the description and the style of an active preset, in place:
  // the style keeps the preset's kind. Designs that used the preset before
  // keep their own copied values
  async updatePreset(
    organizationId: string,
    id: string,
    input: { name: unknown; description: unknown; content: unknown }
  ) {
    const name = plainText(input.name, DESIGN_STYLE_PRESET_NAME_MAX, false);
    const description =
      input.description === undefined
        ? undefined
        : this.description(input.description);
    const content =
      input.content === undefined
        ? undefined
        : this.parseContent(input.content);
    if (
      name === undefined &&
      description === undefined &&
      content === undefined
    ) {
      throw invalidRequest();
    }
    const current = await this.getRow(organizationId, id);
    if (current.archivedAt) {
      throw presetArchived();
    }
    if (content && content.kind !== current.kind) {
      throw kindMismatch();
    }
    const { count } =
      await this._contentStudioDesignStylePresetRepository.updatePreset(
        organizationId,
        id,
        {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(content
            ? { preset: storedContentStudioDesignStylePreset(content) }
            : {}),
        }
      );
    const row = await this.getRow(organizationId, id);
    if (count === 0) {
      // archived meanwhile
      throw presetArchived();
    }
    return this.presetDetail(row);
  }

  // Archiving an archived preset (or restoring an active one) changes
  // nothing and returns it as it is
  async archivePreset(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignStylePresetRepository.archivePreset(
      organizationId,
      id,
      new Date()
    );
    return this.presetDetail(await this.getRow(organizationId, id));
  }

  async restorePreset(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignStylePresetRepository.restorePreset(
      organizationId,
      id
    );
    return this.presetDetail(await this.getRow(organizationId, id));
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioDesignStylePresetContent(input);
    } catch (err) {
      if (err instanceof ContentStudioDesignStylePresetError) {
        throw presetInvalid();
      }
      throw err;
    }
  }

  // Optional; empty is none
  private description(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }
    return plainText(value, DESIGN_STYLE_PRESET_DESCRIPTION_MAX, false) || null;
  }

  private assertId(id: unknown) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw notFound();
    }
  }

  private async getRow(organizationId: string, id: string) {
    this.assertId(id);
    const row =
      await this._contentStudioDesignStylePresetRepository.getPresetForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // Built field by field: no organization or creator leaves. The stored
  // style must still be exactly what was written
  private presetDetail(row: PresetRow) {
    let content;
    try {
      content = parseVerifiedContentStudioDesignStylePreset(row);
    } catch (err) {
      if (err instanceof ContentStudioDesignStylePresetIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return {
      source: 'organization' as const,
      id: row.id,
      name: row.name,
      description: row.description,
      kind: content.kind,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      contentHash: row.contentHash,
      content,
    };
  }
}
