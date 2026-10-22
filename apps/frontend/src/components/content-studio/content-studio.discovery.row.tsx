'use client';

import { FC, ReactNode } from 'react';
import Link from 'next/link';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import {
  contentStudioSourceHost,
  ContentStudioSourceDiscovery,
} from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import {
  ContentStudioCaptureBadge,
  sourcePagePath,
} from '@gitroom/frontend/components/content-studio/content-studio.sources';
import { ContentStudioUseInContent } from '@gitroom/frontend/components/content-studio/content-studio.package.modal';

const Badge: FC<{ children: ReactNode }> = ({ children }) => (
  <span className="px-[8px] rounded-full border border-newTableBorder text-[12px]">
    {children}
  </span>
);

// A page a feed found (P8-01 feed page, P8-02 News Radar): the title the
// feed gave it, else the page source's name, as plain text, opening the
// page's own source. Captured means the page has a version; a page without
// one is not captured, never "failed": it may not have been fetched yet, or
// may be archived. News Radar adds the feed that found it. A live captured
// page can be used in content (P8-03): that only opens the New package dialog
export const ContentStudioDiscoveryRow: FC<{
  discovery: ContentStudioSourceDiscovery;
  provenance?: ReactNode;
  lastSeen?: boolean;
}> = ({ discovery, provenance, lastSeen }) => {
  const t = useT();
  return (
    <li className="flex flex-col gap-[4px] border border-newTableBorder rounded-[8px] p-[12px] min-w-0">
      <Link
        href={sourcePagePath(discovery.source.id)}
        className="font-[600] break-words hover:underline"
      >
        {discovery.entryTitle ?? discovery.source.name}
      </Link>
      <div className="text-[13px] text-textItemBlur truncate">
        {contentStudioSourceHost(discovery.source.canonicalUrl)}
      </div>
      {provenance}
      <div className="text-[12px] text-textItemBlur flex flex-wrap items-center gap-x-[12px] gap-y-[2px]">
        <span>
          {t('content_studio_discovery_found', 'Found')}{' '}
          {formatDate(discovery.firstSeenAt)}
        </span>
        <span>
          {t('content_studio_feed_published', 'Published')}{' '}
          {discovery.publishedAt
            ? formatDate(discovery.publishedAt)
            : t('content_studio_discovery_published_unknown', 'Unknown')}
        </span>
        {lastSeen && (
          <span>
            {t('content_studio_feed_last_seen', 'Last seen')}{' '}
            {formatDate(discovery.lastSeenAt)}
          </span>
        )}
        <ContentStudioCaptureBadge
          latestVersionNumber={discovery.source.latestVersionNumber}
        />
        {discovery.source.archivedAt && (
          <Badge>{t('content_studio_archived', 'Archived')}</Badge>
        )}
      </div>
      <ContentStudioUseInContent source={discovery.source} />
    </li>
  );
};
