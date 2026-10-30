'use client';

import { FC, useCallback, useEffect, useRef } from 'react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  useIsModalOpen,
  useModals,
} from '@gitroom/frontend/components/layout/new-modal';
import { useCalendar } from '@gitroom/frontend/components/launches/calendar.context';
import {
  AddEditModal,
  AddEditModalProps,
} from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
dayjs.extend(utc);

// randomBytes(32) as hex, like the backend makes them
const HANDOFF_ID = /^[0-9a-f]{64}$/;

// The handoff this page load is opening or showing. Module level, so a
// StrictMode re-run or a remount of the launches tree can't open it twice,
// while a page reload starts clean. A failure worth retrying releases it at
// once; otherwise it is `done` (closed, or it can't open) and is let go when
// the URL no longer names it
let handoffGuard: { id: string; done: boolean } | null = null;

// Where a closed composer may send the user back to, by the `return`
// parameter of its handoff: a fixed list, never an address from the URL
const RETURN_PAGES: Record<string, string> = {
  // the first post (activation flow 01), which then sees what was scheduled
  'first-post': '/content-studio/first-post',
};
const returnPageOf = (page: string | null) =>
  page && Object.prototype.hasOwnProperty.call(RETURN_PAGES, page)
    ? RETURN_PAGES[page]
    : undefined;

// Removes `handoff` from the current URL, keeping every other parameter, and
// only while the URL still names this handoff. A handoff that came with a
// known `return` page goes back there instead
const useRemoveHandoffParam = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = useRef({ pathname, searchParams });
  useEffect(() => {
    location.current = { pathname, searchParams };
  }, [pathname, searchParams]);

  return useCallback(
    (handoffId: string) => {
      const current = location.current;
      if (current.searchParams.get('handoff') !== handoffId) {
        return;
      }
      const back = returnPageOf(current.searchParams.get('return'));
      if (back) {
        router.push(back);
        return;
      }
      const params = new URLSearchParams(current.searchParams.toString());
      params.delete('handoff');
      const query = params.toString();
      router.replace(
        query ? `${current.pathname}?${query}` : current.pathname,
        { scroll: false }
      );
    },
    [router]
  );
};

// The composer of one handoff. However it closes (Escape, its close button,
// saving the post, closeAll) it unmounts, and that removes `handoff` from the
// URL. Until then the URL keeps it, so a reload opens the same revision again.
// Edits made in the composer are not kept over a reload. A handoff with a
// known return page has a visible way back to it above the composer, so
// the browser's Back is never the only one
const HandoffComposer: FC<AddEditModalProps & { handoffId: string }> = ({
  handoffId,
  ...props
}) => {
  const removeHandoffParam = useRemoveHandoffParam();
  const back = returnPageOf(useSearchParams().get('return'));
  const modal = useModals();
  const t = useT();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode unmounts and mounts again straight away: only a real close
      // counts
      setTimeout(() => {
        if (mounted.current) {
          return;
        }
        if (handoffGuard?.id === handoffId) {
          handoffGuard.done = true;
        }
        removeHandoffParam(handoffId);
      });
    };
  }, []);

  // closing unmounts the composer, which goes back to the return page;
  // only what was changed in the composer is left behind, the Content
  // Studio draft stays as it was
  const goBack = useCallback(async () => {
    if (
      await deleteDialog(
        t(
          'content_studio_handoff_back_confirm',
          'Go back to Content Studio? Changes made here are not kept; your Content Studio draft stays as it is.'
        ),
        t('content_studio_handoff_back_yes', 'Go back')
      )
    ) {
      modal.closeAll();
    }
  }, [modal, t]);

  if (!back) {
    return <AddEditModal {...props} />;
  }
  // the composer keeps its own layout: on a wide screen the way back sits
  // in its top margin, on a phone (no margin) above it
  return (
    <div className="relative flex flex-1 w-full h-full min-w-0 mobile:block mobile:h-auto">
      <div className="absolute top-[4px] start-[40px] z-[2] mobile:static mobile:px-[16px] mobile:pt-[8px] mobile:pb-[4px]">
        <button
          type="button"
          data-testid="content-studio-handoff-back"
          onClick={goBack}
          className="min-h-[32px] px-[12px] rounded-full bg-newBgColorInner border border-newTableBorder flex items-center gap-[6px] text-[14px] font-[600] text-newTextColor hover:underline"
        >
          <span aria-hidden="true">{'←'}</span>
          {t('content_studio_handoff_back', 'Back to Content Studio')}
        </button>
      </div>
      <AddEditModal {...props} />
    </div>
  );
};

// Opens /launches?handoff=<id> in the existing composer, seeded with the
// handoff's values. Nothing is selected, saved or scheduled: the user carries
// on in the composer as after "Create Post"
export const ContentStudioHandoffOpener: FC = () => {
  const handoffId = useSearchParams().get('handoff');
  const composerOpen = useIsModalOpen('add-edit-modal');
  const { integrations, reloadCalendarView } = useCalendar();
  const fetch = useFetch();
  const modal = useModals();
  const toaster = useToaster();
  const t = useT();
  const removeHandoffParam = useRemoveHandoffParam();
  const composerOpenNow = useRef(composerOpen);
  useEffect(() => {
    composerOpenNow.current = composerOpen;
  }, [composerOpen]);

  const closeCurrentPost = useCallback(() => {
    toaster.show(
      t(
        'content_studio_handoff_close_current',
        'Close the post you are editing before opening this Content Studio post'
      ),
      'warning'
    );
  }, []);

  const openHandoff = useCallback(
    async (id: string) => {
      // kept in the URL, and can be tried again
      const failed = () => {
        if (handoffGuard?.id === id) {
          handoffGuard = null;
        }
        toaster.show(
          t(
            'content_studio_handoff_open_error',
            'Could not open this Content Studio post'
          ),
          'warning'
        );
      };

      try {
        const response = await fetch(`/content-studio/handoffs/${id}`);
        if (!response.ok) {
          const { code } = await response.json().catch(() => ({}));
          // answers a retry won't change: the handoff leaves the URL
          const message =
            response.status === 404 && code === 'CS_NOT_FOUND'
              ? t(
                  'content_studio_handoff_missing',
                  'This Content Studio handoff could not be found'
                )
              : response.status === 410 && code === 'CS_HANDOFF_GONE'
              ? t(
                  'content_studio_handoff_gone',
                  'This Content Studio handoff has expired or was revoked. Open it again from Content Studio.'
                )
              : response.status === 400 && code === 'CS_MEDIA_UNAVAILABLE'
              ? t(
                  'content_studio_handoff_media_unavailable',
                  'Some media in this Content Studio post is not ready or is no longer available.'
                )
              : undefined;
          if (!message) {
            failed();
            return;
          }
          if (handoffGuard?.id === id) {
            handoffGuard.done = true;
          }
          toaster.show(message, 'warning');
          removeHandoffParam(id);
          return;
        }
        const { onlyValues } = (await response.json()) as {
          onlyValues: AddEditModalProps['onlyValues'];
        };

        const slot = await fetch('/posts/find-slot');
        if (!slot.ok) {
          failed();
          return;
        }
        const { date } = await slot.json();

        // another handoff took over meanwhile
        if (handoffGuard?.id !== id) {
          return;
        }
        // a post was opened meanwhile: this one opens once it is closed
        if (composerOpenNow.current) {
          handoffGuard = null;
          closeCurrentPost();
          return;
        }

        // the same composer as "Create Post", without a set: the handoff's
        // values are the only content, and no channel is preselected
        modal.openModal({
          id: 'add-edit-modal',
          closeOnClickOutside: false,
          removeLayout: true,
          closeOnEscape: false,
          withCloseButton: false,
          askClose: true,
          fullScreen: true,
          classNames: {
            modal: 'w-[100%] max-w-[1400px] text-textColor',
          },
          children: (
            <HandoffComposer
              handoffId={id}
              allIntegrations={integrations.map((p) => ({
                ...p,
              }))}
              reopenModal={() => {}}
              mutate={reloadCalendarView}
              integrations={integrations}
              date={dayjs.utc(date).local()}
              onlyValues={onlyValues}
            />
          ),
          size: '80%',
          title: ``,
        });
      } catch {
        failed();
      }
    },
    [integrations, reloadCalendarView]
  );

  useEffect(() => {
    if (handoffGuard?.done && handoffGuard.id !== handoffId) {
      handoffGuard = null;
    }
    if (handoffId === null || handoffGuard?.id === handoffId) {
      return;
    }

    // never sent to the backend, and never shown
    if (!HANDOFF_ID.test(handoffId)) {
      handoffGuard = { id: handoffId, done: true };
      toaster.show(
        t(
          'content_studio_handoff_invalid',
          'This Content Studio link is not valid'
        ),
        'warning'
      );
      removeHandoffParam(handoffId);
      return;
    }

    // kept in the URL: it opens once a channel is connected
    if (!integrations.length) {
      toaster.show(
        t(
          'content_studio_handoff_connect_channel',
          'Connect a channel before opening this Content Studio post'
        ),
        'warning'
      );
      return;
    }

    // a post being written is never replaced, saved or not: kept in the URL,
    // it opens once that post is closed
    if (composerOpen) {
      closeCurrentPost();
      return;
    }

    handoffGuard = { id: handoffId, done: false };
    openHandoff(handoffId);
  }, [handoffId, integrations, composerOpen]);

  return null;
};
