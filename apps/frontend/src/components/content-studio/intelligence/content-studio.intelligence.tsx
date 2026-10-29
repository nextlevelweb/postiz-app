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
import { CompanyProfileSection } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.company-profile';
import { PROFILE_PARAM } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import { useConfirmLeave } from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import {
  CONTENT_STUDIO_SETUP_PATH,
  ContentStudioPage,
} from '@gitroom/frontend/components/content-studio/content-studio.shell';

export const CONTENT_STUDIO_INTELLIGENCE_PATH = '/content-studio/intelligence';

// The tab lives in the URL (?tab=), so a reload or the back button keeps it.
// Only these fixed names ever go there; anything else is the AI tab, the one
// every "connect AI" link opens. The order is the order of setting up:
// AI, who you are, how you sound, for whom, what you know, the rules
export const INTELLIGENCE_TABS = [
  'ai',
  'company',
  'writing',
  'audiences',
  'expertise',
  'editorial',
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
    company: t('content_studio_tab_company', 'Company'),
    writing: t('content_studio_tab_writing', 'Writing'),
    audiences: t('content_studio_tab_audiences', 'Audiences'),
    expertise: t('content_studio_tab_expertise', 'Expertise'),
    editorial: t('content_studio_tab_editorial', 'Editorial Policy'),
  };

  // another tab never keeps the open editor of this one, and never drops
  // its unsaved changes without asking
  const confirmLeave = useConfirmLeave();
  const select = useCallback(
    async (next: IntelligenceTab) => {
      if (!(await confirmLeave())) {
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      params.delete(PROFILE_PARAM);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams, confirmLeave]
  );

  return (
    <ContentStudioPage
      title={t('content_studio_brand_ai', 'Brand & AI')}
      description={t(
        'content_studio_brand_ai_subtitle',
        'What every AI suggestion in Content Studio starts from: your AI connection, who you are, how you sound and who you write for.'
      )}
      actions={
        <Link
          href={CONTENT_STUDIO_SETUP_PATH}
          className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
        >
          {t('content_studio_setup_run_again', 'Run setup assistant')}
        </Link>
      }
    >
      {/* A phone has no room for six tabs: one choice of the section
          instead, so none of them sits off screen */}
      <label className="sm:hidden flex flex-col gap-[6px]">
        <span className="text-[13px] text-textItemBlur">
          {t('content_studio_brand_ai_section', 'Section')}
        </span>
        <select
          className="bg-newBgColorInner h-[44px] px-[12px] border-newTableBorder border rounded-[8px] text-textColor text-[16px] font-[600]"
          value={tab}
          onChange={(event) => {
            const next = parseIntelligenceTab(event.target.value);
            if (next !== tab) {
              select(next);
            }
          }}
        >
          {INTELLIGENCE_TABS.map((key) => (
            <option key={key} value={key}>
              {labels[key]}
            </option>
          ))}
        </select>
      </label>
      <div
        role="tablist"
        aria-label={t('content_studio_brand_ai', 'Brand & AI')}
        className="hidden sm:flex gap-[8px] overflow-x-auto pb-[4px] shrink-0"
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
        {tab === 'company' && <CompanyProfileSection />}
        {tab === 'writing' && <WritingProfilesSection />}
        {tab === 'audiences' && <AudienceProfilesSection />}
        {tab === 'expertise' && <ExpertiseProfilesSection />}
        {tab === 'editorial' && <EditorialPolicySection />}
      </div>
    </ContentStudioPage>
  );
};
