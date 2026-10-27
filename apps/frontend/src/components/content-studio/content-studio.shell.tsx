'use client';

import { FC, MouseEvent, ReactNode } from 'react';
import clsx from 'clsx';
import * as NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export const CONTENT_STUDIO_HOME_PATH = '/content-studio';
export const CONTENT_STUDIO_SETUP_PATH = '/content-studio/setup';

export type ContentStudioSection =
  | 'home'
  | 'sources'
  | 'radar'
  | 'creative'
  | 'reviews'
  | 'brand';

// The sections in the order of the work: create and continue content (home),
// gather material for it (sources, then what the feeds found), make visuals
// for it, get it approved, and last the configuration everything above reads
// (brand, voice, audiences and AI). Setup starts from the home page
const SECTIONS: Array<{
  key: ContentStudioSection;
  href: string;
  // other paths that belong to the section
  also?: string[];
}> = [
  { key: 'home', href: CONTENT_STUDIO_HOME_PATH },
  { key: 'sources', href: '/content-studio/sources' },
  { key: 'radar', href: '/content-studio/research' },
  {
    key: 'creative',
    href: '/content-studio/designs',
    also: ['/content-studio/templates'],
  },
  { key: 'reviews', href: '/content-studio/reviews' },
  {
    key: 'brand',
    href: '/content-studio/intelligence',
    also: [CONTENT_STUDIO_SETUP_PATH],
  },
];

const within = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(`${path}/`);

// The section a path belongs to; a package (/content-studio/<id>) is home
export const contentStudioSectionOf = (
  pathname: string
): ContentStudioSection =>
  SECTIONS.find(
    (section) =>
      section.key !== 'home' &&
      [section.href, ...(section.also || [])].some((path) =>
        within(pathname, path)
      )
  )?.key ?? 'home';

export const useContentStudioSectionLabels = (): Record<
  ContentStudioSection,
  string
> => {
  const t = useT();
  return {
    home: t('content_studio_nav_home', 'Home'),
    sources: t('content_studio_sources', 'Sources'),
    radar: t('content_studio_research', 'Research'),
    creative: t('content_studio_creative_studio', 'Creative Studio'),
    reviews: t('content_studio_nav_reviews', 'Reviews'),
    brand: t('content_studio_brand_ai', 'Brand & AI'),
  };
};

// Shown inside a link from the moment it is clicked until the next page is
// there, so a slow page never looks like a click that did nothing. Always
// rendered at a fixed size, so nothing moves when it appears
const Link = NextLink.default;
// a stand-in where the router offers no link status (tests that replace
// next/link): never pending
const useLinkStatus =
  NextLink.useLinkStatus ?? (() => ({ pending: false as boolean }));

export const ContentStudioLinkPending: FC<{ label: string }> = ({ label }) => {
  const t = useT();
  const { pending } = useLinkStatus();
  return (
    <span className="inline-flex w-[10px] h-[10px] shrink-0">
      <span
        aria-hidden="true"
        className={clsx(
          'w-[10px] h-[10px] rounded-full border-2 border-current border-t-transparent transition-opacity',
          pending ? 'opacity-100 animate-spin' : 'opacity-0'
        )}
      />
      {pending && (
        <span role="status" className="sr-only">
          {t('content_studio_opening', 'Opening')} {label}
        </span>
      )}
    </span>
  );
};

// The local navigation of every Content Studio list page
export const ContentStudioNav: FC = () => {
  const t = useT();
  const pathname = usePathname() || CONTENT_STUDIO_HOME_PATH;
  const active = contentStudioSectionOf(pathname);
  const labels = useContentStudioSectionLabels();
  return (
    <nav
      aria-label={t('content_studio', 'Content Studio')}
      className="flex gap-[4px] overflow-x-auto -mx-[4px] px-[4px] pb-[2px] shrink-0 border-b border-newTableBorder"
    >
      {SECTIONS.map((section) => {
        const current = section.key === active;
        return (
          <Link
            key={section.key}
            href={section.href}
            aria-current={current ? 'page' : undefined}
            className={clsx(
              'shrink-0 whitespace-nowrap flex items-center gap-[6px] px-[12px] h-[40px] -mb-[1px] border-b-2 text-[14px]',
              current
                ? 'border-[var(--brand-primary,#612ad5)] font-[600] text-newTextColor'
                : 'border-transparent text-textItemBlur hover:text-newTextColor'
            )}
          >
            {labels[section.key]}
            <ContentStudioLinkPending label={labels[section.key]} />
          </Link>
        );
      })}
    </nav>
  );
};

export interface ContentStudioCrumb {
  label: string;
  href?: string;
  // asked before following the link, e.g. to leave an editor safely;
  // navigation goes on only when it resolves true
  onLeave?: () => Promise<boolean>;
}

// Where a page sits: Content Studio, then each parent, then the page itself
// (not a link)
export const ContentStudioBreadcrumbs: FC<{
  crumbs: ContentStudioCrumb[];
  onLeave?: () => Promise<boolean>;
  navigate?: (href: string) => void;
}> = ({ crumbs, onLeave, navigate }) => {
  const t = useT();
  const all: ContentStudioCrumb[] = [
    {
      label: t('content_studio', 'Content Studio'),
      href: CONTENT_STUDIO_HOME_PATH,
    },
    ...crumbs,
  ];
  const follow =
    (crumb: ContentStudioCrumb) =>
    async (event: MouseEvent<HTMLAnchorElement>) => {
      const leave = crumb.onLeave || onLeave;
      if (!leave || !crumb.href || !navigate) {
        return;
      }
      event.preventDefault();
      if (await leave()) {
        navigate(crumb.href);
      }
    };
  return (
    <nav aria-label={t('content_studio_breadcrumb', 'Breadcrumb')}>
      <ol className="flex flex-wrap items-center gap-[6px] text-[13px] text-textItemBlur">
        {all.map((crumb, index) => {
          const last = index === all.length - 1;
          return (
            <li key={index} className="flex items-center gap-[6px] min-w-0">
              {index > 0 && <span aria-hidden="true">/</span>}
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="hover:underline hover:text-newTextColor break-words"
                  onClick={follow(crumb)}
                >
                  {crumb.label}
                  <ContentStudioLinkPending label={crumb.label} />
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className="break-words text-newTextColor"
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

// Every Content Studio list page: the section navigation, where the page
// sits, its title and one line on what it is for, and its actions. Detail
// pages use the breadcrumbs only
export const ContentStudioPage: FC<{
  title: ReactNode;
  description?: ReactNode;
  help?: ReactNode;
  crumbs?: ContentStudioCrumb[];
  actions?: ReactNode;
  children: ReactNode;
  // false inside a page that shows the navigation itself (Research tabs)
  nav?: boolean;
}> = ({ title, description, help, crumbs, actions, children, nav = true }) => (
  <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] min-w-0">
    {nav && <ContentStudioNav />}
    <div className="flex flex-wrap items-start gap-[12px]">
      <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
        {!!crumbs?.length && <ContentStudioBreadcrumbs crumbs={crumbs} />}
        <h1 className="text-[20px] font-[600] break-words">{title}</h1>
        {!!description && (
          <div className="text-textItemBlur">{description}</div>
        )}
        {!!help && <div className="text-[13px] text-textItemBlur">{help}</div>}
      </div>
      {!!actions && (
        <div className="flex flex-wrap items-center gap-[8px]">{actions}</div>
      )}
    </div>
    {children}
  </div>
);

// A quiet in-page loading state that says what is happening, for waits a
// user could mistake for a failed click. Stages are labels, never progress
export const ContentStudioLoading: FC<{ label: string; detail?: string }> = ({
  label,
  detail,
}) => (
  <div
    role="status"
    aria-live="polite"
    className="flex flex-1 flex-col items-center justify-center gap-[12px] py-[48px] text-center"
  >
    <span
      aria-hidden="true"
      className="w-[28px] h-[28px] rounded-full border-[3px] border-[var(--brand-primary,#612ad5)] border-t-transparent animate-spin"
    />
    <div className="font-[600]">{label}</div>
    {!!detail && <div className="text-[13px] text-textItemBlur">{detail}</div>}
  </div>
);

// The route loading state: which section is opening, never a percentage
export const ContentStudioRouteLoading: FC = () => {
  const t = useT();
  const pathname = usePathname() || CONTENT_STUDIO_HOME_PATH;
  const labels = useContentStudioSectionLabels();
  const section = contentStudioSectionOf(pathname);
  const creative = section === 'creative';
  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col min-w-0">
      <ContentStudioLoading
        label={`${t('content_studio_opening', 'Opening')} ${
          section === 'home'
            ? t('content_studio', 'Content Studio')
            : labels[section]
        }…`}
        detail={
          creative
            ? t(
                'content_studio_opening_editor',
                'Loading the editor. This can take a few seconds the first time.'
              )
            : undefined
        }
      />
    </div>
  );
};
