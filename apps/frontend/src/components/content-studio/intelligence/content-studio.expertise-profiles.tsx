'use client';

import { FC } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { EXPERTISE_PROFILES_PATH } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  ContentStudioContentForm,
  FieldGroup,
  LongTextField,
  NamedProfilesSection,
  ShortTextField,
  StringListEditor,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// Expertise Profile v1: what the organization knows and how it wants that
// presented. Organization-provided context, not verified facts: there is no
// source, citation or check here, and the two instructions are plain text
export interface ExpertiseProfileContent {
  schemaVersion: 1;
  subjects: string[];
  differentiators: string[];
  stances: Array<{ topic: string; position: string }>;
  frameworks: string[];
  evidenceExpectations: string;
  avoidTopics: string[];
  confidenceBoundaries: string;
}

// The limits the API enforces
const SUBJECTS_MAX = 20;
const DIFFERENTIATORS_MAX = 10;
const STANCES_MAX = 20;
const FRAMEWORKS_MAX = 10;
const AVOID_TOPICS_MAX = 20;

export const emptyExpertiseProfileContent = (): ExpertiseProfileContent => ({
  schemaVersion: 1,
  subjects: [],
  differentiators: [],
  stances: [],
  frameworks: [],
  evidenceExpectations: '',
  avoidTopics: [],
  confidenceBoundaries: '',
});

export const ExpertiseProfileForm: ContentStudioContentForm<
  ExpertiseProfileContent
> = ({ value, onChange, disabled }) => {
  const t = useT();
  const set = (patch: Partial<ExpertiseProfileContent>) =>
    onChange({ ...value, ...patch });
  const setStance = (
    index: number,
    patch: Partial<ExpertiseProfileContent['stances'][number]>
  ) =>
    set({
      stances: value.stances.map((stance, at) =>
        at === index ? { ...stance, ...patch } : stance
      ),
    });

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <StringListEditor
        label={t('content_studio_expertise_subjects', 'Subjects')}
        hint={t(
          'content_studio_expertise_subjects_hint',
          'Topics your organization has expertise in.'
        )}
        values={value.subjects}
        max={SUBJECTS_MAX}
        disabled={disabled}
        onChange={(subjects) => set({ subjects })}
      />
      <StringListEditor
        label={t('content_studio_expertise_differentiators', 'Differentiators')}
        hint={t(
          'content_studio_expertise_differentiators_hint',
          'What makes your perspective or experience distinct?'
        )}
        values={value.differentiators}
        max={DIFFERENTIATORS_MAX}
        disabled={disabled}
        onChange={(differentiators) => set({ differentiators })}
      />
      <FieldGroup
        label={t('content_studio_expertise_stances', 'Stances')}
        hint={t(
          'content_studio_expertise_stances_hint',
          'Positions or points of view you commonly take.'
        )}
      >
        {value.stances.map((stance, index) => (
          <div
            key={index}
            className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
          >
            <ShortTextField
              label={`${t('content_studio_expertise_topic', 'Topic')} ${
                index + 1
              }`}
              value={stance.topic}
              disabled={disabled}
              onChange={(topic) => setStance(index, { topic })}
            />
            <LongTextField
              label={`${t('content_studio_expertise_position', 'Position')} ${
                index + 1
              }`}
              value={stance.position}
              disabled={disabled}
              rows={3}
              onChange={(position) => setStance(index, { position })}
            />
            {!disabled && (
              <div>
                <Button
                  secondary
                  aria-label={`${t(
                    'content_studio_remove_stance',
                    'Remove stance'
                  )} ${index + 1}`}
                  onClick={() =>
                    set({
                      stances: value.stances.filter((_, at) => at !== index),
                    })
                  }
                >
                  {t('content_studio_remove_stance', 'Remove stance')}
                </Button>
              </div>
            )}
          </div>
        ))}
        {!disabled && (
          <div>
            <Button
              secondary
              disabled={value.stances.length >= STANCES_MAX}
              onClick={() =>
                set({
                  stances: [...value.stances, { topic: '', position: '' }],
                })
              }
            >
              {t('content_studio_add_stance', 'Add stance')}
            </Button>
          </div>
        )}
      </FieldGroup>
      <StringListEditor
        label={t('content_studio_expertise_frameworks', 'Frameworks')}
        hint={t(
          'content_studio_expertise_frameworks_hint',
          'Named methods, principles or frameworks you use.'
        )}
        values={value.frameworks}
        max={FRAMEWORKS_MAX}
        disabled={disabled}
        onChange={(frameworks) => set({ frameworks })}
      />
      <LongTextField
        label={t('content_studio_expertise_evidence', 'Evidence expectations')}
        hint={t(
          'content_studio_expertise_evidence_hint',
          'How content should treat evidence, sources, statistics and claims.'
        )}
        value={value.evidenceExpectations}
        disabled={disabled}
        onChange={(evidenceExpectations) => set({ evidenceExpectations })}
      />
      <StringListEditor
        label={t('content_studio_expertise_avoid', 'Avoid topics')}
        hint={t(
          'content_studio_expertise_avoid_hint',
          'Topics this expertise profile should avoid.'
        )}
        values={value.avoidTopics}
        max={AVOID_TOPICS_MAX}
        disabled={disabled}
        onChange={(avoidTopics) => set({ avoidTopics })}
      />
      <LongTextField
        label={t(
          'content_studio_expertise_confidence',
          'Confidence boundaries'
        )}
        hint={t(
          'content_studio_expertise_confidence_hint',
          'Where content should use cautious language or avoid overclaiming.'
        )}
        value={value.confidenceBoundaries}
        disabled={disabled}
        onChange={(confidenceBoundaries) => set({ confidenceBoundaries })}
      />
    </div>
  );
};

export const ExpertiseProfilesSection: FC = () => {
  const t = useT();
  return (
    <NamedProfilesSection
      config={{
        kind: 'expertise',
        base: EXPERTISE_PROFILES_PATH,
        labels: {
          newProfile: t(
            'content_studio_new_expertise',
            'New expertise profile'
          ),
          empty: t('content_studio_no_expertise', 'No expertise profiles yet.'),
          emptyArchived: t(
            'content_studio_no_archived_expertise',
            'No archived expertise profiles.'
          ),
          content: t('content_studio_expertise', 'Expertise'),
        },
        empty: emptyExpertiseProfileContent,
        Form: ExpertiseProfileForm,
        note: t(
          'content_studio_expertise_note',
          'Expertise profiles are organization-provided context. They are not automatically verified facts.'
        ),
      }}
    />
  );
};
