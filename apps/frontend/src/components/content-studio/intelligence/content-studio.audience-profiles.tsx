'use client';

import { FC } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { AUDIENCE_PROFILES_PATH } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  ChoiceField,
  ContentStudioContentForm,
  LongTextField,
  NamedProfilesSection,
  ShortTextField,
  StringListEditor,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// Audience Profile v1: who the content is written for, as editorial context.
// Not people, not ad targeting: there are no demographic, contact or
// tracking fields, and the locale is the language to write in
export interface AudienceProfileContent {
  schemaVersion: 1;
  description: string;
  role: string;
  knowledgeLevel: 'beginner' | 'intermediate' | 'expert' | 'mixed';
  goals: string[];
  painPoints: string[];
  objections: string[];
  preferredTone: string | null;
  locale: string | null;
}

// The limits the API enforces
const LIST_MAX = 10;

export const emptyAudienceProfileContent = (): AudienceProfileContent => ({
  schemaVersion: 1,
  description: '',
  role: '',
  knowledgeLevel: 'mixed',
  goals: [],
  painPoints: [],
  objections: [],
  preferredTone: null,
  locale: null,
});

const orNull = (text: string) => (text ? text : null);

export const AudienceProfileForm: ContentStudioContentForm<
  AudienceProfileContent
> = ({ value, onChange, disabled }) => {
  const t = useT();
  const set = (patch: Partial<AudienceProfileContent>) =>
    onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <LongTextField
        label={t('content_studio_audience_description', 'Description')}
        hint={t(
          'content_studio_audience_description_hint',
          'Who this audience is, in up to 2000 characters.'
        )}
        value={value.description}
        disabled={disabled}
        onChange={(description) => set({ description })}
      />
      <ShortTextField
        label={t('content_studio_audience_role', 'Role')}
        value={value.role}
        disabled={disabled}
        onChange={(role) => set({ role })}
      />
      <ChoiceField
        label={t('content_studio_audience_knowledge', 'Knowledge level')}
        value={value.knowledgeLevel}
        disabled={disabled}
        options={[
          {
            value: 'beginner',
            label: t('content_studio_beginner', 'Beginner'),
          },
          {
            value: 'intermediate',
            label: t('content_studio_intermediate', 'Intermediate'),
          },
          { value: 'expert', label: t('content_studio_expert', 'Expert') },
          { value: 'mixed', label: t('content_studio_mixed', 'Mixed') },
        ]}
        onChange={(knowledgeLevel) =>
          set({
            knowledgeLevel:
              knowledgeLevel as AudienceProfileContent['knowledgeLevel'],
          })
        }
      />
      <StringListEditor
        label={t('content_studio_audience_goals', 'Goals')}
        values={value.goals}
        max={LIST_MAX}
        disabled={disabled}
        onChange={(goals) => set({ goals })}
      />
      <StringListEditor
        label={t('content_studio_audience_pain_points', 'Pain points')}
        values={value.painPoints}
        max={LIST_MAX}
        disabled={disabled}
        onChange={(painPoints) => set({ painPoints })}
      />
      <StringListEditor
        label={t('content_studio_audience_objections', 'Objections')}
        values={value.objections}
        max={LIST_MAX}
        disabled={disabled}
        onChange={(objections) => set({ objections })}
      />
      <ShortTextField
        label={t('content_studio_audience_tone', 'Preferred tone')}
        hint={t('content_studio_optional', 'Optional.')}
        value={value.preferredTone ?? ''}
        disabled={disabled}
        onChange={(preferredTone) =>
          set({ preferredTone: orNull(preferredTone) })
        }
      />
      <ShortTextField
        label={t('content_studio_audience_locale', 'Locale')}
        hint={t(
          'content_studio_audience_locale_hint',
          'Optional, such as nl-NL or en-GB. Locale controls writing language/locale context only.'
        )}
        value={value.locale ?? ''}
        disabled={disabled}
        onChange={(locale) => set({ locale: orNull(locale) })}
      />
    </div>
  );
};

export const AudienceProfilesSection: FC = () => {
  const t = useT();
  return (
    <NamedProfilesSection
      config={{
        kind: 'audience',
        base: AUDIENCE_PROFILES_PATH,
        labels: {
          newProfile: t('content_studio_new_audience', 'New audience profile'),
          empty: t('content_studio_no_audiences', 'No audience profiles yet.'),
          emptyArchived: t(
            'content_studio_no_archived_audiences',
            'No archived audience profiles.'
          ),
          content: t('content_studio_audience', 'Audience'),
        },
        empty: emptyAudienceProfileContent,
        Form: AudienceProfileForm,
      }}
    />
  );
};
