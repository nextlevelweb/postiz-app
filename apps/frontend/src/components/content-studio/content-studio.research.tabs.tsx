'use client';

import { FC, useCallback } from 'react';
import clsx from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { ContentStudioResearch } from '@gitroom/frontend/components/content-studio/content-studio.research';
import { ContentStudioPageChanges } from '@gitroom/frontend/components/content-studio/content-studio.page-changes';
import { ContentStudioNav } from '@gitroom/frontend/components/content-studio/content-studio.shell';

// The tab lives in the URL (?tab=), so a reload or the back button keeps it.
// No tab (or anything else) is News Radar, as the page always was; each tab
// keeps only its own filters, so switching starts the other one fresh
export const RESEARCH_TABS = ['radar', 'changes'] as const;
export type ResearchTab = (typeof RESEARCH_TABS)[number];

export const parseResearchTab = (value: string | null): ResearchTab =>
  value === 'changes' ? 'changes' : 'radar';

// Research (P8-04B1): News Radar and Changes, two read-only lists
export const ContentStudioResearchTabs: FC = () => {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseResearchTab(searchParams.get('tab'));

  const labels: Record<ResearchTab, string> = {
    radar: t('content_studio_news_radar', 'News Radar'),
    changes: t('content_studio_changes', 'Changes'),
  };

  const select = useCallback(
    (next: ResearchTab) => {
      router.replace(next === 'radar' ? pathname : `${pathname}?tab=${next}`, {
        scroll: false,
      });
    },
    [router, pathname]
  );

  return (
    <div className="bg-newBgColorInner flex flex-1 flex-col min-w-0">
      <div className="flex flex-col px-[20px] pt-[20px] mobile:px-[12px] mobile:pt-[12px]">
        <ContentStudioNav />
      </div>
      <div
        role="tablist"
        aria-label={t('content_studio_research', 'Research')}
        className="flex gap-[8px] overflow-x-auto px-[20px] pt-[16px] mobile:px-[12px] mobile:pt-[12px] shrink-0"
      >
        {RESEARCH_TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`content-studio-research-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`content-studio-research-panel-${key}`}
            className={clsx(
              'shrink-0 whitespace-nowrap rounded-full px-[14px] py-[10px] border border-newTableBorder',
              tab === key &&
                'bg-[var(--brand-primary)] text-[var(--brand-action-text)] border-[var(--brand-primary)]'
            )}
            onClick={() => {
              if (tab !== key) {
                select(key);
              }
            }}
          >
            {labels[key]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`content-studio-research-panel-${tab}`}
        aria-labelledby={`content-studio-research-tab-${tab}`}
        className="flex flex-1 flex-col min-w-0"
      >
        {tab === 'changes' ? (
          <ContentStudioPageChanges />
        ) : (
          <ContentStudioResearch />
        )}
      </div>
    </div>
  );
};
