'use client';

import { FC, ReactNode, useCallback, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  useModalCloseGuard,
  useModals,
} from '@gitroom/frontend/components/layout/new-modal';

// The one way Content Studio asks before unsaved changes are dropped
export const useConfirmDiscardChanges = () => {
  const t = useT();
  return useCallback(
    () =>
      deleteDialog(
        t(
          'content_studio_discard_changes_hint',
          'You have unsaved changes. Discard them?'
        ),
        t('content_studio_discard_changes', 'Discard changes'),
        t('content_studio_unsaved_changes', 'Unsaved changes'),
        t('content_studio_keep_editing', 'Keep editing')
      ),
    [t]
  );
};

// A form in a modal with unsaved changes: the backdrop, Escape, the close
// button and Cancel ask before closing. Call the returned release() right
// before close() once the form is saved, so a successful save closes without
// asking
export const useContentStudioDialogGuard = (dirty: boolean) => {
  const confirm = useConfirmDiscardChanges();
  const released = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useModalCloseGuard(
    async () => released.current || !dirtyRef.current || (await confirm())
  );
  return useCallback(() => {
    released.current = true;
  }, []);
};

// The pages that have unsaved changes right now, for in-page controls that
// leave them without a link (tabs, for one)
const unsaved = new Set<symbol>();

// Asks before an in-page control drops unsaved changes; true when there are
// none or the user discards them
export const useConfirmLeave = () => {
  const confirm = useConfirmDiscardChanges();
  return useCallback(async () => !unsaved.size || (await confirm()), [confirm]);
};

const isPlainLeftClick = (event: MouseEvent) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  !event.defaultPrevented;

// A page with unsaved changes: closing or reloading the tab gets the
// browser's own warning, and an in-app link asks first. Links that open in
// a new tab, other sites and downloads are left alone
export const useUnsavedChangesWarning = (dirty: boolean) => {
  const router = useRouter();
  const confirm = useConfirmDiscardChanges();
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const owner = Symbol('unsaved');
    unsaved.add(owner);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // older browsers show the prompt only with a returnValue
      event.returnValue = '';
    };
    const click = (event: MouseEvent) => {
      if (!isPlainLeftClick(event)) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        (anchor.target && anchor.target !== '_self') ||
        anchor.hasAttribute('download')
      ) {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        (url.pathname === window.location.pathname &&
          url.search === window.location.search)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      confirm().then((discard) => {
        if (discard) {
          window.removeEventListener('beforeunload', beforeUnload);
          router.push(`${url.pathname}${url.search}${url.hash}`);
        }
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => {
      unsaved.delete(owner);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
    };
  }, [dirty, confirm, router]);
};

// The body of a Content Studio dialog: it scrolls inside the viewport (mouse
// wheel, trackpad and keyboard alike) while the actions below it stay in
// view, at any window height
export const ContentStudioDialogLayout: FC<{
  children: ReactNode;
  footer?: ReactNode;
}> = ({ children, footer }) => (
  <div className="flex flex-col gap-[16px] min-w-0 w-full sm:w-[560px] max-w-full max-h-[calc(100dvh-170px)] sm:max-h-[calc(100dvh-230px)] xl:max-h-[calc(100dvh-380px)] [@media(max-height:600px)]:max-h-[calc(100dvh-120px)]">
    <div className="flex flex-col gap-[16px] flex-1 min-h-0 overflow-y-auto overscroll-contain pe-[4px] -me-[4px]">
      {children}
    </div>
    {!!footer && (
      <div className="flex flex-wrap gap-[8px] justify-end pt-[12px] border-t border-newTableBorder shrink-0">
        {footer}
      </div>
    )}
  </div>
);

// Content Studio pages never keep a dialog of the page they left: a link or
// an action in a dialog that opens another page also closes the dialog
export const ContentStudioCloseModalsOnNavigate: FC = () => {
  const pathname = usePathname();
  const { closeAll } = useModals();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    closeAll();
  }, [pathname]);
  return null;
};
