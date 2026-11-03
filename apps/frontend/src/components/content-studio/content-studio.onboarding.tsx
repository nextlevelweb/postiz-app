'use client';

import {
  FC,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useContentStudioSetupStatus } from '@gitroom/frontend/components/content-studio/content-studio.setup.api';
import { useContentStudioDesigns } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import { useContentStudioEditorialPolicy } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import type { EditorialPolicyContent } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.editorial-policy';
import {
  ContentStudioFirstPost,
  FIRST_POST_PAGE,
  FirstPostSuccess,
  firstPostDraftDate,
  firstPostDraftPath,
  useContentStudioFirstPost,
} from '@gitroom/frontend/components/content-studio/content-studio.first-post';
import { CONTENT_STUDIO_HOME_PATH } from '@gitroom/frontend/components/content-studio/content-studio.shell';

// After the first post (activation flow 01): a short tour of Content Studio,
// once, starting with the research the user just used, then a checklist of
// useful first things to do in the other sections. Whether a task is done
// is read from the organization's own data; only "the tour was seen",
// "hide the checklist" and "no approval needed" are kept, in this browser
// and per organization, like the setup card. A first post saved as a
// draft is progress: the tour can be taken on purpose, and Home reminds
// the user to schedule it until it is scheduled or published

// --- this browser only ---

const tourKey = (organizationId: string) =>
  `content-studio-tour:${organizationId}`;
const checklistKey = (organizationId: string) =>
  `content-studio-checklist-hidden:${organizationId}`;
// Approval switched on is saved in the editorial policy; switched off is no
// workflow at all, the same as never looked at. So a deliberate "no approval
// needed" is kept here, the smallest record of that decision
const noApprovalKey = (organizationId: string) =>
  `content-studio-no-approval:${organizationId}`;

// Storage can be unavailable (private windows, blocked site data): then the
// tour can show again and nothing fails
const storage = () => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};
const read = (key: string) => {
  try {
    return storage()?.getItem(key) === '1';
  } catch {
    return false;
  }
};
const write = (key: string, on: boolean) => {
  try {
    if (on) {
      storage()?.setItem(key, '1');
    } else {
      storage()?.removeItem(key);
    }
  } catch {
    // shown again next time
  }
};

// The tour in this browser: never shown (nothing kept), skipped or
// completed. Either ends it for good; a "1" kept before the two were told
// apart counts as completed. A key of another organization never counts
export type ContentStudioTourState = 'never' | 'skipped' | 'completed';
export const contentStudioTourState = (
  organizationId: string
): ContentStudioTourState => {
  let value: string | null = null;
  try {
    value = storage()?.getItem(tourKey(organizationId)) ?? null;
  } catch {
    // shown again next time
  }
  return value === 'skipped' ? 'skipped' : value ? 'completed' : 'never';
};
export const isContentStudioTourSeen = (organizationId: string) =>
  contentStudioTourState(organizationId) !== 'never';
export const setContentStudioTourState = (
  organizationId: string,
  next: ContentStudioTourState
) => {
  try {
    if (next === 'never') {
      storage()?.removeItem(tourKey(organizationId));
    } else {
      storage()?.setItem(tourKey(organizationId), next);
    }
  } catch {
    // shown again next time
  }
};

// For this visit only (a browser session): "not now" to the reminder of a
// first post saved as a draft, and that the user went on exploring from it
const firstPostNotNowKey = (organizationId: string) =>
  `content-studio-first-post-not-now:${organizationId}`;
const firstPostExploredKey = (organizationId: string) =>
  `content-studio-first-post-explored:${organizationId}`;
const visit = () => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};
const readVisit = (key: string) => {
  try {
    return visit()?.getItem(key) === '1';
  } catch {
    return false;
  }
};
const writeVisit = (key: string) => {
  try {
    visit()?.setItem(key, '1');
  } catch {
    // asked again
  }
};

// --- the tour ---

export type ContentStudioTourSection =
  | 'radar'
  | 'home'
  | 'sources'
  | 'creative'
  | 'reviews';

// What was just used comes first; five steps, no more
export const CONTENT_STUDIO_TOUR: ContentStudioTourSection[] = [
  'radar',
  'home',
  'sources',
  'creative',
  'reviews',
];

// Below this width the step is a sheet at the bottom of the screen, never
// a popover next to a target that may sit at an edge
const SHEET_BELOW_PX = 640;
const CARD_WIDTH_PX = 360;
const EDGE_PX = 16;

const useTourSteps = () => {
  const t = useT();
  const steps: Record<
    ContentStudioTourSection,
    { title: string; text: string }
  > = {
    radar: {
      title: t('content_studio_tour_radar_title', 'Research starts in Radar'),
      text: t(
        'content_studio_tour_radar_after_first_post',
        'You just used research to create your first post. Radar is where Content Studio keeps an eye on new developments and content opportunities for your next posts.'
      ),
    },
    home: {
      title: t('content_studio_tour_home_title', 'Home'),
      text: t(
        'content_studio_tour_home',
        "Here you can see what's ready, what needs attention and what's coming up."
      ),
    },
    sources: {
      title: t('content_studio_tour_knowledge_title', 'Knowledge'),
      text: t(
        'content_studio_tour_knowledge',
        'Add trusted sources about your company, products and expertise so AI has stronger context.'
      ),
    },
    creative: {
      title: t('content_studio_tour_creative_title', 'Creative Studio'),
      text: t(
        'content_studio_tour_creative',
        'Create visuals that match your content and brand.'
      ),
    },
    reviews: {
      title: t('content_studio_tour_approvals_title', 'Approvals'),
      text: t(
        'content_studio_tour_approvals',
        'Review or approve content before it goes live.'
      ),
    },
  };
  return steps;
};

interface Placement {
  // the highlighted section in the navigation, when it is on the page
  target: { top: number; left: number; width: number; height: number } | null;
  sheet: boolean;
  card: { top: number; left: number; width: number } | null;
}

const place = (
  section: ContentStudioTourSection,
  cardHeight: number
): Placement => {
  const element = document.querySelector<HTMLElement>(
    `[data-cs-section="${section}"]`
  );
  const width = window.innerWidth;
  const sheet = width < SHEET_BELOW_PX;
  const rect = element?.getBoundingClientRect();
  const target =
    rect && rect.width
      ? {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        }
      : null;
  if (sheet || !target) {
    return { target, sheet: true, card: null };
  }
  const cardWidth = Math.min(CARD_WIDTH_PX, width - 2 * EDGE_PX);
  const left = Math.min(
    Math.max(target.left, EDGE_PX),
    width - cardWidth - EDGE_PX
  );
  const below = target.top + target.height + 12;
  const top =
    below + cardHeight > window.innerHeight - EDGE_PX
      ? Math.max(EDGE_PX, target.top - cardHeight - 12)
      : below;
  return { target, sheet: false, card: { top, left, width: cardWidth } };
};

// One step at a time: its section in the navigation is highlighted, and a
// card says what it is for, with Next and Skip tour. On a phone the card is
// a sheet at the bottom, so it can never leave the screen. Done after the
// last step completes it; Skip tour or Escape skips it
export const ContentStudioTour: FC<{
  onClose: (how: 'skipped' | 'completed') => void;
}> = ({ onClose }) => {
  const t = useT();
  const steps = useTourSteps();
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const section = CONTENT_STUDIO_TOUR[index];
  const last = index === CONTENT_STUDIO_TOUR.length - 1;

  const measure = useCallback(() => {
    setPlacement(place(section, card.current?.offsetHeight ?? 180));
  }, [section]);

  useLayoutEffect(() => {
    document
      .querySelector<HTMLElement>(`[data-cs-section="${section}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    measure();
    card.current?.focus();
  }, [section, measure]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose('skipped');
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.removeEventListener('keydown', escape);
    };
  }, [measure, onClose]);

  const step = steps[section];
  return (
    <>
      {!!placement?.target && (
        <div
          aria-hidden="true"
          data-testid="tour-highlight"
          className="fixed z-[200] pointer-events-none rounded-[8px] ring-2 ring-[var(--brand-primary,#612ad5)] ring-offset-2"
          style={{
            top: placement.target.top,
            left: placement.target.left,
            width: placement.target.width,
            height: placement.target.height,
          }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="tour-card"
        data-placement={placement?.sheet === false ? 'popover' : 'sheet'}
        className={
          placement?.sheet === false
            ? 'fixed z-[201] flex flex-col gap-[10px] p-[16px] rounded-[12px] border border-newTableBorder bg-newBgColorInner shadow-xl outline-none'
            : 'fixed z-[201] inset-x-0 bottom-0 mx-auto w-full max-w-[520px] flex flex-col gap-[10px] p-[16px] pb-[max(16px,env(safe-area-inset-bottom))] rounded-t-[16px] border border-newTableBorder bg-newBgColorInner shadow-xl outline-none'
        }
        style={
          placement?.sheet === false && placement.card
            ? {
                top: placement.card.top,
                left: placement.card.left,
                width: placement.card.width,
              }
            : undefined
        }
      >
        <span className="text-[12px] text-textItemBlur" aria-live="polite">
          {t('content_studio_tour_step', '{{step}} of {{total}}', {
            step: index + 1,
            total: CONTENT_STUDIO_TOUR.length,
          })}
        </span>
        <h2 id={titleId} className="font-[600] text-[16px]">
          {step.title}
        </h2>
        <p className="text-[14px]">{step.text}</p>
        <div className="flex items-center justify-between gap-[8px] pt-[4px]">
          <button
            type="button"
            className="min-h-[40px] text-[14px] text-textItemBlur underline"
            onClick={() => onClose('skipped')}
          >
            {t('content_studio_tour_skip', 'Skip tour')}
          </button>
          <Button
            onClick={() => (last ? onClose('completed') : setIndex(index + 1))}
          >
            {last
              ? t('content_studio_tour_done', 'Done')
              : t('content_studio_tour_next', 'Next')}
          </Button>
        </div>
      </div>
    </>
  );
};

// The tour once per organization (in this browser): started by the first
// post's success or by hand, finished or skipped for good
export const useContentStudioTour = () => {
  const user = useUser();
  const organizationId = user?.orgId || '';
  const [open, setOpen] = useState(false);
  const start = useCallback(() => setOpen(true), []);
  const close = useCallback(
    (how: 'skipped' | 'completed') => {
      setOpen(false);
      setContentStudioTourState(organizationId, how);
    },
    [organizationId]
  );
  // the first time only: never again once finished or skipped
  const startOnce = useCallback(() => {
    if (organizationId && !isContentStudioTourSeen(organizationId)) {
      setOpen(true);
    }
  }, [organizationId]);
  return { open, start, startOnce, close };
};

// --- the checklist ---

export const isContentStudioNoApprovalDecided = (organizationId: string) =>
  read(noApprovalKey(organizationId));
export const setContentStudioNoApprovalDecided = (
  organizationId: string,
  decided: boolean
) => write(noApprovalKey(organizationId), decided);

export interface ContentStudioGetStartedTask {
  key:
    | 'setup'
    | 'first_draft'
    | 'first_post'
    | 'knowledge'
    | 'research'
    | 'visual'
    | 'approval';
  label: string;
  hint: string;
  href: string;
  done: boolean;
}

// Each task is a useful thing to do in a section, done when the data says
// so: never "visit page X"
export const useContentStudioGetStartedTasks = () => {
  const t = useT();
  const user = useUser();
  const organizationId = user?.orgId || '';
  // read after mount: storage is not there on the server
  const [noApproval, setNoApproval] = useState(false);
  useEffect(() => {
    setNoApproval(isContentStudioNoApprovalDecided(organizationId));
  }, [organizationId]);
  const decideNoApproval = useCallback(() => {
    setContentStudioNoApprovalDecided(organizationId, true);
    setNoApproval(true);
  }, [organizationId]);
  const status = useContentStudioSetupStatus();
  const firstPost = useContentStudioFirstPost();
  const policy = useContentStudioEditorialPolicy<EditorialPolicyContent>();
  const designs = useContentStudioDesigns(false, 1);
  const content = policy.data?.currentRevision?.content;
  const activated = !!firstPost.data?.activated;
  const savedAsDraft = activated
    ? null
    : firstPost.data?.firstPost.savedAsDraft ?? null;
  const tasks: ContentStudioGetStartedTask[] = [
    {
      key: 'setup',
      label: t('content_studio_get_started_setup', 'Set up Content Studio'),
      hint: t(
        'content_studio_get_started_setup_hint',
        'Your AI, company profile, voice, audiences, expertise and rules.'
      ),
      href: '/content-studio/setup',
      done: status.complete,
    },
    {
      key: 'first_draft',
      label: t(
        'content_studio_get_started_first_draft',
        'Create your first AI-researched post'
      ),
      hint: t(
        'content_studio_get_started_first_post_hint',
        'Research a current topic and turn it into a post.'
      ),
      href: FIRST_POST_PAGE,
      // a draft made by AI is enough; saved or scheduled is the next task
      done:
        activated ||
        !!savedAsDraft ||
        !!firstPost.data?.alternatives?.length ||
        firstPost.data?.draft?.status === 'succeeded',
    },
    {
      key: 'first_post',
      label: t(
        'content_studio_get_started_schedule_first_post',
        'Schedule or publish your first post'
      ),
      hint: t(
        'content_studio_get_started_schedule_first_post_hint',
        'Open it in the composer and choose Schedule, or publish it.'
      ),
      // the post saved as a draft opens again; otherwise the first post
      href: savedAsDraft
        ? firstPostDraftPath(savedAsDraft.group)
        : FIRST_POST_PAGE,
      done: activated,
    },
    {
      key: 'knowledge',
      label: t(
        'content_studio_get_started_knowledge',
        'Add your first Knowledge source'
      ),
      hint: t(
        'content_studio_get_started_knowledge_hint',
        'A page or feed about your company, products or field, so AI writes from it.'
      ),
      href: '/content-studio/sources',
      done: status.hasSources,
    },
    {
      key: 'research',
      label: t(
        'content_studio_get_started_research',
        'Set your research focus'
      ),
      hint: t(
        'content_studio_get_started_research_hint',
        'What Content Studio should look for and avoid when it researches topics.'
      ),
      href: `${FIRST_POST_PAGE}?refine=1`,
      done: !!content?.research,
    },
    {
      key: 'visual',
      label: t(
        'content_studio_get_started_visual',
        'Create a visual in Creative Studio'
      ),
      hint: t(
        'content_studio_get_started_visual_hint',
        'An image for your posts, in your brand style.'
      ),
      href: '/content-studio/designs',
      done: !!designs.data?.results.length,
    },
    {
      key: 'approval',
      label: t(
        'content_studio_get_started_approval',
        'Decide who approves posts'
      ),
      hint: t(
        'content_studio_get_started_approval_hint',
        'Either is a decision: require approval before a post goes to publishing (under Editorial Policy), or say no approval is needed.'
      ),
      href: '/content-studio/intelligence?tab=editorial',
      // approval switched on, or no approval needed on purpose
      done: content?.workflow?.requireApprovalForHandoff === true || noApproval,
    },
  ];
  return {
    decideNoApproval,
    // shown after the first post succeeded, whatever failed to load
    activated,
    // or once it was saved as a draft (progress)
    draftSaved: !!savedAsDraft,
    loaded: status.loaded && firstPost.data !== undefined,
    tasks,
  };
};

// On Home, once the first post was scheduled or published (or saved as a
// draft, with scheduling it still open), until every task is done or the
// list is hidden. Easy to come back to: it stays until then, and the tour
// can be taken again from it
export const ContentStudioGetStarted: FC = () => {
  const t = useT();
  const user = useUser();
  const organizationId = user?.orgId || '';
  const { activated, draftSaved, loaded, tasks, decideNoApproval } =
    useContentStudioGetStartedTasks();
  const tour = useContentStudioTour();
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    setHidden(read(checklistKey(organizationId)));
  }, [organizationId]);
  // a first post that succeeded while the user was elsewhere: the tour
  // starts here, once
  useEffect(() => {
    if (loaded && activated) {
      tour.startOnce();
    }
  }, [loaded, activated, tour.startOnce]);

  const doneCount = tasks.filter((task) => task.done).length;
  const started = activated || draftSaved;
  const show =
    loaded && started && hidden === false && doneCount < tasks.length;
  return (
    <>
      {tour.open && <ContentStudioTour onClose={tour.close} />}
      {show && (
        <section
          aria-labelledby="content-studio-get-started-title"
          className="flex flex-col gap-[12px] p-[16px] rounded-[12px] border border-newTableBorder"
        >
          <div className="flex flex-wrap items-baseline gap-[8px]">
            <h2
              id="content-studio-get-started-title"
              className="flex-1 min-w-[200px] font-[600]"
            >
              {t(
                'content_studio_get_started_title',
                'Get more out of Content Studio'
              )}
            </h2>
            <span className="text-[13px] text-textItemBlur">
              {t(
                'content_studio_get_started_count',
                '{{done}} of {{total}} done',
                {
                  done: doneCount,
                  total: tasks.length,
                }
              )}
            </span>
          </div>
          <ul className="flex flex-col gap-[8px]">
            {tasks.map((task) => (
              <li
                key={task.key}
                data-task={task.key}
                data-done={task.done}
                className="flex items-start gap-[10px]"
              >
                <span
                  aria-hidden="true"
                  className={
                    task.done
                      ? 'mt-[2px] w-[20px] h-[20px] shrink-0 rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] flex items-center justify-center text-[12px]'
                      : 'mt-[2px] w-[20px] h-[20px] shrink-0 rounded-full border border-newTableBorder'
                  }
                >
                  {task.done ? '✓' : ''}
                </span>
                <div className="flex flex-col min-w-0">
                  {task.done ? (
                    <span className="text-[14px] text-textItemBlur line-through break-words">
                      {task.label}
                      <span className="sr-only">
                        {' '}
                        {t('content_studio_setup_done', 'done')}
                      </span>
                    </span>
                  ) : (
                    <Link
                      href={task.href}
                      className="text-[14px] font-[600] underline break-words"
                    >
                      {task.label}
                    </Link>
                  )}
                  {!task.done && (
                    <span className="text-[13px] text-textItemBlur break-words">
                      {task.hint}
                    </span>
                  )}
                  {!task.done && task.key === 'approval' && (
                    <button
                      type="button"
                      className="self-start min-h-[32px] text-[13px] underline"
                      onClick={decideNoApproval}
                    >
                      {t(
                        'content_studio_get_started_no_approval',
                        'No approval needed'
                      )}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-[16px] pt-[4px] text-[13px]">
            <button
              type="button"
              className="min-h-[32px] underline"
              onClick={tour.start}
            >
              {t('content_studio_get_started_tour', 'Take the tour again')}
            </button>
            <button
              type="button"
              className="min-h-[32px] underline text-textItemBlur"
              onClick={() => {
                write(checklistKey(organizationId), true);
                setHidden(true);
              }}
            >
              {t('content_studio_get_started_hide', 'Hide this list')}
            </button>
          </div>
        </section>
      )}
      {loaded && started && !show && hidden !== null && (
        // the tour stays at hand once the list is gone
        <div className="text-[13px]">
          <button
            type="button"
            className="min-h-[32px] underline text-textItemBlur hover:text-newTextColor"
            onClick={tour.start}
          >
            {t('content_studio_get_started_tour_short', 'Take the tour')}
          </button>
        </div>
      )}
    </>
  );
};

// The success of the first post, and right after it the tour, once
const FirstPostSuccessWithTour: FC<{ published: boolean }> = ({
  published,
}) => {
  const t = useT();
  const tour = useContentStudioTour();
  useEffect(() => {
    tour.startOnce();
  }, [tour.startOnce]);
  return (
    <>
      <FirstPostSuccess published={published}>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-[8px]">
          <Button onClick={tour.start}>
            {t('content_studio_tour_start', 'Take a quick tour')}
          </Button>
          <Link
            href={CONTENT_STUDIO_HOME_PATH}
            className="px-[24px] h-[40px] flex items-center justify-center rounded-full border border-textColor/60 text-textColor"
          >
            {t('content_studio_setup_to_home', 'Go to Content Studio')}
          </Link>
        </div>
      </FirstPostSuccess>
      {tour.open && <ContentStudioTour onClose={tour.close} />}
    </>
  );
};

// From a first post saved as a draft: the tour, on purpose only, and then
// Home, where the reminder to schedule it waits. Not the success: that
// stays for a scheduled or published post
const FirstPostExplore: FC = () => {
  const t = useT();
  const router = useRouter();
  const user = useUser();
  const organizationId = user?.orgId || '';
  const tour = useContentStudioTour();
  const close = useCallback(
    (how: 'skipped' | 'completed') => {
      tour.close(how);
      router.push(CONTENT_STUDIO_HOME_PATH);
    },
    [tour.close, router]
  );
  return (
    <>
      <button
        type="button"
        data-testid="first-post-explore"
        onClick={() => {
          writeVisit(firstPostExploredKey(organizationId));
          tour.start();
        }}
        className="px-[24px] h-[40px] flex items-center justify-center rounded-full border border-textColor/60 text-textColor"
      >
        {t(
          'content_studio_first_post_explore',
          'Continue exploring Content Studio'
        )}
      </button>
      {tour.open && <ContentStudioTour onClose={close} />}
    </>
  );
};

// On Home while the first post is saved as a draft and not scheduled or
// published: a reminder to schedule it, on every visit, before anything
// else. "Not now" puts it away for this visit only. Right after exploring
// it says the draft is ready; on a later visit that it is still waiting
export const ContentStudioFirstPostReminder: FC = () => {
  const t = useT();
  const user = useUser();
  const organizationId = user?.orgId || '';
  const firstPost = useContentStudioFirstPost();
  const saved = firstPost.data?.activated
    ? null
    : firstPost.data?.firstPost.savedAsDraft ?? null;
  // read after mount: storage is not there on the server
  const [visitState, setVisitState] = useState<{
    notNow: boolean;
    explored: boolean;
  } | null>(null);
  useEffect(() => {
    setVisitState({
      notNow: readVisit(firstPostNotNowKey(organizationId)),
      explored: readVisit(firstPostExploredKey(organizationId)),
    });
  }, [organizationId]);
  if (!saved || !visitState || visitState.notNow) {
    return null;
  }
  return (
    <section
      aria-labelledby="content-studio-first-post-reminder-title"
      data-testid="first-post-reminder"
      className="flex flex-col gap-[12px] p-[16px] rounded-[12px] border border-[var(--brand-primary,#612ad5)]"
    >
      <div className="flex flex-col gap-[4px]">
        <h2
          id="content-studio-first-post-reminder-title"
          className="font-[600] text-[16px] break-words"
        >
          {visitState.explored
            ? t(
                'content_studio_first_post_reminder_ready_title',
                'Your first post is waiting'
              )
            : t(
                'content_studio_first_post_reminder_title',
                'Your first post is still waiting'
              )}
        </h2>
        <p className="text-[14px] break-words">
          {visitState.explored
            ? t(
                'content_studio_first_post_reminder_ready',
                "Your AI-researched draft is ready. Review it and schedule it when you're ready."
              )
            : t(
                'content_studio_first_post_reminder',
                'You created your first AI-researched post. Want to review it once more and schedule it?'
              )}
        </p>
        <p className="text-[13px] text-textItemBlur break-words">
          {t(
            'content_studio_first_post_draft_date',
            'Draft date: {{date}}. It stays a draft and will not be published until you schedule it.',
            { date: firstPostDraftDate(saved.publishDate) }
          )}
        </p>
      </div>
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-[8px]">
        <Link
          href={firstPostDraftPath(saved.group)}
          className="px-[24px] h-[40px] flex items-center justify-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] font-[600]"
        >
          {t(
            'content_studio_first_post_review_schedule',
            'Review and schedule'
          )}
        </Link>
        <button
          type="button"
          onClick={() => {
            writeVisit(firstPostNotNowKey(organizationId));
            setVisitState({ ...visitState, notNow: true });
          }}
          className="min-h-[40px] px-[8px] text-[14px] text-textItemBlur underline underline-offset-2 hover:text-newTextColor"
        >
          {t('content_studio_not_now', 'Not now')}
        </button>
      </div>
    </section>
  );
};

// The first post page with its success moment and the tour after it, or,
// saved as a draft, the tour on purpose
export const ContentStudioFirstPostPage: FC = () => (
  <ContentStudioFirstPost
    success={(state) => (
      <FirstPostSuccessWithTour published={state.firstPost.published} />
    )}
    explore={<FirstPostExplore />}
  />
);
