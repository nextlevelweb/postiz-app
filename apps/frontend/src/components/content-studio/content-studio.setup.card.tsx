'use client';

import { FC, useEffect, useState } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { CONTENT_STUDIO_SETUP_PATH } from '@gitroom/frontend/components/content-studio/content-studio.shell';
import {
  CONTENT_STUDIO_SETUP_ITEMS,
  ContentStudioSetupItem,
  isContentStudioSetupHidden,
  loadContentStudioSetupDraft,
  setContentStudioSetupHidden,
  useContentStudioSetupStatus,
} from '@gitroom/frontend/components/content-studio/content-studio.setup.api';

export const useContentStudioSetupItemLabels = (): Record<
  ContentStudioSetupItem,
  string
> => {
  const t = useT();
  return {
    ai: t('content_studio_setup_item_ai', 'AI connected'),
    brand: t('content_studio_setup_item_brand', 'Company description'),
    voice: t('content_studio_setup_item_voice', 'Writing style'),
    audience: t('content_studio_setup_item_audience', 'Audience'),
    expertise: t('content_studio_setup_item_expertise', 'Expertise'),
    editorial: t('content_studio_setup_item_editorial', 'Editorial rules'),
  };
};

// One line per setup item, done or still open
export const ContentStudioSetupChecklist: FC<{
  done: Record<ContentStudioSetupItem, boolean>;
}> = ({ done }) => {
  const labels = useContentStudioSetupItemLabels();
  const t = useT();
  return (
    <ul className="flex flex-col gap-[6px]">
      {CONTENT_STUDIO_SETUP_ITEMS.map((item) => (
        <li key={item} className="flex items-center gap-[8px] text-[14px]">
          <span
            aria-hidden="true"
            className={clsx(
              'w-[20px] h-[20px] shrink-0 rounded-full flex items-center justify-center text-[12px] border',
              done[item]
                ? 'bg-[var(--brand-primary,#612ad5)] border-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)]'
                : 'border-newTableBorder'
            )}
          >
            {done[item] ? '✓' : ''}
          </span>
          <span className={clsx(!done[item] && 'text-textItemBlur')}>
            {labels[item]}
          </span>
          <span className="sr-only">
            {done[item]
              ? t('content_studio_setup_done', 'done')
              : t('content_studio_setup_open', 'not done yet')}
          </span>
        </li>
      ))}
    </ul>
  );
};

// The setup on the home page: a welcome with the setup assistant while
// nothing is set up, a progress card while some of it is, a single line once
// it is hidden, and nothing once everything is set up. What is done is read
// from the organization's data; only "hidden" and the unfinished assistant
// are kept, in this browser
export const ContentStudioSetupCard: FC<{ hasContent: boolean }> = ({
  hasContent,
}) => {
  const t = useT();
  const user = useUser();
  const status = useContentStudioSetupStatus();
  const organizationId = user?.orgId || '';
  // read after mount: storage is not there on the server
  const [hidden, setHidden] = useState<boolean | null>(null);
  const [resumable, setResumable] = useState(false);
  useEffect(() => {
    setHidden(isContentStudioSetupHidden(organizationId));
    setResumable(!!loadContentStudioSetupDraft(organizationId));
  }, [organizationId]);

  if (!status.loaded || hidden === null || status.complete) {
    return null;
  }

  const start = resumable
    ? t('content_studio_setup_continue', 'Continue setup')
    : t('content_studio_setup_start', 'Start setup');
  const progress = `${status.doneCount}/${status.total}`;

  if (hidden) {
    return (
      <div className="flex flex-wrap items-center gap-[8px] text-[14px] text-textItemBlur">
        <span>
          {t('content_studio_setup_progress', 'Setup')} {progress}
        </span>
        <Link
          href={CONTENT_STUDIO_SETUP_PATH}
          className="underline hover:text-newTextColor"
        >
          {start}
        </Link>
        <button
          type="button"
          className="underline hover:text-newTextColor"
          onClick={() => {
            setContentStudioSetupHidden(organizationId, false);
            setHidden(false);
          }}
        >
          {t('content_studio_setup_show', 'Show setup')}
        </button>
      </div>
    );
  }

  const welcome = !hasContent && status.doneCount <= 1;
  return (
    <section
      aria-labelledby="content-studio-setup-title"
      className={clsx(
        'flex flex-wrap gap-[24px] rounded-[16px] border border-newTableBorder',
        welcome ? 'p-[28px] mobile:p-[16px]' : 'p-[20px] mobile:p-[16px]'
      )}
    >
      <div className="flex flex-col gap-[12px] flex-1 min-w-[260px]">
        <h2
          id="content-studio-setup-title"
          className={clsx(
            'font-[600]',
            welcome ? 'text-[24px]' : 'text-[18px]'
          )}
        >
          {welcome
            ? t('content_studio_setup_welcome', 'Welcome to Content Studio')
            : t(
                'content_studio_setup_finish',
                'Finish setting up Content Studio'
              )}
        </h2>
        <p className="text-textItemBlur max-w-[620px]">
          {t(
            'content_studio_setup_pitch',
            'Tell us about your company in a few sentences. AI drafts your brand description, writing style, audiences and editorial rules; you review and adjust them. It takes about 5 minutes.'
          )}
        </p>
        {welcome && (
          <ol className="flex flex-wrap gap-x-[20px] gap-y-[6px] text-[14px]">
            {[
              t('content_studio_setup_step_ai', 'Connect AI'),
              t('content_studio_setup_step_company', 'Your company'),
              t('content_studio_setup_step_review', 'Review the AI draft'),
              t('content_studio_setup_step_ready', 'Ready to create'),
            ].map((label, index) => (
              <li key={label} className="flex items-center gap-[6px]">
                <span className="w-[22px] h-[22px] rounded-full bg-newBgLineColor flex items-center justify-center text-[12px] font-[600]">
                  {index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-[8px] pt-[4px]">
          <Link
            href={CONTENT_STUDIO_SETUP_PATH}
            className="h-[40px] px-[24px] flex items-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] font-[600]"
          >
            {start}
          </Link>
          <Button
            secondary
            onClick={() => {
              setContentStudioSetupHidden(organizationId, true);
              setHidden(true);
            }}
          >
            {t('content_studio_setup_skip', 'Skip for now')}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-[10px] min-w-[220px]">
        <div className="text-[13px] text-textItemBlur">
          {t('content_studio_setup_progress', 'Setup')} {progress}
        </div>
        <ContentStudioSetupChecklist done={status.done} />
      </div>
    </section>
  );
};
