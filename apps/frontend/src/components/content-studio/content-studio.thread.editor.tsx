'use client';

import { FC, ReactNode, useCallback } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Textarea } from '@gitroom/react/form/textarea';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { MediaBox } from '@gitroom/frontend/components/media/media.component';
import {
  ContentStudioDraft,
  ContentStudioMediaPreview,
  ContentStudioThreadItem,
  ITEM_MEDIA_MAX,
  ITEM_TEXT_MAX,
  PACKAGE_UNIQUE_MEDIA_MAX,
  THREAD_ITEMS_MAX,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  contentPackageClaims,
  withoutContentPackageItemClaims,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

// Media ids are tokens, never paths or URLs (the API checks the same)
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

// 16 hex characters from the browser's random source: a valid thread item id
// (^[A-Za-z0-9_-]{1,32}$), unique within a draft
export const createThreadItemId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');

export const withThread = (
  draft: ContentStudioDraft,
  update: (thread: ContentStudioThreadItem[]) => ContentStudioThreadItem[]
): ContentStudioDraft => ({
  ...draft,
  copy: {
    ...draft.copy,
    global: { ...draft.copy.global, thread: update(draft.copy.global.thread) },
  },
});

const withItem = (
  draft: ContentStudioDraft,
  itemId: string,
  update: (item: ContentStudioThreadItem) => ContentStudioThreadItem
) =>
  withThread(draft, (thread) =>
    thread.map((item) => (item.id === itemId ? update(item) : item))
  );

// Grounded claims hold for the text they were made for. Editing an item's
// text or removing the item removes its claims: evidence is never kept for
// text it was not found for (the server refuses a draft that keeps them)
export const withoutItemClaims = (
  draft: ContentStudioDraft,
  itemIds: string[]
) => withoutContentPackageItemClaims(draft, itemIds) as ContentStudioDraft;

export const itemClaimCount = (draft: ContentStudioDraft, itemId: string) =>
  contentPackageClaims(draft).filter((claim) => claim.threadItemId === itemId)
    .length;

// One Media of a draft or revision, from the server's preview map (or the
// picker's answer until the next reload). Never a URL built from an id
export const ContentStudioMediaTile: FC<{
  preview: ContentStudioMediaPreview | null | undefined;
}> = ({ preview }) => {
  const t = useT();
  if (!preview) {
    return (
      <div className="w-[96px] h-[96px] rounded-[8px] border border-newTableBorder flex items-center justify-center text-center text-[12px] p-[4px]">
        {t('content_studio_media_unavailable', 'Unavailable media')}
      </div>
    );
  }
  const image =
    preview.thumbnail ||
    (hasExtension(preview.path, 'mp4') ? null : preview.path);
  return (
    <div className="relative w-[96px] h-[96px] rounded-[8px] border border-newTableBorder overflow-hidden flex items-center justify-center text-[12px]">
      {image ? (
        <img
          src={image}
          alt={preview.alt || ''}
          className="w-full h-full object-cover"
        />
      ) : (
        <span>{t('content_studio_media_video', 'Video')}</span>
      )}
      {(preview.status === 'processing' || preview.status === 'failed') && (
        <span className="absolute bottom-0 inset-x-0 bg-black/70 text-white text-center text-[11px] py-[2px]">
          {preview.status === 'processing'
            ? t('content_studio_media_processing', 'Processing')
            : t('content_studio_media_failed', 'Failed')}
        </span>
      )}
    </div>
  );
};

type PickedMedia = { id: string; path: string };

// The thread of the draft: plain text and Media ids per item. Every change
// goes through `edit`, which applies it to the latest draft (or refuses it
// while the editor is locked). itemActions adds controls to an item's header
export const ContentStudioThreadEditor: FC<{
  draft: ContentStudioDraft;
  media: Map<string, ContentStudioMediaPreview | null>;
  disabled: boolean;
  edit: (update: (draft: ContentStudioDraft) => ContentStudioDraft) => boolean;
  getDraft: () => ContentStudioDraft | null;
  addPreviews: (previews: ContentStudioMediaPreview[]) => void;
  itemActions?: (item: ContentStudioThreadItem, label: string) => ReactNode;
}> = ({ draft, media, disabled, edit, getDraft, addPreviews, itemActions }) => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const thread = draft.copy.global.thread;

  const refuse = useCallback(
    (message: string) => toaster.show(message, 'warning'),
    [toaster]
  );

  // Adds the picked Media to one item, all or nothing. Only ids enter the
  // draft; the paths only show the new tiles until the next reload
  const picked = useCallback(
    (itemId: string, selection: PickedMedia[]) => {
      const current = getDraft();
      const item = current?.copy.global.thread.find((i) => i.id === itemId);
      if (!current || !item || !selection.length) {
        return;
      }
      const ids = selection.map((m) => m.id);
      if (ids.some((id) => typeof id !== 'string' || !MEDIA_ID.test(id))) {
        refuse(t('content_studio_media_invalid', 'This media cannot be used.'));
        return;
      }
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => item.mediaIds.includes(id))
      ) {
        refuse(
          t(
            'content_studio_media_duplicate',
            'This media is already in this post.'
          )
        );
        return;
      }
      if (item.mediaIds.length + ids.length > ITEM_MEDIA_MAX) {
        refuse(
          t(
            'content_studio_media_item_limit',
            'A post can have up to 20 media.'
          )
        );
        return;
      }
      const distinct = new Set([
        ...current.copy.global.thread.flatMap((i) => i.mediaIds),
        ...ids,
      ]);
      if (distinct.size > PACKAGE_UNIQUE_MEDIA_MAX) {
        refuse(
          t(
            'content_studio_media_package_limit',
            'A package can use up to 50 different media.'
          )
        );
        return;
      }
      if (
        edit((latest) =>
          withItem(latest, itemId, (i) => ({
            ...i,
            mediaIds: [...i.mediaIds, ...ids],
          }))
        )
      ) {
        addPreviews(
          selection.map((m) => {
            const extra = m as PickedMedia & {
              thumbnail?: unknown;
              alt?: unknown;
              status?: unknown;
            };
            return {
              id: m.id,
              path: m.path,
              thumbnail:
                typeof extra.thumbnail === 'string' ? extra.thumbnail : null,
              alt: typeof extra.alt === 'string' ? extra.alt : null,
              status: typeof extra.status === 'string' ? extra.status : '',
            };
          })
        );
      }
    },
    [getDraft, edit, addPreviews, refuse, t]
  );

  // the existing media library, opened as the composer opens it
  const addMedia = useCallback(
    (itemId: string) => () => {
      modals.openModal({
        title: t('media_library', 'Media Library'),
        askClose: false,
        closeOnEscape: true,
        fullScreen: true,
        size: 'calc(100% - 80px)',
        height: 'calc(100% - 80px)',
        children: (close) => (
          <MediaBox
            setMedia={(selection) => picked(itemId, selection)}
            closeModal={close}
          />
        ),
      });
    },
    [modals, picked, t]
  );

  const moveMedia = (itemId: string, from: number, to: number) => () =>
    edit((latest) =>
      withItem(latest, itemId, (item) => {
        if (to < 0 || to >= item.mediaIds.length) {
          return item;
        }
        const mediaIds = [...item.mediaIds];
        [mediaIds[from], mediaIds[to]] = [mediaIds[to], mediaIds[from]];
        return { ...item, mediaIds };
      })
    );

  const removeMedia = (itemId: string, index: number) => () =>
    edit((latest) =>
      withItem(latest, itemId, (item) => ({
        ...item,
        mediaIds: item.mediaIds.filter((_, i) => i !== index),
      }))
    );

  const addFollowUp = () => {
    if (thread.length >= THREAD_ITEMS_MAX) {
      refuse(
        t('content_studio_thread_limit', 'A thread can have up to 25 posts.')
      );
      return;
    }
    edit((latest) =>
      latest.copy.global.thread.length >= THREAD_ITEMS_MAX
        ? latest
        : withThread(latest, (items) => [
            ...items,
            { id: createThreadItemId(), text: '', mediaIds: [] },
          ])
    );
  };

  const removeFollowUp = (itemId: string) => () =>
    edit((latest) =>
      latest.copy.global.thread.length <= 1
        ? latest
        : withoutItemClaims(
            withThread(latest, (items) => items.filter((i) => i.id !== itemId)),
            [itemId]
          )
    );

  return (
    <div className="flex flex-col gap-[24px]">
      {thread.map((item, index) => {
        const label =
          index === 0
            ? t('content_studio_main_post', 'Post')
            : `${t('content_studio_followup', 'Follow-up')} ${index}`;
        const claims = itemClaimCount(draft, item.id);
        return (
          <section
            key={item.id}
            aria-label={label}
            className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[16px]"
          >
            <div className="flex items-center gap-[8px]">
              <h3 className="flex-1 font-[600]">{label}</h3>
              {itemActions?.(item, label)}
              {index > 0 && (
                <Button
                  secondary
                  disabled={disabled}
                  aria-label={`${t(
                    'content_studio_remove_followup',
                    'Remove follow-up'
                  )} ${index}`}
                  onClick={removeFollowUp(item.id)}
                >
                  {t('content_studio_remove_followup', 'Remove follow-up')}
                </Button>
              )}
            </div>
            <Textarea
              label=""
              name={`text-${item.id}`}
              disableForm={true}
              aria-label={label}
              value={item.text}
              maxLength={ITEM_TEXT_MAX}
              disabled={disabled}
              onChange={(e) => {
                const text = e.target.value;
                const grounded = itemClaimCount(draft, item.id) > 0;
                if (
                  edit((latest) =>
                    withoutItemClaims(
                      withItem(latest, item.id, (i) => ({ ...i, text })),
                      [item.id]
                    )
                  ) &&
                  grounded
                ) {
                  toaster.show(
                    t(
                      'content_studio_grounding_removed_on_edit',
                      'The grounded claims of this post were removed because its text changed.'
                    ),
                    'warning'
                  );
                }
              }}
            />
            {claims > 0 && (
              <div
                className="text-[12px] text-textItemBlur"
                data-item-claims={claims}
              >
                {t(
                  'content_studio_grounding_item_hint',
                  'This post has grounded claims. Editing its text removes them.'
                )}{' '}
                ({claims})
              </div>
            )}
            <div className="flex flex-wrap gap-[12px] items-start">
              {item.mediaIds.map((mediaId, mediaIndex) => (
                <div
                  key={`${mediaId}-${mediaIndex}`}
                  className="flex flex-col gap-[4px] items-center"
                  data-media-id={mediaId}
                >
                  <ContentStudioMediaTile preview={media.get(mediaId)} />
                  <div className="flex gap-[4px]">
                    <button
                      type="button"
                      className="px-[6px] disabled:opacity-40"
                      disabled={disabled || mediaIndex === 0}
                      aria-label={`${t(
                        'content_studio_move_media_left',
                        'Move media left'
                      )} ${mediaIndex + 1}`}
                      onClick={moveMedia(item.id, mediaIndex, mediaIndex - 1)}
                    >
                      &larr;
                    </button>
                    <button
                      type="button"
                      className="px-[6px] disabled:opacity-40"
                      disabled={disabled}
                      aria-label={`${t(
                        'content_studio_remove_media',
                        'Remove media'
                      )} ${mediaIndex + 1}`}
                      onClick={removeMedia(item.id, mediaIndex)}
                    >
                      &times;
                    </button>
                    <button
                      type="button"
                      className="px-[6px] disabled:opacity-40"
                      disabled={
                        disabled || mediaIndex === item.mediaIds.length - 1
                      }
                      aria-label={`${t(
                        'content_studio_move_media_right',
                        'Move media right'
                      )} ${mediaIndex + 1}`}
                      onClick={moveMedia(item.id, mediaIndex, mediaIndex + 1)}
                    >
                      &rarr;
                    </button>
                  </div>
                </div>
              ))}
              <Button
                secondary
                disabled={disabled}
                aria-label={`${t('content_studio_add_media', 'Add media')} ${
                  index === 0 ? '' : index
                }`.trim()}
                onClick={addMedia(item.id)}
              >
                {t('content_studio_add_media', 'Add media')}
              </Button>
            </div>
          </section>
        );
      })}
      <div>
        <Button
          secondary
          disabled={disabled || thread.length >= THREAD_ITEMS_MAX}
          onClick={addFollowUp}
        >
          {t('content_studio_add_followup', 'Add follow-up')}
        </Button>
      </div>
    </div>
  );
};
