import { Injectable } from '@nestjs/common';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

export interface ContentStudioMediaPreview {
  id: string;
  path: string;
  thumbnail: string | null;
  alt: string | null;
  status: string;
}

export interface ContentStudioResolvedMedia {
  id: string;
  path: string;
}

export type ContentStudioMediaUnavailableReason =
  | 'unavailable'
  | 'processing'
  | 'failed';

export interface ContentStudioMediaUnavailableItem {
  itemIndex: number;
  mediaIndex: number;
  reason: ContentStudioMediaUnavailableReason;
}

// Positions and reasons only: never a Media id, path or organization. A
// foreign, deleted or missing Media is the same 'unavailable'
export class ContentStudioMediaUnavailableError extends Error {
  readonly code = 'MEDIA_UNAVAILABLE';

  constructor(readonly items: ContentStudioMediaUnavailableItem[]) {
    super('Content Studio media is unavailable');
    this.name = 'ContentStudioMediaUnavailableError';
  }
}

type MediaRow = Awaited<
  ReturnType<MediaService['getMediaByIdForOrganization']>
>;

// Media.status is a plain string: anything but these exact values is
// treated as unavailable
const unavailableReason = (
  row: MediaRow | undefined
): ContentStudioMediaUnavailableReason | undefined => {
  if (!row) {
    return 'unavailable';
  }
  if (row.status === 'ready') {
    return undefined;
  }
  return row.status === 'processing' || row.status === 'failed'
    ? row.status
    : 'unavailable';
};

// Reads the Media a draft refers to, only through the organization-scoped
// lookup, and never changes it. Paths always come from the Media rows: a draft
// carries ids only
@Injectable()
export class ContentStudioMediaService {
  constructor(private _mediaService: MediaService) {}

  // Current state of every Media in the draft, for showing it in the editor.
  // null for a Media that is missing, deleted or of another organization
  async getPreviewMap(
    organizationId: string,
    draft: ContentPackageDraft
  ): Promise<Record<string, ContentStudioMediaPreview | null>> {
    const media = await this.lookUp(organizationId, draft);

    // fromEntries defines own keys, so an id such as "__proto__" is a plain key
    return Object.fromEntries(
      Array.from(media, ([id, row]) => [
        id,
        row
          ? {
              id: row.id,
              path: row.path,
              thumbnail: row.thumbnail,
              alt: row.alt,
              status: row.status,
            }
          : null,
      ])
    );
  }

  // The Media of every thread item, in order, for handing the draft to the
  // composer. Every Media must be ready; otherwise every position that is not
  // is reported in one ContentStudioMediaUnavailableError
  async resolveForHandoff(
    organizationId: string,
    draft: ContentPackageDraft
  ): Promise<ContentStudioResolvedMedia[][]> {
    const media = await this.lookUp(organizationId, draft);

    const problems: ContentStudioMediaUnavailableItem[] = [];
    const resolved = draft.copy.global.thread.map((item, itemIndex) =>
      item.mediaIds.flatMap((id, mediaIndex) => {
        const row = media.get(id);
        const reason = unavailableReason(row);
        if (!row || reason) {
          problems.push({
            itemIndex,
            mediaIndex,
            reason: reason ?? 'unavailable',
          });
          return [];
        }
        return [{ id: row.id, path: row.path }];
      })
    );

    if (problems.length) {
      throw new ContentStudioMediaUnavailableError(problems);
    }
    return resolved;
  }

  // One scoped lookup per distinct id, in the order the ids first appear
  private async lookUp(organizationId: string, draft: ContentPackageDraft) {
    const ids = [
      ...new Set(draft.copy.global.thread.flatMap((item) => item.mediaIds)),
    ];
    const rows = await Promise.all(
      ids.map((id) =>
        this._mediaService.getMediaByIdForOrganization(organizationId, id)
      )
    );
    return new Map(ids.map((id, index) => [id, rows[index]]));
  }
}
