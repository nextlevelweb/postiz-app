'use client';

import { FC, useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import {
  ContentStudioEditorialPolicyState,
  EDITORIAL_POLICY_PATH,
  isRevisionConflict,
  profileErrorMessage,
  useContentStudioEditorialPolicy,
  useContentStudioEditorialPolicyActions,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  ContentStudioDialogLayout,
  useUnsavedChangesWarning,
} from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import {
  ConflictNotice,
  ContentStudioContentForm,
  ContentStudioRevisionHistory,
  EditorActions,
  FieldGroup,
  LongTextField,
  StringListEditor,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// Editorial Policy v1: the editorial rules of the organization. Context for
// writing, not a check: nothing here scores or enforces them. Its workflow
// (P5-07) is the one setting the server enforces, on handoff; off is no
// workflow at all
export interface EditorialPolicyContent {
  schemaVersion: 1;
  principles: string[];
  prohibitedTopics: string[];
  claimRules: string[];
  ctaRules: string[];
  formatConventions: string[];
  complianceNotes: string;
  workflow?: { requireApprovalForHandoff: boolean };
}

export const emptyEditorialPolicyContent = (): EditorialPolicyContent => ({
  schemaVersion: 1,
  principles: [],
  prohibitedTopics: [],
  claimRules: [],
  ctaRules: [],
  formatConventions: [],
  complianceNotes: '',
});

export const EditorialPolicyForm: ContentStudioContentForm<
  EditorialPolicyContent
> = ({ value, onChange, disabled }) => {
  const t = useT();
  const hintId = useId();
  const set = (patch: Partial<EditorialPolicyContent>) =>
    onChange({ ...value, ...patch });
  const requireApproval = value.workflow?.requireApprovalForHandoff === true;
  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <StringListEditor
        label={t('content_studio_policy_principles', 'Principles')}
        values={value.principles}
        max={20}
        disabled={disabled}
        onChange={(principles) => set({ principles })}
      />
      <StringListEditor
        label={t('content_studio_policy_prohibited', 'Prohibited topics')}
        values={value.prohibitedTopics}
        max={30}
        disabled={disabled}
        onChange={(prohibitedTopics) => set({ prohibitedTopics })}
      />
      <StringListEditor
        label={t('content_studio_policy_claims', 'Claim rules')}
        values={value.claimRules}
        max={20}
        disabled={disabled}
        onChange={(claimRules) => set({ claimRules })}
      />
      <StringListEditor
        label={t('content_studio_policy_cta', 'Call-to-action rules')}
        values={value.ctaRules}
        max={10}
        disabled={disabled}
        onChange={(ctaRules) => set({ ctaRules })}
      />
      <StringListEditor
        label={t('content_studio_policy_format', 'Format conventions')}
        values={value.formatConventions}
        max={20}
        disabled={disabled}
        onChange={(formatConventions) => set({ formatConventions })}
      />
      <LongTextField
        label={t('content_studio_policy_compliance', 'Compliance notes')}
        hint={t(
          'content_studio_policy_compliance_hint',
          'Context for writers, in up to 4000 characters.'
        )}
        value={value.complianceNotes}
        disabled={disabled}
        rows={6}
        onChange={(complianceNotes) => set({ complianceNotes })}
      />
      <FieldGroup label={t('content_studio_policy_workflow', 'Handoff')}>
        <label className="flex items-center gap-[8px] text-[14px]">
          <input
            type="checkbox"
            checked={requireApproval}
            disabled={disabled}
            aria-describedby={hintId}
            onChange={(e) => {
              // off is sent as no workflow at all
              const next = { ...value };
              delete next.workflow;
              onChange(
                e.target.checked
                  ? { ...next, workflow: { requireApprovalForHandoff: true } }
                  : next
              );
            }}
          />
          {t(
            'content_studio_policy_require_approval',
            'Require approval before handoff'
          )}
        </label>
        <div id={hintId} className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_policy_require_approval_hint',
            'Only revisions that are currently approved can be handed off to Postiz.'
          )}
          {requireApproval &&
            ` ${t(
              'content_studio_policy_require_approval_on',
              'Unreviewed, pending, refused or withdrawn revisions cannot be handed off.'
            )}`}
        </div>
      </FieldGroup>
    </div>
  );
};

// The one editorial policy of the organization. Before its first save there
// is none: the form starts empty and the first save (over version 0) creates
// it. Every member may edit it
export const EditorialPolicySection: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const policy = useContentStudioEditorialPolicy<EditorialPolicyContent>();
  const actions = useContentStudioEditorialPolicyActions();
  const [loaded, setLoaded] = useState(false);
  const [content, setContent] = useState<EditorialPolicyContent>(
    emptyEditorialPolicyContent
  );
  const [savedContent, setSavedContent] = useState<EditorialPolicyContent>(
    emptyEditorialPolicyContent
  );
  const [baseRevision, setBaseRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const { busy, run } = useSingleFlight();
  const dirty =
    loaded && JSON.stringify(content) !== JSON.stringify(savedContent);
  useUnsavedChangesWarning(dirty);

  const seed = useCallback(
    (data: ContentStudioEditorialPolicyState<EditorialPolicyContent>) => {
      const current =
        data.currentRevision?.content ?? emptyEditorialPolicyContent();
      setContent(current);
      setSavedContent(current);
      setBaseRevision(data.latestRevisionNumber);
      setConflict(false);
      setLoaded(true);
    },
    []
  );

  useEffect(() => {
    if (policy.data && !loaded) {
      seed(policy.data);
    }
  }, [policy.data, loaded, seed]);

  const save = () =>
    run('save', async () => {
      try {
        const result = await actions.saveRevision(baseRevision, content);
        setBaseRevision(result.latestRevisionNumber);
        setSavedContent(content);
        toaster.show(
          result.created
            ? t('content_studio_policy_saved', 'Editorial policy saved.')
            : t(
                'content_studio_policy_no_changes',
                'No policy changes to save.'
              ),
          'success'
        );
      } catch (err) {
        if (isRevisionConflict(err)) {
          setConflict(true);
          return;
        }
        toaster.show(profileErrorMessage(t, 'editorial', err), 'warning');
      }
    });

  const reload = () =>
    run('reload', async () => {
      const latest = await policy.mutate();
      if (latest) {
        seed(latest);
      }
    });

  const openHistory = () =>
    modals.openModal({
      title: t('content_studio_policy_history', 'Editorial policy history'),
      children: (
        <ContentStudioDialogLayout>
          <ContentStudioRevisionHistory
            base={EDITORIAL_POLICY_PATH}
            Form={EditorialPolicyForm}
          />
        </ContentStudioDialogLayout>
      ),
    });

  if (policy.error && !loaded) {
    return (
      <div className="flex flex-col items-center gap-[12px] py-[24px]">
        <div>{profileErrorMessage(t, 'editorial', policy.error)}</div>
        <Button secondary onClick={() => policy.mutate()}>
          {t('content_studio_retry', 'Try again')}
        </Button>
      </div>
    );
  }
  if (!loaded) {
    return <LoadingComponent />;
  }

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[8px]">
        <div className="flex-1 min-w-[200px] text-textItemBlur">
          {baseRevision
            ? `${t('content_studio_revision', 'Version')} ${baseRevision}`
            : t(
                'content_studio_policy_not_saved',
                'No editorial policy saved yet.'
              )}
        </div>
        <Button secondary disabled={!baseRevision} onClick={openHistory}>
          {t('content_studio_history', 'History')}
        </Button>
        <Button
          loading={busy === 'save'}
          disabled={!!busy || conflict}
          onClick={save}
        >
          {t('content_studio_save_policy', 'Save policy')}
        </Button>
      </div>
      {conflict && (
        <ConflictNotice
          message={t(
            'content_studio_policy_conflict',
            'The editorial policy changed elsewhere. Reload the latest version before saving.'
          )}
          busy={busy === 'reload'}
          onReload={reload}
        />
      )}
      <EditorialPolicyForm value={content} onChange={setContent} />
      <EditorActions>
        <Button
          loading={busy === 'save'}
          disabled={!!busy || conflict}
          onClick={save}
        >
          {t('content_studio_save_policy', 'Save policy')}
        </Button>
      </EditorActions>
    </div>
  );
};
