'use client';

import {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import i18next from 'i18next';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { ContentStudioRequestError } from '@gitroom/frontend/components/content-studio/content-studio.api';
import { CreateContentStudioPackageModal } from '@gitroom/frontend/components/content-studio/content-studio.package.modal';
import {
  FIRST_POST_PAGE,
  useContentStudioFirstPost,
  useContentStudioFirstPostActions,
} from '@gitroom/frontend/components/content-studio/content-studio.first-post';
import {
  CONTENT_STUDIO_HOME_PATH,
  ContentStudioLoading,
} from '@gitroom/frontend/components/content-studio/content-studio.shell';
import {
  brandKitWithIdentity,
  clearContentStudioSetupDraft,
  ContentStudioSetupCompany,
  ContentStudioSetupProposal,
  isUsableAIConnection,
  loadContentStudioSetupDraft,
  saveContentStudioSetupDraft,
  setContentStudioSetupHidden,
  useContentStudioSetupActions,
  waitForNextAIOperationPoll,
} from '@gitroom/frontend/components/content-studio/content-studio.setup.api';
import {
  aiConnectionHealth,
  aiValidationCodeMessage,
  AUDIENCE_PROFILES_PATH,
  ContentStudioProfilesPath,
  EXPERTISE_PROFILES_PATH,
  profileErrorMessage,
  useContentStudioAIConnectionActions,
  useContentStudioAIConnections,
  useContentStudioAIProviders,
  useContentStudioEditorialPolicyActions,
  useContentStudioProfileActions,
  WRITING_PROFILES_PATH,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  AIConnectionCreateForm,
  AIConnectionHealthBadge,
  useCanManageAIConnections,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.ai-connections';
import {
  emptyWritingProfileContent,
  WritingProfileContent,
  WritingProfileForm,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.writing-profiles';
import {
  AudienceProfileContent,
  AudienceProfileForm,
  emptyAudienceProfileContent,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.audience-profiles';
import {
  emptyExpertiseProfileContent,
  ExpertiseProfileContent,
  ExpertiseProfileForm,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.expertise-profiles';
import {
  EditorialPolicyContent,
  EditorialPolicyForm,
  emptyEditorialPolicyContent,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.editorial-policy';
import {
  ChoiceField,
  LongTextField,
  ShortTextField,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// The setup assistant: four short steps from an empty Content Studio to one
// that is ready to create.
//   1 AI: ready, or connected right here, or skipped (continue manually)
//   2 Your company: a few facts, typed once
//   3 Your content profile: one AI draft (or the existing or empty profile)
//     of the brand description, writing style, audiences, expertise and
//     editorial rules, reviewed section by section
//   4 Save: what will be saved, then saved; nothing is written before this
// The unfinished assistant is kept in this browser after every change, per
// organization, so it can be left and resumed. Saving never deletes or
// replaces anything: a profile with the same name gets a new version, any
// other is created, and the Brand Kit and editorial policy get a new version
// over their latest one, keeping everything the assistant does not show

export type SetupStep = 1 | 2 | 3 | 4;
export const SETUP_STEPS = 4;
// the shortest a failed retry shows its wait, so it is visibly a retry
export const SETUP_MIN_WAIT_MS = 600;

interface Named<C> {
  name: string;
  content: C;
  include: boolean;
}

export interface SetupProfile {
  brand: { tagline: string; description: string; include: boolean };
  writing: Named<WritingProfileContent>;
  audiences: Array<Named<AudienceProfileContent>>;
  expertise: Named<ExpertiseProfileContent>;
  editorial: { content: EditorialPolicyContent; include: boolean };
}

// What has been saved already, so saving again after a failure goes on
// where it stopped and never creates anything twice
export interface SetupSaved {
  brand?: boolean;
  writing?: boolean;
  audiences?: number[];
  expertise?: boolean;
  editorial?: boolean;
}

// The parts of the profile the AI can draft again on their own
export type SetupSection =
  | 'brand'
  | 'writing'
  | 'audiences'
  | 'expertise'
  | 'editorial';

// An AI draft started on the server and not yet read back: kept with the
// assistant, so a reload or a phone that was put away picks it up again
export interface SetupPending {
  operationId: string;
  section: SetupSection | 'all';
}

export interface SetupDraft {
  v: 1;
  step: SetupStep;
  connectionId: string | null;
  // continue without AI: the profile starts from what exists, or empty
  manual: boolean;
  company: ContentStudioSetupCompany;
  // where the profile of step 3 came from: an AI draft, typed, or the
  // profile the organization saved already
  source: 'ai' | 'manual' | 'saved' | null;
  profile: SetupProfile | null;
  saved: SetupSaved;
  pending?: SetupPending | null;
  // the saved setup this draft started from (contentStudioSavedSetupBase),
  // when there was one: the draft is a revisit of exactly that setup
  base?: string | null;
}

// What the organization saved through the setup, as one value: its company
// description, writing, audience and expertise profiles and editorial
// policy, each at its current version. Null while any of them is missing:
// then the setup is not done. A save anywhere (here or under Brand & AI)
// changes it
export const contentStudioSavedSetupBase = (saved: {
  brandKit: {
    latestRevisionNumber: number;
    description: string;
  };
  writing: { id: string; currentRevision: { revisionNumber: number } } | null;
  audience: { id: string; currentRevision: { revisionNumber: number } } | null;
  expertise: {
    id: string;
    currentRevision: { revisionNumber: number };
  } | null;
  policy: { latestRevisionNumber: number; hasRevision: boolean };
}) => {
  const { brandKit, writing, audience, expertise, policy } = saved;
  if (
    !brandKit.description.trim() ||
    !writing ||
    !audience ||
    !expertise ||
    !policy.hasRevision
  ) {
    return null;
  }
  return [
    `b${brandKit.latestRevisionNumber}`,
    ...[writing, audience, expertise].map(
      (profile) => `${profile.id}:${profile.currentRevision.revisionNumber}`
    ),
    `p${policy.latestRevisionNumber}`,
  ].join('|');
};

// Where the assistant opens. What the organization saved wins over what this
// browser kept: once the setup is saved, a kept draft is continued only when
// it is a revisit of exactly that saved setup (an earlier step opened on
// purpose); any other one (left from before the setup was saved, or from
// before a later change) is stale and dropped, and the assistant shows the
// saved setup at step 4. Nothing is drafted by AI on the way
export const chooseContentStudioSetupStart = (
  kept: Pick<SetupDraft, 'v' | 'base'> | null,
  savedBase: string | null
): 'resume' | 'saved' | 'new' => {
  if (savedBase) {
    return kept?.v === 1 && kept.base === savedBase ? 'resume' : 'saved';
  }
  return kept?.v === 1 ? 'resume' : 'new';
};

export const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: 'nl', label: 'Nederlands' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
];

const COMPANY_NAME_MAX = 200;
const WEBSITE_MAX = 300;
const DESCRIPTION_MAX = 2000;
const NOTE_MAX = 500;
const NAME_MAX = 100;
const TAGLINE_MAX = 300;

export const emptySetupCompany = (
  language: string
): ContentStudioSetupCompany => ({
  companyName: '',
  tagline: '',
  website: '',
  description: '',
  goal: '',
  audience: '',
  language,
});

// A reviewed profile from an AI draft: every section included. A tagline the
// user typed is kept as typed, whatever the AI answered
export const setupProfileFromProposal = (
  proposal: ContentStudioSetupProposal,
  tagline = ''
): SetupProfile => ({
  brand: {
    ...proposal.brand,
    tagline: tagline.trim() || proposal.brand.tagline,
    include: true,
  },
  writing: { ...proposal.writing, include: true },
  audiences: proposal.audiences.map((audience) => ({
    ...audience,
    include: true,
  })),
  expertise: { ...proposal.expertise, include: true },
  editorial: { content: proposal.editorialPolicy.content, include: true },
});

// Steps 1 and 2 can always be revisited; 3 and 4 need a company description
// and, for 4, a profile to save
export const canOpenSetupStep = (draft: SetupDraft, step: SetupStep) =>
  step <= 2 ||
  (!!draft.company.companyName.trim() &&
    !!draft.company.description.trim() &&
    (step === 3 || !!draft.profile));

// The website as the server takes it: http(s) only, as typed
export const isSetupWebsite = (value: string) =>
  !value.trim() || /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(value.trim());

export const SETUP_WEBSITE_EXAMPLE = 'https://nextlevelweb.nl';

// A failed AI draft that is about the connection rather than this one
// attempt: the way on is fixing the connection, not trying again
export const SETUP_CONNECTION_ERRORS = [
  'CS_AI_AUTH_FAILED',
  'CS_AI_WORKSPACE_REQUIRED',
  'CS_AI_MODEL_UNAVAILABLE',
  'CS_AI_MODEL_UNSUPPORTED',
  'CS_AI_QUOTA_EXCEEDED',
  'CS_AI_REQUEST_REJECTED',
  'CS_AI_CONNECTION_CREDENTIAL_INVALID',
  'CS_AI_CONNECTION_DISABLED',
  'CS_AI_CONNECTION_REQUIRED',
];
export const isSetupConnectionError = (error: unknown) =>
  error instanceof ContentStudioRequestError &&
  SETUP_CONNECTION_ERRORS.includes(error.code as string);

const setupAIErrorMessage = (
  t: (
    key: string,
    fallback: string,
    values?: Record<string, string | number>
  ) => string,
  error: unknown,
  // the display name of the connection's provider, e.g. Anthropic
  provider: string
) => {
  const code =
    error instanceof ContentStudioRequestError ? error.code : undefined;
  switch (code) {
    case 'CS_AI_AUTH_FAILED':
    case 'CS_AI_CONNECTION_CREDENTIAL_INVALID':
      return t(
        'content_studio_setup_ai_error_key',
        "We couldn't use this API key. Check the key under Fix connection and try again."
      );
    case 'CS_AI_WORKSPACE_REQUIRED':
      return t(
        'content_studio_setup_ai_error_workspace',
        'This Anthropic key is not tied to a workspace. Add the workspace ID to the connection, or use a key created inside a workspace.'
      );
    case 'CS_AI_MODEL_UNAVAILABLE':
    case 'CS_AI_MODEL_UNSUPPORTED':
      return t(
        'content_studio_setup_ai_error_model',
        'This model is not available for this connection. Choose another model under Fix connection.'
      );
    case 'CS_AI_REQUEST_REJECTED':
      return t(
        'content_studio_setup_ai_error_rejected',
        '{{provider}} could not accept the request Content Studio sent. Try again; if it keeps happening, choose another model under Check AI connection.',
        { provider }
      );
    case 'CS_AI_TIMEOUT':
    // the server stopped while the draft was being made
    case 'CS_AI_OPERATION_INTERRUPTED':
      return t(
        'content_studio_setup_ai_error_timeout',
        'The AI provider took too long to answer. Try again; a faster model can help.'
      );
    case 'CS_AI_PROVIDER_UNAVAILABLE':
      return t(
        'content_studio_setup_ai_error_unavailable',
        'The AI provider is not available right now. Try again in a moment.'
      );
    case 'CS_AI_INVALID_RESPONSE':
      return t(
        'content_studio_setup_ai_error_invalid',
        'The AI answer could not be used. Try again.'
      );
    case 'CS_AI_QUOTA_EXCEEDED':
      return t(
        'content_studio_setup_ai_error_quota',
        'Your {{provider}} key works, but the {{provider}} account has no API credit left, so no draft can be made. Add credit in your {{provider}} account, then try again, or continue manually.',
        { provider }
      );
    case 'CS_AI_RATE_LIMITED':
      return t(
        'content_studio_setup_ai_error_rate',
        'The AI provider is busy. Wait a moment and try again.'
      );
    case 'CS_AI_CONNECTION_DISABLED':
    case 'CS_AI_CONNECTION_REQUIRED':
      return t(
        'content_studio_setup_ai_error_connection',
        'This AI connection is not available. Choose another one in step 1.'
      );
    case 'CS_AI_SECRET_STORE_UNAVAILABLE':
      return t(
        'content_studio_ai_error_secret_store',
        'Secure credential storage is temporarily unavailable.'
      );
    default:
      return t(
        'content_studio_setup_ai_error',
        "We couldn't generate suggestions right now."
      );
  }
};

// Where the user is, kept quiet: the current step stands out, done steps
// get a small check and can be opened again, later steps are visible but
// muted. "Step x of 4" is small text, not a second headline. A phone has no
// room for four labelled steps: there it is "Step x of 4" over a bar of four
// parts, and the step's own heading names it
export type SetupStepState = 'done' | 'current' | 'upcoming';
export const setupStepState = (
  number: SetupStep,
  current: SetupStep
): SetupStepState =>
  number === current ? 'current' : number < current ? 'done' : 'upcoming';

const WizardProgress: FC<{
  step: SetupStep;
  canOpen: (step: SetupStep) => boolean;
  onOpen: (step: SetupStep) => void;
}> = ({ step, canOpen, onOpen }) => {
  const t = useT();
  const names = [
    t('content_studio_setup_step_ai', 'Connect AI'),
    t('content_studio_setup_step_company', 'Your company'),
    t('content_studio_setup_step_profile', 'Your content profile'),
    t('content_studio_setup_step_first_post', 'Your first post'),
  ];
  return (
    <nav
      aria-label={t('content_studio_setup_progress_label', 'Setup steps')}
      className="flex flex-col-reverse sm:flex-row sm:flex-wrap sm:items-center gap-x-[16px] gap-y-[8px]"
    >
      <div
        aria-hidden="true"
        data-testid="setup-progress-bar"
        className="flex sm:hidden gap-[4px]"
      >
        {names.map((name, index) => (
          <span
            key={name}
            className={clsx(
              'h-[4px] flex-1 rounded-full',
              index + 1 <= step
                ? 'bg-[var(--brand-primary,#612ad5)]'
                : 'bg-newTableBorder'
            )}
          />
        ))}
      </div>
      <ol className="hidden sm:flex flex-wrap items-center gap-x-[6px] gap-y-[8px] flex-1 min-w-0">
        {names.map((name, index) => {
          const number = (index + 1) as SetupStep;
          const state = setupStepState(number, step);
          const reachable = state !== 'current' && canOpen(number);
          return (
            <li
              key={name}
              data-state={state}
              className="flex items-center gap-[6px] min-w-0"
            >
              {index > 0 && (
                <span
                  aria-hidden="true"
                  className="w-[16px] h-px bg-newTableBorder shrink-0"
                />
              )}
              <button
                type="button"
                disabled={!reachable}
                aria-current={state === 'current' ? 'step' : undefined}
                className={clsx(
                  'flex items-center gap-[6px] min-w-0 text-[13px] rounded-full',
                  state === 'current' && 'font-[600] text-newTextColor',
                  state === 'done' && 'text-textItemBlur',
                  state === 'upcoming' && 'text-textItemBlur opacity-60',
                  reachable && 'hover:text-newTextColor hover:underline'
                )}
                onClick={() => onOpen(number)}
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    'w-[20px] h-[20px] shrink-0 rounded-full flex items-center justify-center text-[11px]',
                    state === 'current' &&
                      'bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] font-[600]',
                    state === 'done' &&
                      'border border-[var(--brand-primary,#612ad5)]/60 text-[var(--brand-primary,#612ad5)]',
                    state === 'upcoming' && 'border border-newTableBorder'
                  )}
                >
                  {state === 'done' ? '✓' : number}
                </span>
                <span
                  className={clsx(
                    'truncate',
                    state !== 'current' && 'mobile:hidden'
                  )}
                >
                  {name}
                </span>
                {state === 'done' && (
                  <span className="sr-only">
                    {t('content_studio_setup_done', 'done')}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      <span className="text-[12px] text-textItemBlur" aria-live="polite">
        {t('content_studio_setup_step_of', 'Step {{step}} of {{total}}', {
          step,
          total: SETUP_STEPS,
        })}
      </span>
    </nav>
  );
};

// The website, optional. Nothing is said about its format until a typed
// address is left in a form the server refuses; then the field is marked
// invalid and the message sits right under it, styled as an error
const WebsiteField: FC<{
  value: string;
  onChange: (next: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  const id = useId();
  const [touched, setTouched] = useState(false);
  const invalid = touched && !isSetupWebsite(value);
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      <label
        htmlFor={id}
        className="flex items-baseline gap-[8px] text-[14px] font-[600]"
      >
        {t('content_studio_setup_website_label', 'Website')}
        <span className="text-[12px] font-[400] text-textItemBlur">
          {t('content_studio_setup_optional', 'Optional')}
        </span>
      </label>
      <input
        id={id}
        aria-label={t('content_studio_setup_website_label', 'Website')}
        type="url"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        placeholder={SETUP_WEBSITE_EXAMPLE}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        maxLength={WEBSITE_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTouched(true)}
        className={clsx(
          'bg-newBgColorInner h-[42px] px-[12px] outline-none border rounded-[8px] text-textColor text-[14px] placeholder:text-textItemBlur/60',
          invalid ? 'border-red-500' : 'border-newTableBorder'
        )}
      />
      {invalid && (
        <div
          id={`${id}-error`}
          role="alert"
          className="flex items-start gap-[6px] text-[13px] text-red-400"
        >
          <span aria-hidden="true">⚠</span>
          {t(
            'content_studio_setup_website_error',
            'Use a full URL, for example https://nextlevelweb.nl'
          )}
        </div>
      )}
    </div>
  );
};

// One section of the AI draft: a short summary, included by default, with
// Edit for the full form and Regenerate for a new AI suggestion of just this
// section
const SuggestionCard: FC<{
  title: string;
  include: boolean;
  onInclude: (include: boolean) => void;
  summary: ReactNode;
  editor: ReactNode;
  onRegenerate?: () => void;
  regenerating?: boolean;
  disabled?: boolean;
}> = ({
  title,
  include,
  onInclude,
  summary,
  editor,
  onRegenerate,
  regenerating,
  disabled,
}) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <section
      className={clsx(
        'flex flex-col gap-[12px] p-[16px] rounded-[12px] border',
        include
          ? 'border-newTableBorder'
          : 'border-dashed border-newTableBorder opacity-70'
      )}
    >
      <div className="flex flex-wrap items-center gap-[8px]">
        <h3 className="flex-1 min-w-[160px] font-[600]">{title}</h3>
        <label className="flex items-center gap-[6px] text-[14px] cursor-pointer">
          <input
            type="checkbox"
            checked={include}
            disabled={disabled}
            onChange={(e) => onInclude(e.target.checked)}
          />
          {t('content_studio_setup_use_this', 'Use this')}
        </label>
        {!!onRegenerate && (
          <Button
            secondary
            loading={regenerating}
            disabled={disabled || regenerating}
            onClick={onRegenerate}
          >
            {t('content_studio_setup_regenerate', 'Regenerate')}
          </Button>
        )}
        <Button
          secondary
          disabled={disabled}
          aria-expanded={editing}
          onClick={() => setEditing(!editing)}
        >
          {editing
            ? t('content_studio_done', 'Done')
            : t('content_studio_edit_profile', 'Edit')}
        </Button>
      </div>
      {editing ? editor : summary}
    </section>
  );
};

// "Show all" / "Show less" under a list that is longer than it shows: a
// real button, for touch and keyboard, that names the list it opens. Not
// "Show 4 more", which reads as if 4 would be added
const ShowMore: FC<{
  open: boolean;
  label?: string;
  onToggle: () => void;
}> = ({ open, label, onToggle }) => {
  const t = useT();
  // the name as it reads ("Don't", not "Don&#39;t"): React escapes the
  // attribute itself
  const values = { list: label, interpolation: { escapeValue: false } };
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={
        label
          ? open
            ? t(
                'content_studio_setup_show_less_of',
                'Show less: {{list}}',
                values
              )
            : t(
                'content_studio_setup_show_all_of',
                'Show all: {{list}}',
                values
              )
          : undefined
      }
      onClick={onToggle}
      className="self-start min-h-[32px] px-[2px] text-[13px] font-[600] text-[var(--brand-primary,#612ad5)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 rounded-[4px]"
    >
      {open
        ? t('content_studio_setup_show_less', 'Show less')
        : t('content_studio_setup_show_all', 'Show all')}
    </button>
  );
};

// Each list opens on its own: the state is the list's, never shared
const Chips: FC<{ values: string[]; max?: number; label?: string }> = ({
  values,
  max = 10,
  label,
}) => {
  const [open, setOpen] = useState(false);
  if (!values.length) {
    return null;
  }
  const shown = open ? values : values.slice(0, max);
  return (
    <div className="flex flex-col gap-[6px] min-w-0">
      <ul className="flex flex-wrap gap-[6px]">
        {shown.map((value) => (
          <li
            key={value}
            className="px-[10px] py-[2px] rounded-full border border-newTableBorder text-[13px] break-words max-w-full"
          >
            {value}
          </li>
        ))}
      </ul>
      {values.length > max && (
        <ShowMore open={open} label={label} onToggle={() => setOpen(!open)} />
      )}
    </div>
  );
};

const Bullets: FC<{ values: string[]; max?: number; label?: string }> = ({
  values,
  max = 3,
  label,
}) => {
  const [open, setOpen] = useState(false);
  if (!values.length) {
    return null;
  }
  const shown = open ? values : values.slice(0, max);
  return (
    <div className="flex flex-col gap-[4px] min-w-0">
      <ul className="list-disc ps-[20px] text-[14px] flex flex-col gap-[2px]">
        {shown.map((value) => (
          <li key={value} className="break-words">
            {value}
          </li>
        ))}
      </ul>
      {values.length > max && (
        <ShowMore open={open} label={label} onToggle={() => setOpen(!open)} />
      )}
    </div>
  );
};

// Two lists side by side only where both fit: one column on a phone. (The
// tablet: prefix of this app is a max-width query, so tablet:grid-cols-2
// made phones two columns and wide screens one)
const PAIRED = 'grid grid-cols-1 sm:grid-cols-2 gap-[12px]';

const SummaryLine: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex flex-col gap-[4px]">
    <div className="text-[12px] text-textItemBlur">{label}</div>
    {children}
  </div>
);

const NameField: FC<{
  label: string;
  value: string;
  onChange: (next: string) => void;
}> = ({ label, value, onChange }) => (
  <Input
    label={label}
    name={label}
    aria-label={label}
    disableForm={true}
    removeError={true}
    value={value}
    maxLength={NAME_MAX}
    onChange={(e) => onChange(e.target.value)}
  />
);

export const ContentStudioSetupWizard: FC = () => {
  const t = useT();
  const user = useUser();
  const modals = useModals();
  const organizationId = user?.orgId || '';
  const canManageAI = useCanManageAIConnections();
  const providers = useContentStudioAIProviders();
  const connections = useContentStudioAIConnections();
  const setup = useContentStudioSetupActions();
  const writingActions = useContentStudioProfileActions(WRITING_PROFILES_PATH);
  const audienceActions = useContentStudioProfileActions(
    AUDIENCE_PROFILES_PATH
  );
  const expertiseActions = useContentStudioProfileActions(
    EXPERTISE_PROFILES_PATH
  );
  const policyActions = useContentStudioEditorialPolicyActions();
  const connectionActions = useContentStudioAIConnectionActions();
  const firstPostActions = useContentStudioFirstPostActions();
  // a first post made before is opened again, never started again
  const firstPostState = useContentStudioFirstPost();
  const router = useRouter();

  const [draft, setDraft] = useState<SetupDraft | null>(null);
  // what exists already, the start of a manual profile
  const existing = useRef<SetupProfile | null>(null);
  const [generating, setGenerating] = useState(false);
  // a draft picked up again after a reload or a return to the page
  const [stillWorking, setStillWorking] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  // the failed draft was about the connection: fix it, don't just retry
  const [connectionProblem, setConnectionProblem] = useState(false);
  // how many drafts in a row failed the same way, so a retry that fails
  // again says so instead of looking like nothing happened
  const [failures, setFailures] = useState(0);
  const lastFailure = useRef<string | null>(null);
  // a connection test running for this id
  const [testing, setTesting] = useState<string | null>(null);
  const tested = useRef(new Set<string>());
  // Each AI request has a number; an answer that comes back after the user
  // moved on (Back, Fix connection, a newer attempt) is dropped, so a late
  // answer never overwrites a newer state
  const attempt = useRef(0);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // saved, and on the way to the first post
  const [leaving, setLeaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const busy = useRef(false);

  const usable = (connections.data || []).filter((connection) =>
    isUsableAIConnection(connection, providers.data || [])
  );

  // the assistant starts from the unfinished one, or from what exists
  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const [brandKit, writing, audience, expertise, policy] =
        await Promise.all([
          setup.getBrandKit(),
          setup.latestActiveProfile<WritingProfileContent>(
            WRITING_PROFILES_PATH
          ),
          setup.latestActiveProfile<AudienceProfileContent>(
            AUDIENCE_PROFILES_PATH
          ),
          setup.latestActiveProfile<ExpertiseProfileContent>(
            EXPERTISE_PROFILES_PATH
          ),
          setup.getEditorialPolicy(),
        ]);
      const kit = brandKit.currentRevision?.content as
        | {
            identity?: {
              brandName: string;
              tagline: string;
              description: string;
            };
          }
        | undefined;
      existing.current = {
        brand: {
          tagline: kit?.identity?.tagline ?? '',
          description: kit?.identity?.description ?? '',
          include: true,
        },
        writing: writing
          ? {
              name: writing.name,
              content: writing.currentRevision.content,
              include: true,
            }
          : {
              name: t('content_studio_setup_default_voice', 'Brand voice'),
              content: emptyWritingProfileContent(),
              include: true,
            },
        audiences: [
          audience
            ? {
                name: audience.name,
                content: audience.currentRevision.content,
                include: true,
              }
            : {
                name: t(
                  'content_studio_setup_default_audience',
                  'Main audience'
                ),
                content: emptyAudienceProfileContent(),
                include: true,
              },
        ],
        expertise: expertise
          ? {
              name: expertise.name,
              content: expertise.currentRevision.content,
              include: true,
            }
          : {
              name: t(
                'content_studio_setup_default_expertise',
                'Core expertise'
              ),
              content: emptyExpertiseProfileContent(),
              include: true,
            },
        editorial: {
          content:
            policy.currentRevision?.content ?? emptyEditorialPolicyContent(),
          include: true,
        },
      };
      const savedBase = contentStudioSavedSetupBase({
        brandKit: {
          latestRevisionNumber: brandKit.latestRevisionNumber,
          description: kit?.identity?.description ?? '',
        },
        writing,
        audience,
        expertise,
        policy: {
          latestRevisionNumber: policy.latestRevisionNumber,
          hasRevision: !!policy.currentRevision,
        },
      });
      const saved = loadContentStudioSetupDraft<SetupDraft>(organizationId);
      const choice = chooseContentStudioSetupStart(saved, savedBase);
      const language =
        [audience?.currentRevision.content.locale, i18next.resolvedLanguage]
          .map((value) => value?.split('-')[0])
          .find((value) => LANGUAGES.some((entry) => entry.value === value)) ??
        'en';
      if (choice === 'saved') {
        // the saved setup, nothing left to save: step 4, with every earlier
        // step done and open for a revisit
        clearContentStudioSetupDraft(organizationId);
        setDraft({
          v: 1,
          step: 4,
          connectionId: null,
          manual: false,
          company: {
            ...emptySetupCompany(language),
            companyName: kit?.identity?.brandName ?? '',
            tagline: kit?.identity?.tagline ?? '',
            description: kit?.identity?.description ?? '',
          },
          source: 'saved',
          profile: existing.current,
          saved: {
            brand: true,
            writing: true,
            audiences: [0],
            expertise: true,
            editorial: true,
          },
          base: savedBase,
        });
        return;
      }
      if (choice === 'resume' && saved) {
        // a draft kept before the tagline field starts from the Brand Kit's
        setDraft({
          ...saved,
          company: {
            ...saved.company,
            tagline: saved.company.tagline ?? kit?.identity?.tagline ?? '',
          },
        });
        return;
      }
      setDraft({
        v: 1,
        step: 1,
        connectionId: null,
        manual: false,
        company: {
          ...emptySetupCompany(language),
          companyName: kit?.identity?.brandName ?? '',
          tagline: kit?.identity?.tagline ?? '',
          description: kit?.identity?.description ?? '',
        },
        source: null,
        profile: null,
        saved: {},
      });
    } catch {
      setLoadError(true);
    }
  }, [organizationId]);

  useEffect(() => {
    load();
  }, [load]);

  // every change is kept, so the assistant can be left and resumed
  useEffect(() => {
    if (draft && !done && !leaving) {
      saveContentStudioSetupDraft(organizationId, draft);
    }
  }, [draft, done, leaving, organizationId]);

  const update = useCallback(
    (patch: Partial<SetupDraft>) =>
      setDraft((current) => (current ? { ...current, ...patch } : current)),
    []
  );
  const updateProfile = useCallback(
    (patch: Partial<SetupProfile>) =>
      setDraft((current) =>
        current?.profile
          ? { ...current, profile: { ...current.profile, ...patch }, saved: {} }
          : current
      ),
    []
  );

  // the one chosen in step 1, else one whose last test did not fail
  const connectionId =
    draft?.connectionId && usable.some((c) => c.id === draft.connectionId)
      ? draft.connectionId
      : (
          usable.find(
            (connection) => aiConnectionHealth(connection) !== 'attention'
          ) ?? usable[0]
        )?.id ?? null;

  // Waits for a started draft. A look that gets no answer from the server
  // (the page was put away, the network dropped) is simply made again: the
  // draft goes on on the server meanwhile. Null when the user moved on
  const awaitProposal = useCallback(
    async (operationId: string, mine: number) => {
      for (;;) {
        if (mine !== attempt.current) {
          return null;
        }
        try {
          const state = await setup.getSetupProposal(operationId);
          if (state.status === 'succeeded') {
            return state.proposal;
          }
          if (state.status === 'failed') {
            throw new ContentStudioRequestError(502, state.code);
          }
        } catch (err) {
          if (err instanceof ContentStudioRequestError && err.code) {
            throw err;
          }
        }
        await waitForNextAIOperationPoll();
      }
    },
    [setup]
  );

  // The draft of a started operation, applied only while that operation is
  // still the one the assistant waits for: an older answer never replaces a
  // newer one
  const settle = useCallback(
    (
      operationId: string,
      section: SetupPending['section'],
      proposal: ContentStudioSetupProposal | null
    ) =>
      setDraft((current) => {
        if (!current || current.pending?.operationId !== operationId) {
          return current;
        }
        if (!proposal) {
          return { ...current, pending: null };
        }
        const next = setupProfileFromProposal(
          proposal,
          current.company.tagline
        );
        if (section === 'all') {
          return {
            ...current,
            step: 3,
            source: 'ai',
            manual: false,
            profile: next,
            saved: {},
            pending: null,
          };
        }
        return current.profile
          ? {
              ...current,
              profile: { ...current.profile, [section]: next[section] },
              saved: {},
              pending: null,
            }
          : { ...current, pending: null };
      }),
    []
  );

  const providerName =
    (providers.data || []).find(
      (provider) =>
        provider.provider ===
        usable.find((connection) => connection.id === connectionId)?.provider
    )?.displayName || t('content_studio_setup_ai_provider', 'The AI provider');

  // A failed draft: the specific reason, and whether the connection is the
  // problem. The server marks the connection on an account problem, so the
  // list is read again for step 1 and Brand & AI
  const failed = useCallback(
    (err: unknown) => {
      const message = setupAIErrorMessage(t, err, providerName);
      const same = lastFailure.current === message;
      lastFailure.current = message;
      setGenerateError(message);
      setConnectionProblem(isSetupConnectionError(err));
      setFailures((count) => (same ? count + 1 : 1));
      if (isSetupConnectionError(err)) {
        connections.mutate();
      }
    },
    [t, providerName, connections]
  );

  // Follows a started draft to its end: its result, or its failure with
  // the specific reason. A resumed one says it is still working
  const follow = useCallback(
    async (pending: SetupPending, mine: number, started: number) => {
      try {
        const proposal = await awaitProposal(pending.operationId, mine);
        if (proposal && mine === attempt.current) {
          if (pending.section === 'all') {
            setFailures(0);
            lastFailure.current = null;
          }
          settle(pending.operationId, pending.section, proposal);
        }
      } catch (err) {
        // A retry that a provider refuses at once would otherwise flash the
        // wait for a moment only and look like a click that did nothing
        const shown = Date.now() - started;
        if (lastFailure.current !== null && shown < SETUP_MIN_WAIT_MS) {
          await new Promise((resolve) =>
            setTimeout(resolve, SETUP_MIN_WAIT_MS - shown)
          );
        }
        // the company information stays as typed
        if (mine === attempt.current) {
          settle(pending.operationId, pending.section, null);
          failed(err);
        }
      } finally {
        if (mine === attempt.current) {
          busy.current = false;
          setGenerating(false);
          setRegenerating(null);
          setStillWorking(false);
        }
      }
    },
    [awaitProposal, settle, failed]
  );

  // Starts one AI draft on the server, of the whole profile or one section,
  // and keeps its operation with the assistant before waiting for it
  const start = useCallback(
    async (section: SetupPending['section']) => {
      if (busy.current || !draft || !connectionId) {
        return;
      }
      busy.current = true;
      const mine = ++attempt.current;
      const started = Date.now();
      setGenerateError(null);
      if (section === 'all') {
        setGenerating(true);
        setConnectionProblem(false);
        update({ step: 3 });
      } else {
        setRegenerating(section);
      }
      let operationId: string;
      try {
        ({ operationId } = await setup.startSetupProposal(
          connectionId,
          draft.company
        ));
      } catch (err) {
        const shown = Date.now() - started;
        if (lastFailure.current !== null && shown < SETUP_MIN_WAIT_MS) {
          await new Promise((resolve) =>
            setTimeout(resolve, SETUP_MIN_WAIT_MS - shown)
          );
        }
        if (mine === attempt.current) {
          failed(err);
          busy.current = false;
          setGenerating(false);
          setRegenerating(null);
        }
        return;
      }
      if (mine !== attempt.current) {
        return;
      }
      const pending = { operationId, section };
      update({ pending });
      await follow(pending, mine, started);
    },
    [draft, connectionId, setup, update, follow, failed]
  );

  const generate = useCallback(() => start('all'), [start]);

  // A draft that was still being made when the assistant was left (a
  // reload, a phone that put the browser away) is picked up again. A draft
  // this page started itself is already followed (busy)
  const pending = draft?.pending;
  useEffect(() => {
    if (!pending || busy.current) {
      return;
    }
    busy.current = true;
    const mine = ++attempt.current;
    setStillWorking(true);
    if (pending.section === 'all') {
      setGenerating(true);
    } else {
      setRegenerating(pending.section);
    }
    follow(pending, mine, Date.now());
  }, [pending, follow]);

  // a page that is left stops waiting; the draft goes on on the server
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    []
  );

  // leaving a running AI request: its answer will be dropped
  const abandon = useCallback(() => {
    attempt.current += 1;
    busy.current = false;
    setGenerating(false);
    setRegenerating(null);
    setStillWorking(false);
    setDraft((current) =>
      current?.pending ? { ...current, pending: null } : current
    );
  }, []);

  // Tests a connection and records the result on it (an admin only; the
  // server refuses others). The list reloads with the new status
  const testConnection = useCallback(
    async (id: string) => {
      tested.current.add(id);
      setTesting(id);
      try {
        await connectionActions.testConnection(id);
      } catch {
        // the status stays as it was; the connection can be tested again
      } finally {
        setTesting((current) => (current === id ? null : current));
      }
    },
    [connectionActions]
  );

  // back to step 1 to fix the connection; the company information stays
  const fixConnection = useCallback(() => {
    abandon();
    setGenerateError(null);
    setConnectionProblem(false);
    setFailures(0);
    lastFailure.current = null;
    if (connectionId) {
      tested.current.delete(connectionId);
    }
    update({ step: 1 });
  }, [abandon, connectionId, update]);

  // "Finish later": Home stops opening the assistant until it is continued;
  // what was typed stays kept for "Continue setup"
  const finishLater = useCallback(() => {
    setContentStudioSetupHidden(organizationId, true);
  }, [organizationId]);

  // Step 1 asks the provider once per visit whether the chosen connection
  // works (an admin only: members cannot test): the provider decides how,
  // e.g. Anthropic answers one token, since only that shows missing credit
  const step = draft?.step;
  useEffect(() => {
    if (
      step === 1 &&
      canManageAI &&
      connectionId &&
      !tested.current.has(connectionId)
    ) {
      testConnection(connectionId);
    }
  }, [step, canManageAI, connectionId, testConnection]);

  const continueManually = useCallback(() => {
    abandon();
    setGenerateError(null);
    setConnectionProblem(false);
    update({
      step: 3,
      manual: true,
      source: 'manual',
      profile: draft?.profile ?? existing.current,
      saved: {},
    });
  }, [update, draft?.profile, abandon]);

  // a new AI suggestion for one section only; the rest stays as reviewed
  const regenerate = useCallback(
    (section: SetupSection) => start(section),
    [start]
  );

  // Saves what was reviewed, in a fixed order, each part in its own request.
  // A part that was saved is not saved again when Save is pressed after a
  // failure. With firstPost (an AI connection is ready), the first post is
  // started next and the assistant goes to it: research and draft run on
  // the server, and a failure to start them leaves the saved profile saved
  const save = useCallback(
    async (firstPost = false) => {
      if (!draft?.profile || busy.current) {
        return;
      }
      busy.current = true;
      setSaving(true);
      setSaveError(null);
      const profile = draft.profile;
      const saved: SetupSaved = { ...draft.saved };
      const keep = () => update({ saved: { ...saved } });
      const upsert = async <C,>(
        base: ContentStudioProfilesPath,
        actions: typeof writingActions,
        named: Named<C>
      ) => {
        const name = named.name.trim();
        const same = await setup.findActiveProfile(base, name);
        if (!same) {
          await actions.createProfile(name, named.content);
          return;
        }
        const current = await setup.getProfile<C>(base, same.id);
        await actions.saveRevision(
          same.id,
          current.currentRevision.revisionNumber,
          named.content
        );
      };
      try {
        if (profile.brand.include && !saved.brand) {
          const kit = await setup.getBrandKit();
          await setup.saveBrandKit(
            kit.latestRevisionNumber,
            brandKitWithIdentity(kit.currentRevision?.content, {
              brandName: draft.company.companyName,
              tagline: profile.brand.tagline,
              description: profile.brand.description,
            })
          );
          saved.brand = true;
          keep();
        }
        if (profile.writing.include && !saved.writing) {
          await upsert(WRITING_PROFILES_PATH, writingActions, profile.writing);
          saved.writing = true;
          keep();
        }
        for (const [index, audience] of profile.audiences.entries()) {
          if (audience.include && !saved.audiences?.includes(index)) {
            await upsert(AUDIENCE_PROFILES_PATH, audienceActions, audience);
            saved.audiences = [...(saved.audiences || []), index];
            keep();
          }
        }
        if (profile.expertise.include && !saved.expertise) {
          await upsert(
            EXPERTISE_PROFILES_PATH,
            expertiseActions,
            profile.expertise
          );
          saved.expertise = true;
          keep();
        }
        if (profile.editorial.include && !saved.editorial) {
          const policy = await setup.getEditorialPolicy();
          // the approval workflow and the research focus are not part of the
          // assistant: kept as they are
          const workflow = policy.currentRevision?.content.workflow;
          const research = policy.currentRevision?.content.research;
          const {
            workflow: _ignored,
            research: _kept,
            ...rules
          } = profile.editorial.content;
          await policyActions.saveRevision(policy.latestRevisionNumber, {
            ...rules,
            ...(workflow ? { workflow } : {}),
            ...(research ? { research } : {}),
          });
          saved.editorial = true;
          keep();
        }
        clearContentStudioSetupDraft(organizationId);
        setContentStudioSetupHidden(organizationId, false);
        if (!firstPost || !connectionId) {
          setDone(true);
          return;
        }
        setLeaving(true);
        if (
          firstPostState.data?.package &&
          !firstPostState.data.package.archived
        ) {
          router.push(FIRST_POST_PAGE);
          return;
        }
        let target = FIRST_POST_PAGE;
        try {
          await firstPostActions.start({
            connectionId,
            mode: 'first',
            language: draft.company.language,
            name: t('content_studio_first_post_name', 'First post'),
          });
        } catch (err) {
          // the profile is saved: the first post page says what failed (a
          // start already on its way is followed there as it is)
          target =
            err instanceof ContentStudioRequestError &&
            err.code === 'CS_FIRST_POST_STARTING'
              ? FIRST_POST_PAGE
              : `${FIRST_POST_PAGE}?error=${encodeURIComponent(
                  (err instanceof ContentStudioRequestError && err.code) ||
                    'CS_AI_PROVIDER_UNAVAILABLE'
                )}`;
        }
        router.push(target);
      } catch (err) {
        setSaveError(profileErrorMessage(t, 'writing', err));
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [
      draft,
      setup,
      writingActions,
      audienceActions,
      expertiseActions,
      policyActions,
      organizationId,
      update,
      t,
      connectionId,
      firstPostActions,
      firstPostState.data?.package,
      router,
    ]
  );

  const newPackage = () =>
    modals.openModal({
      title: t('content_studio_new_package', 'New package'),
      children: (close: () => void) => (
        <CreateContentStudioPackageModal close={close} />
      ),
    });

  // a focused page: no section navigation or breadcrumbs, one quiet way out
  // ("Finish later") in the header
  const shell = (children: ReactNode) => (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[24px] min-w-0">
      <div className="w-full max-w-[880px] mx-auto flex flex-col gap-[28px] pt-[8px]">
        {children}
      </div>
    </div>
  );

  if (loadError) {
    return shell(
      <div className="flex flex-col items-center gap-[12px] py-[40px]">
        <div role="alert">
          {t('content_studio_load_error', 'Could not load Content Studio.')}
        </div>
        <Button secondary onClick={load}>
          {t('content_studio_retry', 'Try again')}
        </Button>
      </div>
    );
  }
  if (!draft || !connections.data || !providers.data) {
    return shell(
      <ContentStudioLoading
        label={t(
          'content_studio_setup_loading',
          'Opening the setup assistant…'
        )}
      />
    );
  }

  if (done && draft.profile) {
    const profile = draft.profile;
    const items = [
      profile.brand.include &&
        t('content_studio_setup_done_brand', 'Your company description'),
      profile.writing.include &&
        t('content_studio_setup_done_writing', 'Your writing style'),
      profile.audiences.some((a) => a.include) &&
        t('content_studio_setup_done_audience', 'Your audiences'),
      profile.expertise.include &&
        t('content_studio_setup_done_expertise', 'Your expertise'),
      profile.editorial.include &&
        t('content_studio_setup_done_editorial', 'Your editorial rules'),
    ].filter(Boolean) as string[];
    return shell(
      <section className="flex flex-col items-center text-center gap-[16px] py-[32px]">
        <span
          aria-hidden="true"
          className="w-[56px] h-[56px] rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] flex items-center justify-center text-[28px]"
        >
          {'✓'}
        </span>
        <h1 className="text-[24px] font-[600]">
          {t('content_studio_setup_ready', 'Your Content Studio is ready')}
        </h1>
        <div className="text-textItemBlur">
          {t('content_studio_setup_we_set_up', 'We set up:')}
        </div>
        <ul className="flex flex-col gap-[6px] text-start">
          {items.map((item) => (
            <li key={item} className="flex items-center gap-[8px]">
              <span aria-hidden="true">{'✓'}</span>
              {item}
            </li>
          ))}
        </ul>
        <div className="text-[14px] text-textItemBlur max-w-[520px]">
          {t(
            'content_studio_setup_ready_hint',
            'You can change all of it later under Brand & AI. Every AI suggestion now starts from it.'
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-[8px] pt-[8px]">
          <Button onClick={newPackage}>
            {t(
              'content_studio_setup_first_content',
              'Create your first content'
            )}
          </Button>
          <Link
            href="/content-studio/sources"
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_setup_add_sources', 'Add sources')}
          </Link>
          <Link
            href={CONTENT_STUDIO_HOME_PATH}
            className="px-[24px] h-[40px] flex items-center rounded-full text-textColor underline"
          >
            {t('content_studio_setup_to_home', 'Go to Content Studio')}
          </Link>
        </div>
      </section>
    );
  }

  const company = draft.company;
  // A changed company name is saved again with the profile (its tagline
  // and description go into the profile on Next); the language is not
  // part of the Brand Kit
  const setCompany = (patch: Partial<ContentStudioSetupCompany>) =>
    update({
      company: { ...company, ...patch },
      ...('companyName' in patch
        ? { saved: { ...draft.saved, brand: false } }
        : {}),
    });
  // Next from step 2 with a profile: a tagline or description changed here
  // is the profile's now, and is saved with it
  const nextWithProfile = () => {
    const profile = draft.profile;
    const tagline = (company.tagline ?? '').trim();
    const description = company.description.trim();
    if (
      profile &&
      (tagline !== profile.brand.tagline ||
        description !== profile.brand.description)
    ) {
      update({
        step: 3,
        profile: {
          ...profile,
          brand: { ...profile.brand, tagline, description },
        },
        saved: { ...draft.saved, brand: false },
      });
      return;
    }
    update({ step: 3 });
  };
  const companyReady =
    !!company.companyName.trim() &&
    !!company.description.trim() &&
    company.companyName.length <= COMPANY_NAME_MAX &&
    (company.tagline ?? '').length <= TAGLINE_MAX &&
    company.description.length <= DESCRIPTION_MAX &&
    company.website.length <= WEBSITE_MAX &&
    company.goal.length <= NOTE_MAX &&
    company.audience.length <= NOTE_MAX &&
    isSetupWebsite(company.website);
  const selected = usable.find((c) => c.id === connectionId);
  // Ready only after a test of the key and its model succeeded. A connection
  // that was never tested is used as it is when nobody here may test it
  const health = !selected
    ? null
    : testing === selected.id
    ? 'testing'
    : aiConnectionHealth(selected);
  const aiReady =
    !!connectionId &&
    !draft.manual &&
    (health === 'ready' || health === 'untested');

  // a saved setup is only being looked at again: the way out is back, not
  // "later"
  const finishLaterLink = (
    <Link
      href={CONTENT_STUDIO_HOME_PATH}
      onClick={draft.base ? undefined : finishLater}
      className="shrink-0 whitespace-nowrap pt-[4px] text-[13px] text-textItemBlur hover:text-newTextColor hover:underline"
    >
      {draft.base
        ? t('content_studio_setup_back_to_studio', 'Back to Content Studio')
        : t('content_studio_setup_later', 'Finish later')}
    </Link>
  );

  const header = (
    <div className="flex flex-col gap-[20px]">
      <div className="flex items-start gap-[12px]">
        <div className="flex flex-col gap-[6px] flex-1 min-w-0">
          <h1 className="text-[20px] sm:text-[22px] font-[600] break-words">
            {t('content_studio_setup_heading', 'Set up Content Studio')}
          </h1>
          <div className="text-[13px] sm:text-[14px] text-textItemBlur max-w-[620px]">
            {t(
              'content_studio_setup_subtitle',
              'A few questions about your company; AI drafts your content profile and you review it. You can stop at any time and continue later.'
            )}
          </div>
        </div>
        {finishLaterLink}
      </div>
      <WizardProgress
        step={draft.step}
        canOpen={(step) =>
          canOpenSetupStep(draft, step) && !generating && !saving
        }
        onOpen={(step) => update({ step })}
      />
    </div>
  );

  // --- step 1: AI ---
  if (draft.step === 1) {
    return shell(
      <>
        {header}
        <section className="flex flex-col gap-[16px]">
          <h2 className="text-[18px] font-[600]">
            {t('content_studio_setup_ai_title', 'Connect AI')}
          </h2>
          {usable.length ? (
            <div className="flex flex-col gap-[12px]">
              {usable.length > 1 && (
                <ChoiceField
                  label={t(
                    'content_studio_setup_ai_use',
                    'Use this AI connection'
                  )}
                  value={connectionId || ''}
                  options={usable.map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                  }))}
                  onChange={(next) => update({ connectionId: next })}
                />
              )}
              {health === 'testing' ? (
                <div
                  role="status"
                  className="flex items-center gap-[10px] p-[14px] rounded-[12px] bg-newBgLineColor"
                >
                  <span
                    aria-hidden="true"
                    className="w-[16px] h-[16px] rounded-full border-2 border-[var(--brand-primary,#612ad5)] border-t-transparent animate-spin"
                  />
                  <span>
                    {t(
                      'content_studio_setup_ai_testing',
                      'Checking your AI connection…'
                    )}
                  </span>
                </div>
              ) : health === 'attention' ? (
                <div
                  role="alert"
                  className="flex flex-col gap-[10px] p-[14px] rounded-[12px] border border-red-500/60"
                >
                  <div className="flex items-center gap-[10px] font-[600]">
                    <span aria-hidden="true" className="text-red-400">
                      {'!'}
                    </span>
                    {t(
                      'content_studio_setup_ai_attention',
                      'AI needs attention'
                    )}
                  </div>
                  <div className="text-[14px]">
                    {aiValidationCodeMessage(
                      t,
                      selected?.lastValidationCode ?? null
                    )}
                  </div>
                  <div className="flex flex-col items-stretch sm:flex-row sm:flex-wrap sm:items-center gap-[8px]">
                    {canManageAI && (
                      <Link
                        href="/content-studio/intelligence?tab=ai"
                        className="h-[40px] px-[16px] flex items-center justify-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)] text-[14px] font-[600]"
                      >
                        {t(
                          'content_studio_setup_fix_connection',
                          'Fix connection'
                        )}
                      </Link>
                    )}
                    {canManageAI && !!selected && (
                      <Button
                        secondary
                        onClick={() => testConnection(selected.id)}
                      >
                        {t('content_studio_setup_test_again', 'Test again')}
                      </Button>
                    )}
                  </div>
                </div>
              ) : health === 'ready' ? (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-[10px] p-[14px] rounded-[12px] bg-newBgLineColor"
                >
                  <span aria-hidden="true" className="text-[18px]">
                    {'✓'}
                  </span>
                  <span className="font-[600]">
                    {t('content_studio_setup_ai_ready', 'AI is ready')}
                  </span>
                  {!!selected && (
                    <span className="text-[13px] text-textItemBlur">
                      {selected.name}
                    </span>
                  )}
                </div>
              ) : (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-[10px] p-[14px] rounded-[12px] bg-newBgLineColor"
                >
                  {!!selected && (
                    <AIConnectionHealthBadge connection={selected} />
                  )}
                  <span className="text-[14px] text-textItemBlur">
                    {canManageAI
                      ? t(
                          'content_studio_setup_ai_untested',
                          'This connection has not been tested yet.'
                        )
                      : t(
                          'content_studio_setup_ai_untested_member',
                          'An admin can test this connection under Brand & AI.'
                        )}
                  </span>
                  {canManageAI && !!selected && (
                    <Button
                      secondary
                      onClick={() => testConnection(selected.id)}
                    >
                      {t('content_studio_ai_test', 'Test')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : canManageAI ? (
            <div className="flex flex-col gap-[12px]">
              <div className="text-textItemBlur">
                {t(
                  'content_studio_setup_ai_connect_hint',
                  'Connect your own OpenAI, Anthropic or OpenRouter account with an API key. Content Studio uses it to draft your profile now and your posts later.'
                )}
              </div>
              <div className="p-[16px] rounded-[12px] border border-newTableBorder">
                <AIConnectionCreateForm
                  providers={providers.data}
                  onCancel={() => undefined}
                  // step 1 tests the new connection itself
                  testAfterCreate={false}
                  onCreated={() => update({ manual: false })}
                />
              </div>
            </div>
          ) : (
            <div className="text-textItemBlur">
              {t(
                'content_studio_setup_ai_admin',
                'An admin of your organization can connect AI under Brand & AI. Until then you can set up Content Studio by hand.'
              )}
            </div>
          )}
          <div className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_setup_ai_optional',
              'AI is recommended, not required: without it you fill in your profile yourself.'
            )}
          </div>
          <div className="flex flex-col-reverse items-stretch sm:flex-row sm:flex-wrap sm:items-center gap-[8px] sm:justify-end pt-[16px] border-t border-newTableBorder">
            {(!usable.length || health === 'attention') && (
              <Button
                secondary
                onClick={() => update({ manual: true, step: 2 })}
              >
                {usable.length
                  ? t(
                      'content_studio_setup_continue_manually',
                      'Continue manually'
                    )
                  : t('content_studio_setup_without_ai', 'Continue without AI')}
              </Button>
            )}
            {!!usable.length && health !== 'attention' && (
              <Button
                disabled={health === 'testing'}
                onClick={() => update({ manual: false, connectionId, step: 2 })}
              >
                {t('content_studio_setup_next', 'Next')}
              </Button>
            )}
          </div>
        </section>
      </>
    );
  }

  // --- step 2: your company ---
  if (draft.step === 2) {
    return shell(
      <>
        {header}
        <section className="flex flex-col gap-[16px]">
          <h2 className="text-[18px] font-[600]">
            {t(
              'content_studio_setup_company_title',
              'Tell us about your company'
            )}
          </h2>
          <ShortTextField
            label={t('content_studio_setup_company_name', 'Company name')}
            value={company.companyName}
            onChange={(companyName) => setCompany({ companyName })}
          />
          <ShortTextField
            label={t('content_studio_setup_tagline', 'Tagline (optional)')}
            hint={t(
              'content_studio_setup_tagline_hint',
              'Your slogan or one line about what you stand for. AI keeps it as you wrote it; leave it empty and AI suggests one.'
            )}
            value={company.tagline ?? ''}
            onChange={(tagline) => setCompany({ tagline })}
          />
          <LongTextField
            label={t(
              'content_studio_setup_company_description',
              'What does your company do?'
            )}
            hint={t(
              'content_studio_setup_company_description_hint',
              'A few sentences: what you offer, for whom, and what makes you different. The more concrete, the better the draft.'
            )}
            rows={6}
            autoGrow={true}
            value={company.description}
            onChange={(description) => setCompany({ description })}
          />
          {/* side by side where both fit, one under the other on a phone */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-[16px] items-start">
            <WebsiteField
              value={company.website}
              onChange={(website) => setCompany({ website })}
            />
            <ChoiceField
              label={t(
                'content_studio_setup_language',
                'Language of your posts'
              )}
              value={company.language}
              options={LANGUAGES}
              onChange={(language) => setCompany({ language })}
            />
          </div>
          <LongTextField
            label={t(
              'content_studio_setup_goal',
              'Main goal of your posts (optional)'
            )}
            hint={t(
              'content_studio_setup_goal_hint',
              'e.g. more inbound leads, recruiting, being known as the expert in your field'
            )}
            rows={3}
            autoGrow={true}
            value={company.goal}
            onChange={(goal) => setCompany({ goal })}
          />
          <LongTextField
            label={t(
              'content_studio_setup_audience',
              'Who do you write for? (optional)'
            )}
            hint={t(
              'content_studio_setup_audience_hint',
              'e.g. owners of small businesses in the Netherlands who do their own marketing'
            )}
            rows={3}
            autoGrow={true}
            value={company.audience}
            onChange={(audience) => setCompany({ audience })}
          />
          <div className="flex flex-col-reverse items-stretch sm:flex-row sm:flex-wrap sm:items-center gap-[8px] sm:justify-end pt-[16px] border-t border-newTableBorder">
            <Button secondary onClick={() => update({ step: 1 })}>
              {t('content_studio_setup_back', 'Back')}
            </Button>
            {draft.profile ? (
              // a profile exists (saved, or drafted on this visit): Next goes
              // on with it; a new AI draft is only made when asked for
              <>
                {aiReady && (
                  <Button secondary disabled={!companyReady} onClick={generate}>
                    {t(
                      'content_studio_setup_draft_again_with_ai',
                      'Draft a new profile with AI'
                    )}
                  </Button>
                )}
                <Button disabled={!companyReady} onClick={nextWithProfile}>
                  {t('content_studio_setup_next', 'Next')}
                </Button>
              </>
            ) : aiReady ? (
              <>
                <Button
                  secondary
                  disabled={!companyReady}
                  onClick={continueManually}
                >
                  {t('content_studio_setup_fill_myself', 'Fill in myself')}
                </Button>
                <Button disabled={!companyReady} onClick={generate}>
                  {t(
                    'content_studio_setup_draft_with_ai',
                    'Draft my profile with AI'
                  )}
                </Button>
              </>
            ) : (
              <Button disabled={!companyReady} onClick={continueManually}>
                {t('content_studio_setup_next', 'Next')}
              </Button>
            )}
          </div>
        </section>
      </>
    );
  }

  // --- step 3: the content profile ---
  if (draft.step === 3) {
    const profile = draft.profile;
    // Regenerate is offered for a profile an AI drafted or one saved
    // before; it runs only when pressed
    const ai =
      (draft.source === 'ai' || draft.source === 'saved') && !!connectionId;
    let body: ReactNode;
    if (generating) {
      body = (
        <ContentStudioLoading
          label={
            stillWorking
              ? t(
                  'content_studio_setup_still_generating',
                  'Still drafting your content profile…'
                )
              : failures
              ? t('content_studio_setup_retrying', 'Trying again…')
              : t(
                  'content_studio_setup_generating',
                  'Drafting your content profile…'
                )
          }
          detail={t(
            'content_studio_setup_generating_hint_background',
            'This takes about a minute. You can switch to another app: we keep working and show the result when you are back.'
          )}
        />
      );
    } else if (!profile) {
      body = (
        <div className="flex flex-col items-center gap-[12px] py-[24px] text-center">
          <div role="alert" className="flex flex-col gap-[6px] max-w-[560px]">
            <span className="font-[600]">
              {generateError ||
                t(
                  'content_studio_setup_ai_error',
                  "We couldn't generate suggestions right now."
                )}
            </span>
            {failures > 1 && (
              <span className="text-[13px] text-textItemBlur">
                {t(
                  'content_studio_setup_tried_again',
                  'Tried again just now ({{count}} tries): the same problem came back.',
                  { count: failures }
                )}
              </span>
            )}
          </div>
          <div className="text-[14px] text-textItemBlur max-w-[560px]">
            {t(
              'content_studio_setup_kept',
              'Everything you entered is kept. Try again, fix the AI connection, or fill in the profile yourself.'
            )}
          </div>
          <div className="flex flex-col items-stretch w-full sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center gap-[8px]">
            {aiReady && (
              <Button secondary={connectionProblem} onClick={generate}>
                {t('content_studio_retry', 'Try again')}
              </Button>
            )}
            {!!connectionId && (
              <Button secondary={!connectionProblem} onClick={fixConnection}>
                {t(
                  'content_studio_setup_check_connection',
                  'Check AI connection'
                )}
              </Button>
            )}
            <Button secondary onClick={continueManually}>
              {t('content_studio_setup_continue_manually', 'Continue manually')}
            </Button>
          </div>
        </div>
      );
    } else {
      const disabled = !!regenerating;
      const perspective: Record<string, string> = {
        first_singular: t(
          'content_studio_writing_first_singular',
          'First person singular — I / me'
        ),
        first_plural: t(
          'content_studio_writing_first_plural',
          'First person plural — we / us'
        ),
        second: t('content_studio_writing_second', 'Second person — you'),
        third: t(
          'content_studio_writing_third',
          'Third person — the company / they'
        ),
        mixed: t(
          'content_studio_writing_mixed',
          'Mixed — e.g. we and you, described under Voice'
        ),
      };
      body = (
        <div className="flex flex-col gap-[16px]">
          <div className="text-[14px] text-textItemBlur">
            {draft.source === 'saved'
              ? t(
                  'content_studio_setup_saved_profile',
                  'This is your saved profile. Change what you like; nothing changes until you save, and Regenerate only runs when you press it.'
                )
              : draft.source === 'ai'
              ? t(
                  'content_studio_setup_ai_drafted',
                  'We drafted this from your company description. Check each part: keep it, edit it or leave it out.'
                )
              : t(
                  'content_studio_setup_manual_intro',
                  'Fill in what you can; you can leave any part out and add it later under Brand & AI.'
                )}
          </div>
          {!!generateError && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-[12px] p-[12px] rounded-[8px] border border-newTableBorder text-[14px]"
            >
              <span className="flex-1 min-w-[200px]">{generateError}</span>
              {connectionProblem && (
                <Button secondary onClick={fixConnection}>
                  {t(
                    'content_studio_setup_check_connection',
                    'Check AI connection'
                  )}
                </Button>
              )}
            </div>
          )}
          <SuggestionCard
            title={t(
              'content_studio_setup_section_brand',
              'Company description'
            )}
            include={profile.brand.include}
            onInclude={(include) =>
              updateProfile({ brand: { ...profile.brand, include } })
            }
            disabled={disabled}
            onRegenerate={ai ? () => regenerate('brand') : undefined}
            regenerating={regenerating === 'brand'}
            summary={
              <div className="flex flex-col gap-[8px]">
                {!!profile.brand.tagline && (
                  <div className="font-[600]">{profile.brand.tagline}</div>
                )}
                <div className="text-[14px] whitespace-pre-wrap break-words">
                  {profile.brand.description ||
                    t('content_studio_list_empty', 'None yet.')}
                </div>
              </div>
            }
            editor={
              <div className="flex flex-col gap-[12px]">
                <ShortTextField
                  label={t('content_studio_company_tagline', 'Tagline')}
                  value={profile.brand.tagline}
                  onChange={(tagline) =>
                    updateProfile({ brand: { ...profile.brand, tagline } })
                  }
                />
                <LongTextField
                  label={t('content_studio_company_description', 'What you do')}
                  rows={5}
                  value={profile.brand.description}
                  onChange={(description) =>
                    updateProfile({ brand: { ...profile.brand, description } })
                  }
                />
              </div>
            }
          />
          <SuggestionCard
            title={t('content_studio_setup_section_writing', 'Writing style')}
            include={profile.writing.include}
            onInclude={(include) =>
              updateProfile({ writing: { ...profile.writing, include } })
            }
            disabled={disabled}
            onRegenerate={ai ? () => regenerate('writing') : undefined}
            regenerating={regenerating === 'writing'}
            summary={
              <div className="flex flex-col gap-[12px]">
                {!!profile.writing.content.voice && (
                  <div className="text-[14px] whitespace-pre-wrap break-words">
                    {profile.writing.content.voice}
                  </div>
                )}
                <Chips
                  values={profile.writing.content.toneTags}
                  label={t('content_studio_setup_tone', 'Tone')}
                />
                {!!profile.writing.content.perspective && (
                  <SummaryLine
                    label={t(
                      'content_studio_writing_perspective',
                      'Perspective'
                    )}
                  >
                    <div className="text-[14px]">
                      {perspective[profile.writing.content.perspective]}
                    </div>
                  </SummaryLine>
                )}
                <div className={PAIRED}>
                  {!!profile.writing.content.vocabulary.prefer.length && (
                    <SummaryLine
                      label={t(
                        'content_studio_writing_prefer',
                        'Words to prefer'
                      )}
                    >
                      <Chips
                        values={profile.writing.content.vocabulary.prefer}
                        label={t(
                          'content_studio_writing_prefer',
                          'Words to prefer'
                        )}
                        max={8}
                      />
                    </SummaryLine>
                  )}
                  {!!profile.writing.content.vocabulary.avoid.length && (
                    <SummaryLine
                      label={t(
                        'content_studio_writing_avoid',
                        'Words to avoid'
                      )}
                    >
                      <Chips
                        values={profile.writing.content.vocabulary.avoid}
                        label={t(
                          'content_studio_writing_avoid',
                          'Words to avoid'
                        )}
                        max={8}
                      />
                    </SummaryLine>
                  )}
                  {!!profile.writing.content.dos.length && (
                    <SummaryLine label={t('content_studio_writing_dos', 'Do')}>
                      <Bullets
                        values={profile.writing.content.dos}
                        label={t('content_studio_writing_dos', 'Do')}
                      />
                    </SummaryLine>
                  )}
                  {!!profile.writing.content.donts.length && (
                    <SummaryLine
                      label={t('content_studio_writing_donts', "Don't")}
                    >
                      <Bullets
                        values={profile.writing.content.donts}
                        label={t('content_studio_writing_donts', "Don't")}
                      />
                    </SummaryLine>
                  )}
                </div>
              </div>
            }
            editor={
              <div className="flex flex-col gap-[16px]">
                <NameField
                  label={t('content_studio_profile_name', 'Name')}
                  value={profile.writing.name}
                  onChange={(name) =>
                    updateProfile({ writing: { ...profile.writing, name } })
                  }
                />
                <WritingProfileForm
                  value={profile.writing.content}
                  onChange={(content) =>
                    updateProfile({ writing: { ...profile.writing, content } })
                  }
                />
              </div>
            }
          />
          {profile.audiences.map((audience, index) => {
            const setAudience = (next: Named<AudienceProfileContent>) =>
              updateProfile({
                audiences: profile.audiences.map((other, at) =>
                  at === index ? next : other
                ),
              });
            return (
              <SuggestionCard
                key={index}
                title={`${t(
                  'content_studio_setup_section_audience',
                  'Audience'
                )}: ${audience.name}`}
                include={audience.include}
                onInclude={(include) => setAudience({ ...audience, include })}
                disabled={disabled}
                onRegenerate={
                  ai && index === 0 ? () => regenerate('audiences') : undefined
                }
                regenerating={regenerating === 'audiences'}
                summary={
                  <div className="flex flex-col gap-[10px]">
                    {!!audience.content.role && (
                      <div className="font-[600] text-[14px]">
                        {audience.content.role}
                      </div>
                    )}
                    {!!audience.content.description && (
                      <div className="text-[14px] whitespace-pre-wrap break-words">
                        {audience.content.description}
                      </div>
                    )}
                    <div className={PAIRED}>
                      {!!audience.content.goals.length && (
                        <SummaryLine
                          label={t('content_studio_audience_goals', 'Goals')}
                        >
                          <Bullets
                            values={audience.content.goals}
                            label={t('content_studio_audience_goals', 'Goals')}
                          />
                        </SummaryLine>
                      )}
                      {!!audience.content.painPoints.length && (
                        <SummaryLine
                          label={t(
                            'content_studio_audience_pain_points',
                            'Pain points'
                          )}
                        >
                          <Bullets
                            values={audience.content.painPoints}
                            label={t(
                              'content_studio_audience_pain_points',
                              'Pain points'
                            )}
                          />
                        </SummaryLine>
                      )}
                    </div>
                  </div>
                }
                editor={
                  <div className="flex flex-col gap-[16px]">
                    <NameField
                      label={t('content_studio_profile_name', 'Name')}
                      value={audience.name}
                      onChange={(name) => setAudience({ ...audience, name })}
                    />
                    <AudienceProfileForm
                      value={audience.content}
                      onChange={(content) =>
                        setAudience({ ...audience, content })
                      }
                    />
                  </div>
                }
              />
            );
          })}
          <SuggestionCard
            title={t('content_studio_setup_section_expertise', 'Expertise')}
            include={profile.expertise.include}
            onInclude={(include) =>
              updateProfile({ expertise: { ...profile.expertise, include } })
            }
            disabled={disabled}
            onRegenerate={ai ? () => regenerate('expertise') : undefined}
            regenerating={regenerating === 'expertise'}
            summary={
              <div className="flex flex-col gap-[10px]">
                <Chips
                  values={profile.expertise.content.subjects}
                  label={t('content_studio_setup_subjects', 'Subjects')}
                />
                {!!profile.expertise.content.differentiators.length && (
                  <SummaryLine
                    label={t(
                      'content_studio_setup_differentiators',
                      'What sets you apart'
                    )}
                  >
                    <Bullets
                      values={profile.expertise.content.differentiators}
                      label={t(
                        'content_studio_setup_differentiators',
                        'What sets you apart'
                      )}
                    />
                  </SummaryLine>
                )}
              </div>
            }
            editor={
              <div className="flex flex-col gap-[16px]">
                <NameField
                  label={t('content_studio_profile_name', 'Name')}
                  value={profile.expertise.name}
                  onChange={(name) =>
                    updateProfile({ expertise: { ...profile.expertise, name } })
                  }
                />
                <ExpertiseProfileForm
                  value={profile.expertise.content}
                  onChange={(content) =>
                    updateProfile({
                      expertise: { ...profile.expertise, content },
                    })
                  }
                />
              </div>
            }
          />
          <SuggestionCard
            title={t(
              'content_studio_setup_section_editorial',
              'Editorial rules'
            )}
            include={profile.editorial.include}
            onInclude={(include) =>
              updateProfile({ editorial: { ...profile.editorial, include } })
            }
            disabled={disabled}
            onRegenerate={ai ? () => regenerate('editorial') : undefined}
            regenerating={regenerating === 'editorial'}
            summary={
              <div className={PAIRED}>
                {!!profile.editorial.content.principles.length && (
                  <SummaryLine
                    label={t('content_studio_policy_principles', 'Principles')}
                  >
                    <Bullets
                      values={profile.editorial.content.principles}
                      label={t(
                        'content_studio_policy_principles',
                        'Principles'
                      )}
                      max={4}
                    />
                  </SummaryLine>
                )}
                {!!profile.editorial.content.claimRules.length && (
                  <SummaryLine
                    label={t(
                      'content_studio_policy_claim_rules',
                      'Claim rules'
                    )}
                  >
                    <Bullets
                      values={profile.editorial.content.claimRules}
                      label={t(
                        'content_studio_policy_claim_rules',
                        'Claim rules'
                      )}
                      max={2}
                    />
                  </SummaryLine>
                )}
                {!!profile.editorial.content.prohibitedTopics.length && (
                  <SummaryLine
                    label={t(
                      'content_studio_setup_prohibited',
                      'Topics to stay away from'
                    )}
                  >
                    <Chips
                      values={profile.editorial.content.prohibitedTopics}
                      label={t(
                        'content_studio_setup_prohibited',
                        'Topics to stay away from'
                      )}
                      max={6}
                    />
                  </SummaryLine>
                )}
              </div>
            }
            editor={
              <EditorialPolicyForm
                value={profile.editorial.content}
                onChange={(content) =>
                  updateProfile({
                    editorial: { ...profile.editorial, content },
                  })
                }
              />
            }
          />
        </div>
      );
    }
    const namesValid =
      !profile ||
      [profile.writing, profile.expertise, ...profile.audiences]
        .filter((entry) => entry.include)
        .every((entry) => !!entry.name.trim() && entry.name.length <= NAME_MAX);
    return shell(
      <>
        {header}
        <section className="flex flex-col gap-[16px]">
          <h2 className="text-[18px] font-[600]">
            {t('content_studio_setup_profile_title', 'Your content profile')}
          </h2>
          {body}
          <div className="flex flex-col-reverse items-stretch sm:flex-row sm:flex-wrap sm:items-center gap-[8px] sm:justify-end pt-[8px] border-t border-newTableBorder">
            {!namesValid && (
              <span role="alert" className="text-[13px] me-auto">
                {t(
                  'content_studio_setup_names_required',
                  'Every profile you keep needs a name.'
                )}
              </span>
            )}
            <Button
              secondary
              onClick={() => {
                abandon();
                update({ step: 2 });
              }}
            >
              {t('content_studio_setup_back', 'Back')}
            </Button>
            <Button
              disabled={!profile || generating || !!regenerating || !namesValid}
              onClick={() => update({ step: 4 })}
            >
              {t('content_studio_setup_next', 'Next')}
            </Button>
          </div>
        </section>
      </>
    );
  }

  // --- step 4: put the profile to work ---
  // Not another summary of step 3: the profile is used at once to research
  // a topic and write the first post. Saving (with its versions) happens on
  // the way, quietly. A first post that exists already is opened, never
  // researched again
  const profile = draft.profile as SetupProfile;
  const nothing = ![
    profile.brand.include,
    profile.writing.include,
    profile.audiences.some((audience) => audience.include),
    profile.expertise.include,
    profile.editorial.include,
  ].some(Boolean);
  const unsaved =
    (profile.brand.include && !draft.saved.brand) ||
    (profile.writing.include && !draft.saved.writing) ||
    profile.audiences.some(
      (audience, index) =>
        audience.include && !draft.saved.audiences?.includes(index)
    ) ||
    (profile.expertise.include && !draft.saved.expertise) ||
    (profile.editorial.include && !draft.saved.editorial);
  // research and a draft need a working AI connection
  const withAI = !draft.manual && aiReady;
  // an archived first post is gone: a new one is made
  const hasFirstPost =
    !!firstPostState.data?.package && !firstPostState.data.package.archived;
  if (leaving) {
    return shell(
      <ContentStudioLoading
        label={
          hasFirstPost
            ? t(
                'content_studio_setup_opening_first_post',
                'Opening your first post…'
              )
            : t(
                'content_studio_setup_starting_first_post',
                'Starting your first post…'
              )
        }
      />
    );
  }
  return shell(
    <>
      {header}
      <section className="flex flex-col gap-[16px]">
        <h2 className="text-[18px] font-[600]">
          {t('content_studio_setup_profile_ready', 'Your profile is ready!')}
        </h2>
        <p className="text-[15px] max-w-[620px]">
          {withAI
            ? hasFirstPost
              ? t(
                  'content_studio_setup_first_post_exists',
                  'Your first post is waiting for you. Review it, edit it and decide whether to schedule or publish it.'
                )
              : t(
                  'content_studio_setup_first_post_intro',
                  'Content Studio can now use your company profile, audience and expertise to research a relevant topic and create your first post. You can review it, edit it and decide whether to schedule it or publish it.'
                )
            : t(
                'content_studio_setup_save_intro',
                'Your profile is ready to save. Every AI suggestion in Content Studio starts from it.'
              )}
        </p>
        {!!saveError && (
          <div
            role="alert"
            className="p-[12px] rounded-[8px] border border-newTableBorder text-[14px]"
          >
            {saveError}{' '}
            {t(
              'content_studio_setup_save_retry',
              'What was saved stays saved; Save again continues with the rest.'
            )}
          </div>
        )}
        <div className="flex flex-col-reverse items-stretch sm:flex-row sm:flex-wrap sm:items-center gap-[8px] sm:justify-end pt-[8px] border-t border-newTableBorder">
          <Button
            secondary
            disabled={saving}
            onClick={() => update({ step: 3 })}
          >
            {t('content_studio_setup_back', 'Back')}
          </Button>
          <Button
            loading={saving}
            disabled={saving || nothing}
            onClick={() => save(withAI)}
          >
            {saveError
              ? t('content_studio_setup_save_again', 'Save again')
              : withAI && hasFirstPost
              ? unsaved
                ? t(
                    'content_studio_setup_save_open_first_post',
                    'Save and open my first post'
                  )
                : t(
                    'content_studio_setup_open_first_post',
                    'Open my first post'
                  )
              : withAI
              ? t(
                  'content_studio_setup_create_first_post',
                  'Create my first post'
                )
              : unsaved
              ? t('content_studio_setup_save', 'Save setup')
              : t('content_studio_done', 'Done')}
          </Button>
        </div>
      </section>
    </>
  );
};
