'use client';

import { FC, ReactNode, useCallback, useMemo, useState } from 'react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import Link from 'next/link';
import useSWR, { useSWRConfig } from 'swr';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  ContentStudioRequestError,
  packagePath,
  request,
  useContentStudioWorkspaceApi,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  CONTENT_STUDIO_HOME_PATH,
  ContentStudioLoading,
  ContentStudioPage,
} from '@gitroom/frontend/components/content-studio/content-studio.shell';
import {
  AI_OPERATION_POLL_MS,
  isUsableAIConnection,
} from '@gitroom/frontend/components/content-studio/content-studio.setup.api';
import {
  aiConnectionHealth,
  isRevisionConflict,
  useContentStudioAIConnections,
  useContentStudioAIProviders,
  useContentStudioEditorialPolicy,
  useContentStudioEditorialPolicyActions,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  EditorialPolicyContent,
  emptyEditorialPolicyContent,
  emptyResearchPreferences,
  RESEARCH_FOCUS_MAX,
  ResearchAnglesField,
  ResearchPreferences,
  useResearchFreshnessOptions,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.editorial-policy';
import { StringListEditor } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// The first post (activation flow 01). Right after the guided setup Content
// Studio researches what the organization should post about now and drafts
// that post; this page owns that work while it runs, shows the draft with
// why its subject was chosen and what it is based on, and hands it to the
// composer, where the user edits, picks channels and schedules or
// publishes. Research and draft run on the server and are read back here,
// so leaving the page, a reload or a phone that puts the browser away loses
// nothing. When the subject misses the mark, "Try another angle" keeps the
// research preferences and "Refine my research" changes them first; every
// draft made stays, and an earlier one can be put back. This page prepares
// the post, the composer finishes it: there is no second editor here. The
// first post is done once a post was scheduled or published after it went
// to the composer: only then does the page say so

export const FIRST_POST_PAGE = '/content-studio/first-post';
const FIRST_POST_PATH = '/content-studio/activation/first-post';
// the composer brings the user back here when it closes
export const FIRST_POST_RETURN = 'first-post';

export interface ContentStudioFirstPostSource {
  title: string;
  url: string;
  publisher: string | null;
  publishedAt: string | null;
  origin: 'radar' | 'web';
}

export interface ContentStudioFirstPostResearch {
  topic: string;
  angle: string;
  summary: string;
  why: { audience: string; expertise: string; timing: string };
  sources: ContentStudioFirstPostSource[];
  sourceBacked: boolean;
}

// A draft made for the first post, with the research it came from: kept
// when another one is made
export interface ContentStudioFirstPostAlternative {
  operationId: string;
  completedAt: string | null;
  text: string;
  research: ContentStudioFirstPostResearch | null;
  // its text is the text of the post now
  current: boolean;
}

type OperationState =
  | { operationId: string; status: 'running' | 'succeeded' }
  | { operationId: string; status: 'failed'; code: string };

export interface ContentStudioFirstPostState {
  packageId: string | null;
  package?: {
    name: string;
    draftVersion: number;
    archived: boolean;
    text: string;
  } | null;
  research:
    | (OperationState & {
        completedAt: string | null;
        result?: ContentStudioFirstPostResearch;
      })
    | null;
  draft: (OperationState & { applied?: boolean }) | null;
  // newest first
  alternatives?: ContentStudioFirstPostAlternative[];
  firstPost: {
    scheduled: boolean;
    published: boolean;
    // saved in the composer as a draft since the first handoff: in the
    // calendar, not scheduled (no activation), with its planned date
    savedAsDraft?: { publishDate: string } | null;
  };
  activated: boolean;
}

export type FirstPostMode = 'first' | 'angle' | 'research' | 'draft' | 'apply';

// The draft starts on the server right after the research: a short moment
// without one is still drafting
const DRAFT_START_GRACE_MS = 2 * 60 * 1000;

export type FirstPostPhase =
  | 'none'
  | 'researching'
  | 'research_failed'
  | 'drafting'
  | 'draft_failed'
  | 'not_placed'
  | 'ready'
  | 'activated';

// Where the first post stands, from what the server read back
export const firstPostPhase = (
  state: ContentStudioFirstPostState,
  now = Date.now()
): FirstPostPhase => {
  if (state.activated) {
    return 'activated';
  }
  const { research, draft } = state;
  if (!research) {
    return 'none';
  }
  if (research.status === 'running') {
    return 'researching';
  }
  if (research.status === 'failed') {
    return 'research_failed';
  }
  if (!draft) {
    const completed = research.completedAt
      ? new Date(research.completedAt).getTime()
      : now;
    return now - completed < DRAFT_START_GRACE_MS ? 'drafting' : 'draft_failed';
  }
  if (draft.status === 'running') {
    return 'drafting';
  }
  if (draft.status === 'failed') {
    return 'draft_failed';
  }
  // made, but not in the post: only when the post is still empty (text the
  // user wrote over it since is theirs)
  return !draft.applied && !state.package?.text.trim() ? 'not_placed' : 'ready';
};

const RUNNING: FirstPostPhase[] = ['researching', 'drafting'];

// --- API ---

export const useContentStudioFirstPost = () => {
  const fetch = useFetch();
  return useSWR<ContentStudioFirstPostState>(
    FIRST_POST_PATH,
    (path: string) => request<ContentStudioFirstPostState>(fetch, path),
    {
      // asked again while research or a draft runs, and whenever the page
      // is shown again: a return from the composer reads at once whether
      // the post was scheduled or published
      refreshInterval: (data) =>
        data && RUNNING.includes(firstPostPhase(data))
          ? AI_OPERATION_POLL_MS
          : 0,
      revalidateOnMount: true,
      revalidateOnFocus: true,
    }
  );
};

export const useContentStudioFirstPostActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  return useMemo(
    () => ({
      // starts on the server and answers at once
      start: async (input: {
        connectionId: string;
        mode: FirstPostMode;
        language?: string | null;
        name?: string | null;
        // apply: the earlier draft to put back
        draftOperationId?: string;
      }) => {
        const result = await request<{ packageId: string }>(
          fetch,
          FIRST_POST_PATH,
          { method: 'POST', body: JSON.stringify(input) }
        );
        await mutate(FIRST_POST_PATH);
        return result;
      },
    }),
    [fetch, mutate]
  );
};

// The connection the first post uses: the first usable one that did not
// fail its last test
export const useFirstPostConnection = () => {
  const providers = useContentStudioAIProviders();
  const connections = useContentStudioAIConnections();
  const usable = (connections.data || []).filter(
    (connection) =>
      isUsableAIConnection(connection, providers.data || []) &&
      aiConnectionHealth(connection) !== 'attention'
  );
  return {
    loaded: !!connections.data && !!providers.data,
    connectionId: usable[0]?.id ?? null,
  };
};

// --- messages: fixed text for every outcome ---

type Translate = (
  key: string,
  fallback: string,
  values?: Record<string, string | number>
) => string;

export const firstPostErrorMessage = (t: Translate, code?: string) => {
  switch (code) {
    case 'CS_AI_RATE_LIMITED':
      return t(
        'content_studio_first_post_error_rate',
        'The AI provider is busy. Wait a moment and try again.'
      );
    case 'CS_AI_TIMEOUT':
    case 'CS_AI_OPERATION_INTERRUPTED':
      return t(
        'content_studio_first_post_error_timeout',
        'The AI did not finish in time. Try again.'
      );
    case 'CS_AI_INVALID_RESPONSE':
      return t(
        'content_studio_first_post_error_invalid',
        'The AI answer could not be used. Try again.'
      );
    case 'CS_AI_AUTH_FAILED':
    case 'CS_AI_QUOTA_EXCEEDED':
    case 'CS_AI_MODEL_UNAVAILABLE':
    case 'CS_AI_MODEL_UNSUPPORTED':
    case 'CS_AI_CONNECTION_REQUIRED':
    case 'CS_AI_CONNECTION_DISABLED':
    case 'CS_AI_CONNECTION_CREDENTIAL_INVALID':
      return t(
        'content_studio_first_post_error_connection',
        'The AI connection needs attention. Check it under Brand & AI, then try again.'
      );
    default:
      return t(
        'content_studio_first_post_error',
        'The AI provider is not available right now. Try again in a moment.'
      );
  }
};

// --- research refinement: four questions, each with why it matters ---

type RefineStep = 0 | 1 | 2 | 3;

export const ResearchRefineWizard: FC<{
  initial: ResearchPreferences | undefined;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onDone: (research: ResearchPreferences) => void;
}> = ({ initial, saving, error, onCancel, onDone }) => {
  const t = useT();
  const freshnessOptions = useResearchFreshnessOptions();
  const [step, setStep] = useState<RefineStep>(0);
  const [research, setResearch] = useState<ResearchPreferences>(
    initial ?? emptyResearchPreferences()
  );
  const set = (patch: Partial<ResearchPreferences>) =>
    setResearch((current) => ({ ...current, ...patch }));
  const questions: Array<{ title: string; why: string; field: ReactNode }> = [
    {
      title: t('content_studio_refine_look_for', 'What should we look for?'),
      why: t(
        'content_studio_refine_look_for_why',
        'Content Studio uses this to decide which topics are worth bringing to you: developments in your subjects, changes in your industry, questions your audience has, new rules, practical applications.'
      ),
      field: (
        <StringListEditor
          label={t(
            'content_studio_refine_look_for',
            'What should we look for?'
          )}
          values={research.lookFor}
          max={RESEARCH_FOCUS_MAX}
          disabled={saving}
          onChange={(lookFor) => set({ lookFor })}
        />
      ),
    },
    {
      title: t('content_studio_refine_avoid', 'What should we avoid?'),
      why: t(
        'content_studio_refine_avoid_why',
        'Topics named here are never suggested, for example generic AI news, consumer news, hype, other markets or countries, or subjects you never want to cover.'
      ),
      field: (
        <StringListEditor
          label={t('content_studio_refine_avoid', 'What should we avoid?')}
          values={research.avoid}
          max={RESEARCH_FOCUS_MAX}
          disabled={saving}
          onChange={(avoid) => set({ avoid })}
        />
      ),
    },
    {
      title: t(
        'content_studio_refine_freshness',
        'How fresh should results be?'
      ),
      why: t(
        'content_studio_refine_freshness_why',
        'Recent news gives you a reason to post today; a lasting topic with a current hook stays useful for longer.'
      ),
      field: (
        <fieldset className="flex flex-col gap-[8px]">
          <legend className="sr-only">
            {t(
              'content_studio_refine_freshness',
              'How fresh should results be?'
            )}
          </legend>
          {freshnessOptions.map((option) => (
            <label
              key={option.value}
              className="flex items-center gap-[8px] min-h-[44px] px-[12px] rounded-[8px] border border-newTableBorder text-[14px] cursor-pointer"
            >
              <input
                type="radio"
                name="content-studio-refine-freshness"
                value={option.value}
                checked={research.freshness === option.value}
                disabled={saving}
                onChange={() =>
                  set({
                    freshness: option.value as ResearchPreferences['freshness'],
                  })
                }
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ),
    },
    {
      title: t('content_studio_refine_angles', 'What angle fits you?'),
      why: t(
        'content_studio_refine_angles_why',
        'The angle decides what your post adds: advice, an explanation, your opinion, an analysis, an example. Choose the ones that sound like you.'
      ),
      field: (
        <ResearchAnglesField
          value={research.angles}
          disabled={saving}
          onChange={(angles) => set({ angles })}
        />
      ),
    },
  ];
  const question = questions[step];
  const last = step === questions.length - 1;
  return (
    <section
      aria-labelledby="content-studio-refine-title"
      className="flex flex-col gap-[16px] p-[16px] rounded-[12px] border border-newTableBorder"
    >
      <div className="flex flex-col gap-[4px]">
        <span className="text-[12px] text-textItemBlur" aria-live="polite">
          {t('content_studio_refine_step', 'Question {{step}} of {{total}}', {
            step: step + 1,
            total: questions.length,
          })}
        </span>
        <h2
          id="content-studio-refine-title"
          className="text-[18px] font-[600] break-words"
        >
          {question.title}
        </h2>
        <p className="text-[14px] text-textItemBlur">{question.why}</p>
      </div>
      {question.field}
      {!!error && (
        <div
          role="alert"
          className="p-[12px] rounded-[8px] border border-newTableBorder text-[14px]"
        >
          {error}
        </div>
      )}
      <div className="flex flex-col-reverse items-stretch sm:flex-row sm:flex-wrap sm:items-center gap-[8px] sm:justify-end pt-[8px] border-t border-newTableBorder">
        <Button
          secondary
          disabled={saving}
          onClick={() =>
            step === 0 ? onCancel() : setStep((step - 1) as RefineStep)
          }
        >
          {step === 0
            ? t('content_studio_cancel', 'Cancel')
            : t('content_studio_setup_back', 'Back')}
        </Button>
        <Button
          loading={saving}
          disabled={saving}
          onClick={() =>
            last ? onDone(research) : setStep((step + 1) as RefineStep)
          }
        >
          {last
            ? t('content_studio_refine_done', 'Update research & try again')
            : t('content_studio_setup_next', 'Next')}
        </Button>
      </div>
    </section>
  );
};

// --- the page ---

const Step: FC<{
  state: 'done' | 'current' | 'upcoming';
  children: ReactNode;
}> = ({ state, children }) => (
  <li className="flex items-start gap-[10px]" data-state={state}>
    <span
      aria-hidden="true"
      className={clsx(
        'mt-[2px] w-[20px] h-[20px] shrink-0 rounded-full flex items-center justify-center text-[11px]',
        state === 'done' &&
          'border border-[var(--brand-primary,#612ad5)] text-[var(--brand-primary,#612ad5)]',
        state === 'current' &&
          'bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] animate-pulse',
        state === 'upcoming' && 'border border-newTableBorder'
      )}
    >
      {state === 'done' ? '✓' : ''}
    </span>
    <span
      className={clsx(
        'text-[14px] break-words',
        state === 'current' && 'font-[600]',
        state === 'upcoming' && 'text-textItemBlur'
      )}
    >
      {children}
    </span>
  </li>
);

export const FirstPostWhy: FC<{ research: ContentStudioFirstPostResearch }> = ({
  research,
}) => {
  const t = useT();
  return (
    <details className="group rounded-[12px] border border-newTableBorder p-[16px]">
      <summary className="cursor-pointer font-[600] min-h-[24px]">
        {t('content_studio_first_post_why', 'Why this topic?')}
      </summary>
      <div className="flex flex-col gap-[12px] pt-[12px] text-[14px]">
        <div className="break-words">
          <span className="font-[600]">{research.topic}</span>
          {' — '}
          {research.angle}
        </div>
        <ul className="flex flex-col gap-[6px]">
          <li className="break-words">
            <span className="text-textItemBlur">
              {t(
                'content_studio_first_post_why_audience',
                'For your audience:'
              )}
            </span>{' '}
            {research.why.audience}
          </li>
          <li className="break-words">
            <span className="text-textItemBlur">
              {t('content_studio_first_post_why_expertise', 'Your expertise:')}
            </span>{' '}
            {research.why.expertise}
          </li>
          <li className="break-words">
            <span className="text-textItemBlur">
              {t('content_studio_first_post_why_timing', 'Why now:')}
            </span>{' '}
            {research.why.timing}
          </li>
        </ul>
        <div className="flex flex-col gap-[6px]">
          <div className="text-[12px] text-textItemBlur">
            {t('content_studio_first_post_sources', 'Based on')}
          </div>
          {research.sources.length ? (
            <ul className="flex flex-col gap-[6px]">
              {research.sources.map((source) => (
                <li key={source.url} className="flex flex-col min-w-0">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="underline break-words"
                  >
                    {source.title}
                  </a>
                  <span className="text-[12px] text-textItemBlur break-words">
                    {[
                      source.publisher,
                      source.publishedAt,
                      source.origin === 'radar'
                        ? t(
                            'content_studio_first_post_from_radar',
                            'from your Radar'
                          )
                        : t(
                            'content_studio_first_post_from_web',
                            'found on the web'
                          ),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-textItemBlur">
              {t(
                'content_studio_first_post_no_sources',
                'No current source was found: this post builds on your expertise, not on news.'
              )}
            </div>
          )}
          <div className="text-[12px] text-textItemBlur">
            {t(
              'content_studio_first_post_check_sources',
              'Check the sources before you publish: AI can misread them.'
            )}
          </div>
        </div>
      </div>
    </details>
  );
};

export const ContentStudioFirstPost: FC<{
  // shown once the first post is scheduled or published (the tour)
  success?: (state: ContentStudioFirstPostState) => ReactNode;
}> = ({ success }) => {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const firstPost = useContentStudioFirstPost();
  const actions = useContentStudioFirstPostActions();
  const workspace = useContentStudioWorkspaceApi();
  const connection = useFirstPostConnection();
  const policy = useContentStudioEditorialPolicy<EditorialPolicyContent>();
  const policyActions = useContentStudioEditorialPolicyActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the composer refused the post until it is approved: a review is asked
  // for in the package, where approvals live
  const [approvalNeeded, setApprovalNeeded] = useState(false);
  // ?refine=1 opens the refinement at once (the checklist links to it)
  const [refining, setRefining] = useState(
    () => searchParams.get('refine') === '1'
  );
  const [refineError, setRefineError] = useState<string | null>(null);
  // the setup assistant could not start the first post (its profile is
  // saved either way)
  const startError = searchParams.get('error');

  const start = useCallback(
    async (mode: FirstPostMode, draftOperationId?: string) => {
      if (!connection.connectionId) {
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        await actions.start({
          connectionId: connection.connectionId,
          mode,
          ...(draftOperationId ? { draftOperationId } : {}),
        });
        return true;
      } catch (err) {
        // started a moment ago (another tab, a double tap): follow that one
        if (
          err instanceof ContentStudioRequestError &&
          err.code === 'CS_FIRST_POST_STARTING'
        ) {
          await firstPost.mutate();
          return true;
        }
        setError(
          firstPostErrorMessage(
            t,
            err instanceof ContentStudioRequestError ? err.code : undefined
          )
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [actions, connection.connectionId, firstPost, t]
  );

  // Saves the refined preferences as a new version of the editorial policy,
  // everything else of it as it is, then researches again
  const refine = useCallback(
    async (research: ResearchPreferences) => {
      setBusy(true);
      setRefineError(null);
      try {
        const current = policy.data;
        await policyActions.saveRevision(current?.latestRevisionNumber ?? 0, {
          ...(current?.currentRevision?.content ??
            emptyEditorialPolicyContent()),
          research,
        });
      } catch (err) {
        setRefineError(
          isRevisionConflict(err)
            ? t(
                'content_studio_refine_conflict',
                'Your editorial policy changed elsewhere. Try again to use the latest one.'
              )
            : t(
                'content_studio_refine_save_error',
                'Your research preferences could not be saved. Try again.'
              )
        );
        policy.mutate();
        setBusy(false);
        return;
      }
      setBusy(false);
      setRefining(false);
      await start('research');
    },
    [policy, policyActions, start, t]
  );

  // to the composer with exactly this text: a version of the package, then
  // a handoff; the composer brings the user back here
  const schedule = useCallback(async () => {
    const state = firstPost.data;
    if (!state?.packageId || !state.package) {
      return;
    }
    setBusy(true);
    setError(null);
    setApprovalNeeded(false);
    try {
      const revision = await workspace.createRevision(
        state.packageId,
        state.package.draftVersion,
        'handoff'
      );
      const handoff = await workspace.createHandoff(
        state.packageId,
        revision.revision.id
      );
      router.push(
        `/launches?handoff=${encodeURIComponent(
          handoff.id
        )}&return=${FIRST_POST_RETURN}`
      );
    } catch (err) {
      setBusy(false);
      const approval =
        err instanceof ContentStudioRequestError &&
        err.code === 'CS_APPROVAL_REQUIRED';
      setApprovalNeeded(approval);
      setError(
        approval
          ? t(
              'content_studio_first_post_approval',
              'Your editorial policy asks for approval first. Ask for a review of this post, then schedule it.'
            )
          : t(
              'content_studio_first_post_handoff_error',
              'Your post could not be opened in the composer. Your draft is kept; try again.'
            )
      );
    }
  }, [firstPost.data, router, t, workspace]);

  // the way back is always on the page, never only the browser's Back
  const page = (children: ReactNode) => (
    <ContentStudioPage
      crumbs={[
        { label: t('content_studio_first_post_title', 'Your first post') },
      ]}
      title={t('content_studio_first_post_title', 'Your first post')}
      description={t(
        'content_studio_first_post_subtitle',
        'Researched with your profile, written in your voice. You stay in control: nothing is published or scheduled until you choose to.'
      )}
    >
      <div className="w-full max-w-[760px] flex flex-col gap-[16px] min-w-0">
        {children}
      </div>
    </ContentStudioPage>
  );

  if (!firstPost.data || !connection.loaded) {
    return page(
      firstPost.error ? (
        <div className="flex flex-col items-start gap-[12px]">
          <div role="alert">
            {t('content_studio_load_error', 'Could not load Content Studio.')}
          </div>
          <Button secondary onClick={() => firstPost.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : (
        <ContentStudioLoading
          label={t(
            'content_studio_first_post_loading',
            'Opening your first post…'
          )}
        />
      )
    );
  }

  const state = firstPost.data;
  const phase = firstPostPhase(state);
  const research =
    state.research?.status === 'succeeded' ? state.research.result : undefined;
  const alert = error && (
    <div
      role="alert"
      className="p-[12px] rounded-[8px] border border-newTableBorder text-[14px]"
    >
      {error}
      {approvalNeeded && !!state.packageId && (
        <>
          {' '}
          <Link href={packagePath(state.packageId)} className="underline">
            {t('content_studio_first_post_ask_review', 'Ask for a review')}
          </Link>
        </>
      )}
    </div>
  );
  const alternatives = state.alternatives ?? [];
  const current = alternatives.find((alternative) => alternative.current);
  const noConnection = !connection.connectionId && (
    <div className="text-[14px]">
      {t(
        'content_studio_first_post_no_ai',
        'Content Studio needs a working AI connection for this.'
      )}{' '}
      <Link href="/content-studio/intelligence?tab=ai" className="underline">
        {t('content_studio_first_post_check_ai', 'Check AI connections')}
      </Link>
    </div>
  );
  if (refining) {
    return page(
      <ResearchRefineWizard
        initial={policy.data?.currentRevision?.content.research}
        saving={busy}
        error={refineError}
        onCancel={() => setRefining(false)}
        onDone={refine}
      />
    );
  }

  if (phase === 'activated') {
    return page(
      success ? (
        success(state)
      ) : (
        <FirstPostSuccess published={state.firstPost.published} />
      )
    );
  }

  if (phase === 'none') {
    return page(
      <section className="flex flex-col gap-[12px]">
        {startError ? (
          <div role="alert" className="flex flex-col gap-[4px]">
            <span className="font-[600]">
              {t(
                'content_studio_first_post_saved_not_started',
                "Your profile is saved, but we couldn't create the first post yet."
              )}
            </span>
            <span className="text-[14px] text-textItemBlur">
              {firstPostErrorMessage(t, startError)}
            </span>
          </div>
        ) : (
          <p className="text-[14px]">
            {t(
              'content_studio_first_post_intro',
              "Your profile is ready. Now let's put it to work: we research a relevant topic for your audience and write your first post with it."
            )}
          </p>
        )}
        {alert}
        {noConnection}
        <div className="flex flex-col sm:flex-row gap-[8px]">
          <Button
            loading={busy}
            disabled={busy || !connection.connectionId}
            onClick={() => start('first')}
          >
            {startError
              ? t('content_studio_first_post_try_again', 'Try research again')
              : t('content_studio_first_post_create', 'Create my first post')}
          </Button>
          {!!startError && (
            <Button
              secondary
              disabled={busy || !connection.connectionId}
              onClick={() => setRefining(true)}
            >
              {t('content_studio_first_post_refine', 'Refine my research')}
            </Button>
          )}
        </div>
      </section>
    );
  }

  if (phase === 'researching' || phase === 'drafting') {
    return page(
      <section
        aria-live="polite"
        className="flex flex-col gap-[16px] p-[16px] rounded-[12px] border border-newTableBorder"
      >
        <ol className="flex flex-col gap-[12px]">
          <Step state={phase === 'researching' ? 'current' : 'done'}>
            {phase === 'researching'
              ? t(
                  'content_studio_first_post_researching',
                  'Researching a relevant topic for your audience…'
                )
              : research
              ? t(
                  'content_studio_first_post_researched',
                  'Topic chosen: {{topic}}',
                  {
                    topic: research.topic,
                  }
                )
              : t('content_studio_first_post_researched_plain', 'Topic chosen')}
          </Step>
          <Step state={phase === 'drafting' ? 'current' : 'upcoming'}>
            {t(
              'content_studio_first_post_drafting',
              'Turning the strongest angle into your first post…'
            )}
          </Step>
        </ol>
        <p className="text-[13px] text-textItemBlur">
          {t(
            'content_studio_first_post_wait',
            'This takes one to three minutes. You can switch to another app or leave this page: we keep working, and your post waits here.'
          )}
        </p>
        {!!alternatives.length && (
          <p className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_first_post_wait_kept',
              'Your earlier drafts stay available: you can go back to any of them.'
            )}
          </p>
        )}
      </section>
    );
  }

  if (phase === 'research_failed') {
    return page(
      <section className="flex flex-col gap-[12px]">
        <div role="alert" className="flex flex-col gap-[4px]">
          <span className="font-[600]">
            {t(
              'content_studio_first_post_research_failed',
              "We couldn't research a topic for your first post."
            )}
          </span>
          <span className="text-[14px] text-textItemBlur">
            {firstPostErrorMessage(
              t,
              state.research?.status === 'failed'
                ? state.research.code
                : undefined
            )}
          </span>
        </div>
        {alert}
        {noConnection}
        <div className="flex flex-col sm:flex-row gap-[8px]">
          <Button
            loading={busy}
            disabled={busy || !connection.connectionId}
            onClick={() => start('research')}
          >
            {t('content_studio_first_post_try_again', 'Try research again')}
          </Button>
          <Button
            secondary
            disabled={busy || !connection.connectionId}
            onClick={() => setRefining(true)}
          >
            {t('content_studio_first_post_refine', 'Refine my research')}
          </Button>
        </div>
      </section>
    );
  }

  if (phase === 'draft_failed') {
    return page(
      <section className="flex flex-col gap-[12px]">
        <div role="alert" className="flex flex-col gap-[4px]">
          <span className="font-[600]">
            {t(
              'content_studio_first_post_draft_failed',
              "We found a topic, but couldn't write the post yet."
            )}
          </span>
          <span className="text-[14px] text-textItemBlur">
            {firstPostErrorMessage(
              t,
              state.draft?.status === 'failed' ? state.draft.code : undefined
            )}
          </span>
        </div>
        {!!research && <FirstPostWhy research={research} />}
        {alert}
        {noConnection}
        <div className="flex flex-col sm:flex-row gap-[8px]">
          <Button
            loading={busy}
            disabled={busy || !connection.connectionId}
            onClick={() => start('draft')}
          >
            {t('content_studio_first_post_draft_again', 'Write the post again')}
          </Button>
          <Button
            secondary
            disabled={busy || !connection.connectionId}
            onClick={() => start('angle')}
          >
            {t('content_studio_first_post_angle', 'Try another angle')}
          </Button>
        </div>
      </section>
    );
  }

  if (phase === 'not_placed') {
    return page(
      <section className="flex flex-col gap-[12px]">
        <div role="alert" className="font-[600]">
          {t(
            'content_studio_first_post_not_placed',
            'Your draft is ready, but it could not be placed in your post.'
          )}
        </div>
        {alert}
        <div>
          <Button
            loading={busy}
            disabled={busy || !connection.connectionId}
            onClick={() => start('apply')}
          >
            {t('content_studio_first_post_apply', 'Put the draft in my post')}
          </Button>
        </div>
      </section>
    );
  }

  // a draft made after the user changed the post by hand: theirs stays
  // until they choose the new one (a draft they put back is no change)
  const newDraftWaiting =
    state.draft?.status === 'succeeded' &&
    state.draft.applied === false &&
    !current;
  // Ready: first the post itself and why its subject was chosen, then what
  // to do with it, in order: finish it in the composer, another idea with
  // the same focus, or a different focus. Every draft made stays below
  const savedAsDraft = state.firstPost.savedAsDraft;
  return page(
    <>
      {/* back from the composer with the post saved as a draft: it is in
          the calendar, but nothing will be published yet */}
      {!!savedAsDraft && (
        <div
          role="status"
          data-testid="first-post-saved-as-draft"
          className="flex flex-col gap-[6px] p-[14px] rounded-[12px] border border-newTableBorder text-[14px]"
        >
          <span className="font-[600]">
            {t(
              'content_studio_first_post_saved_draft_title',
              'Your post is saved as a draft, not scheduled yet'
            )}
          </span>
          <span>
            {t(
              'content_studio_first_post_saved_draft',
              'It is in the calendar as a draft for {{date}}, so it will not be published. Open it in the calendar and choose Schedule to schedule it.',
              {
                date: dayjs(savedAsDraft.publishDate).format(
                  'MMM D, YYYY HH:mm'
                ),
              }
            )}
          </span>
          <Link href="/launches" className="underline self-start">
            {t('content_studio_first_post_open_calendar', 'Open the calendar')}
          </Link>
        </div>
      )}
      {newDraftWaiting && (
        <div
          role="status"
          className="flex flex-col sm:flex-row sm:items-center gap-[8px] p-[12px] rounded-[8px] border border-newTableBorder text-[14px]"
        >
          <span className="flex-1">
            {t(
              'content_studio_first_post_new_draft',
              'A new draft is ready. Your post was changed in the meantime, so it was kept as it is.'
            )}
          </span>
          <Button
            secondary
            disabled={busy || !connection.connectionId}
            onClick={() => start('apply')}
          >
            {t('content_studio_first_post_use_new', 'Use the new draft')}
          </Button>
        </div>
      )}
      <section className="flex flex-col gap-[12px] p-[16px] rounded-[12px] border border-newTableBorder">
        <h2 className="font-[600]">
          {t('content_studio_first_post_draft', 'Your draft')}
        </h2>
        <div
          data-testid="first-post-text"
          className="text-[15px] whitespace-pre-wrap break-words"
        >
          {state.package?.text}
        </div>
      </section>
      {/* the research of the draft that is in the post; only a post
          changed by hand falls back to the latest research */}
      {!!(current ? current.research : research) && (
        <FirstPostWhy
          research={
            (current
              ? current.research
              : research) as ContentStudioFirstPostResearch
          }
        />
      )}
      {alert}
      <div
        data-testid="first-post-actions"
        className="flex flex-col gap-[16px] pt-[4px]"
      >
        <div className="flex flex-col gap-[6px]">
          <div className="flex flex-col sm:flex-row">
            <Button loading={busy} disabled={busy} onClick={schedule}>
              {t('content_studio_first_post_schedule', 'Review and schedule')}
            </Button>
          </div>
          <p className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_first_post_schedule_hint',
              'Opens the post in the Postiz composer: choose your channels, make final edits and schedule or publish it there.'
            )}
          </p>
        </div>
        <div className="flex flex-col gap-[6px]">
          <div className="flex flex-col sm:flex-row">
            <Button
              secondary
              disabled={busy || !connection.connectionId}
              onClick={() => start('angle')}
            >
              {t('content_studio_first_post_angle', 'Try another angle')}
            </Button>
          </div>
          <p className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_first_post_angle_hint',
              'Keep the same research focus and create a different post idea. This draft stays available.'
            )}
          </p>
        </div>
        <div className="flex flex-col gap-[6px]">
          <button
            type="button"
            disabled={busy || !connection.connectionId}
            onClick={() => {
              setRefineError(null);
              setRefining(true);
            }}
            className="self-start min-h-[40px] text-[14px] font-[600] underline underline-offset-2 disabled:opacity-50"
          >
            {t('content_studio_first_post_refine', 'Refine my research')}
          </button>
          <p className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_first_post_refine_hint',
              'Change what Content Studio looks for before creating another draft.'
            )}
          </p>
        </div>
      </div>
      {alternatives.length > 1 && (
        <FirstPostDrafts
          alternatives={alternatives}
          disabled={busy || !connection.connectionId}
          onUse={(operationId) => start('apply', operationId)}
        />
      )}
    </>
  );
};

// Every draft made for the first post, newest first: the one in the post is
// marked, any other can be read and put back. Nothing made is ever lost to
// "Try another angle" or refined research
export const FirstPostDrafts: FC<{
  alternatives: ContentStudioFirstPostAlternative[];
  disabled: boolean;
  onUse: (operationId: string) => void;
}> = ({ alternatives, disabled, onUse }) => {
  const t = useT();
  return (
    <section
      aria-labelledby="content-studio-first-post-drafts"
      className="flex flex-col gap-[8px] pt-[8px] border-t border-newTableBorder"
    >
      <h2 id="content-studio-first-post-drafts" className="font-[600]">
        {t('content_studio_first_post_drafts', 'Your drafts')}
      </h2>
      <ul className="flex flex-col gap-[8px]">
        {alternatives.map((alternative, index) => (
          <li
            key={alternative.operationId}
            data-current={alternative.current}
            className="rounded-[12px] border border-newTableBorder"
          >
            <details className="group p-[12px]">
              <summary className="cursor-pointer flex flex-wrap items-center gap-x-[8px] gap-y-[4px] min-h-[28px]">
                <span className="font-[600]">
                  {t('content_studio_first_post_draft_n', 'Draft {{number}}', {
                    number: alternatives.length - index,
                  })}
                </span>
                {!!alternative.research?.topic && (
                  <span className="text-[14px] text-textItemBlur break-words min-w-0">
                    {alternative.research.topic}
                  </span>
                )}
                {alternative.current && (
                  <span className="text-[12px] px-[8px] py-[1px] rounded-full border border-[var(--brand-primary,#612ad5)] text-[var(--brand-primary,#612ad5)]">
                    {t('content_studio_first_post_in_post', 'In your post')}
                  </span>
                )}
              </summary>
              <div className="flex flex-col gap-[12px] pt-[12px]">
                <div className="text-[14px] whitespace-pre-wrap break-words">
                  {alternative.text}
                </div>
                {!alternative.current && (
                  <div className="flex flex-col sm:flex-row">
                    <Button
                      secondary
                      disabled={disabled}
                      onClick={() => onUse(alternative.operationId)}
                    >
                      {t(
                        'content_studio_first_post_use_draft',
                        'Use this draft'
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
};

// The success moment, without a tour
export const FirstPostSuccess: FC<{
  published: boolean;
  children?: ReactNode;
}> = ({ published, children }) => {
  const t = useT();
  return (
    <section className="flex flex-col items-center text-center gap-[16px] py-[24px]">
      <span
        aria-hidden="true"
        className="w-[56px] h-[56px] rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] flex items-center justify-center text-[28px]"
      >
        {'✓'}
      </span>
      <h2 className="text-[22px] font-[600]">
        {published
          ? t(
              'content_studio_first_post_published',
              'Your first post is published'
            )
          : t(
              'content_studio_first_post_scheduled',
              'Your first post is scheduled'
            )}
      </h2>
      <p className="text-[14px] text-textItemBlur max-w-[520px]">
        {t(
          'content_studio_first_post_success_hint',
          'Content Studio used your profile and research preferences to help create it.'
        )}
      </p>
      {children ?? (
        <Link
          href={CONTENT_STUDIO_HOME_PATH}
          className="px-[24px] h-[40px] flex items-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)]"
        >
          {t('content_studio_setup_to_home', 'Go to Content Studio')}
        </Link>
      )}
    </section>
  );
};
