'use client';

import { FC, useCallback } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { AIConnectionsSection } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.ai-connections';
import { WritingProfilesSection } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.writing-profiles';
import { EditorialPolicySection } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.editorial-policy';
import { AudienceProfilesSection } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.audience-profiles';
import { ExpertiseProfilesSection } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.expertise-profiles';

export const CONTENT_STUDIO_INTELLIGENCE_PATH = '/content-studio/intelligence';

// The tab lives in the URL (?tab=), so a reload or the back button keeps it.
// Only these fixed names ever go there; anything else is the first tab
export const INTELLIGENCE_TABS = [
  'ai',
  'writing',
  'editorial',
  'audiences',
  'expertise',
] as const;
export type IntelligenceTab = (typeof INTELLIGENCE_TABS)[number];

export const parseIntelligenceTab = (value: string | null): IntelligenceTab =>
  (INTELLIGENCE_TABS as readonly string[]).includes(value as string)
    ? (value as IntelligenceTab)
    : 'ai';

// Brand & AI: the AI connections and the editorial context of the
// organization. Every member may open it and edit the editorial context; only
// the AI connection controls depend on the member's role
export const ContentStudioIntelligence: FC = () => {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseIntelligenceTab(searchParams.get('tab'));

  const labels: Record<IntelligenceTab, string> = {
    ai: t('content_studio_tab_ai', 'AI Connections'),
    writing: t('content_studio_tab_writing', 'Writing'),
    editorial: t('content_studio_tab_editorial', 'Editorial Policy'),
    audiences: t('content_studio_tab_audiences', 'Audiences'),
    expertise: t('content_studio_tab_expertise', 'Expertise'),
  };

  const select = useCallback(
    (next: IntelligenceTab) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[12px]">
        <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
          <h1 className="text-[20px] font-[600]">
            {t('content_studio_brand_ai', 'Brand & AI')}
          </h1>
          <div className="text-textItemBlur">
            {t(
              'content_studio_brand_ai_subtitle',
              'Your AI connections and the editorial context of your organization.'
            )}
          </div>
        </div>
        <Link
          href="/content-studio"
          className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
        >
          {t('content_studio', 'Content Studio')}
        </Link>
      </div>
      <div
        role="tablist"
        aria-label={t('content_studio_brand_ai', 'Brand & AI')}
        className="flex gap-[8px] overflow-x-auto pb-[4px] shrink-0"
      >
        {INTELLIGENCE_TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`content-studio-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`content-studio-panel-${key}`}
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
        id={`content-studio-panel-${tab}`}
        aria-labelledby={`content-studio-tab-${tab}`}
        className="flex flex-col min-w-0"
      >
        {tab === 'ai' && <AIConnectionsSection />}
        {tab === 'writing' && <WritingProfilesSection />}
        {tab === 'editorial' && <EditorialPolicySection />}
        {tab === 'audiences' && <AudienceProfilesSection />}
        {tab === 'expertise' && <ExpertiseProfilesSection />}
      </div>
    </div>
  );
};
