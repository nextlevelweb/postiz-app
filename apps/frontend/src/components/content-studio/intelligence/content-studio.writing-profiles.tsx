'use client';

import { FC } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { WRITING_PROFILES_PATH } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  ChoiceField,
  ContentStudioContentForm,
  FieldGroup,
  LongTextField,
  NamedProfilesSection,
  ShortTextField,
  StringListEditor,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';

// Writing DNA v1, as the API takes and returns it. Entered by hand: nothing
// here is inferred or generated
export interface WritingProfileContent {
  schemaVersion: 1;
  voice: string;
  toneTags: string[];
  perspective:
    | 'first_singular'
    | 'first_plural'
    | 'second'
    | 'third'
    | 'mixed'
    | null;
  formatting: {
    emoji: 'none' | 'sparing' | 'free';
    hashtags: 'none' | 'few' | 'many';
    notes: string | null;
  };
  vocabulary: { prefer: string[]; avoid: string[] };
  dos: string[];
  donts: string[];
  examples: Array<{ text: string; note: string | null }>;
}

// The limits the API enforces
const TONE_TAGS_MAX = 10;
const VOCABULARY_MAX = 30;
const RULES_MAX = 20;
const EXAMPLES_MAX = 5;

export const emptyWritingProfileContent = (): WritingProfileContent => ({
  schemaVersion: 1,
  voice: '',
  toneTags: [],
  perspective: null,
  formatting: { emoji: 'none', hashtags: 'none', notes: null },
  vocabulary: { prefer: [], avoid: [] },
  dos: [],
  donts: [],
  examples: [],
});

// an empty optional text is sent as null
const orNull = (text: string) => (text ? text : null);

export const WritingProfileForm: ContentStudioContentForm<
  WritingProfileContent
> = ({ value, onChange, disabled }) => {
  const t = useT();
  const set = (patch: Partial<WritingProfileContent>) =>
    onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <LongTextField
        label={t('content_studio_writing_voice', 'Voice')}
        hint={t(
          'content_studio_writing_voice_hint',
          'How the organization sounds, in up to 1000 characters.'
        )}
        value={value.voice}
        disabled={disabled}
        onChange={(voice) => set({ voice })}
      />
      <StringListEditor
        label={t('content_studio_writing_tone_tags', 'Tone tags')}
        hint={t(
          'content_studio_writing_tone_tags_hint',
          'Up to 10 short tags, such as warm or direct.'
        )}
        values={value.toneTags}
        max={TONE_TAGS_MAX}
        disabled={disabled}
        onChange={(toneTags) => set({ toneTags })}
      />
      <ChoiceField
        label={t('content_studio_writing_perspective', 'Perspective')}
        value={value.perspective ?? ''}
        disabled={disabled}
        options={[
          { value: '', label: t('content_studio_not_set', 'Not set') },
          {
            value: 'first_singular',
            label: t(
              'content_studio_writing_first_singular',
              'First person (I)'
            ),
          },
          {
            value: 'first_plural',
            label: t(
              'content_studio_writing_first_plural',
              'First person (we)'
            ),
          },
          {
            value: 'second',
            label: t('content_studio_writing_second', 'Second person (you)'),
          },
          {
            value: 'third',
            label: t('content_studio_writing_third', 'Third person'),
          },
          { value: 'mixed', label: t('content_studio_writing_mixed', 'Mixed') },
        ]}
        onChange={(perspective) =>
          set({
            perspective: orNull(
              perspective
            ) as WritingProfileContent['perspective'],
          })
        }
      />
      <div className="grid grid-cols-1 tablet:grid-cols-2 gap-[16px]">
        <ChoiceField
          label={t('content_studio_writing_emoji', 'Emoji')}
          value={value.formatting.emoji}
          disabled={disabled}
          options={[
            { value: 'none', label: t('content_studio_none', 'None') },
            { value: 'sparing', label: t('content_studio_sparing', 'Sparing') },
            { value: 'free', label: t('content_studio_free', 'Free') },
          ]}
          onChange={(emoji) =>
            set({
              formatting: {
                ...value.formatting,
                emoji: emoji as WritingProfileContent['formatting']['emoji'],
              },
            })
          }
        />
        <ChoiceField
          label={t('content_studio_writing_hashtags', 'Hashtags')}
          value={value.formatting.hashtags}
          disabled={disabled}
          options={[
            { value: 'none', label: t('content_studio_none', 'None') },
            { value: 'few', label: t('content_studio_few', 'A few') },
            { value: 'many', label: t('content_studio_many', 'Many') },
          ]}
          onChange={(hashtags) =>
            set({
              formatting: {
                ...value.formatting,
                hashtags:
                  hashtags as WritingProfileContent['formatting']['hashtags'],
              },
            })
          }
        />
      </div>
      <LongTextField
        label={t('content_studio_writing_formatting_notes', 'Formatting notes')}
        value={value.formatting.notes ?? ''}
        disabled={disabled}
        rows={2}
        onChange={(notes) =>
          set({ formatting: { ...value.formatting, notes: orNull(notes) } })
        }
      />
      <div className="grid grid-cols-1 tablet:grid-cols-2 gap-[16px]">
        <StringListEditor
          label={t('content_studio_writing_prefer', 'Words to prefer')}
          values={value.vocabulary.prefer}
          max={VOCABULARY_MAX}
          disabled={disabled}
          onChange={(prefer) =>
            set({ vocabulary: { ...value.vocabulary, prefer } })
          }
        />
        <StringListEditor
          label={t('content_studio_writing_avoid', 'Words to avoid')}
          values={value.vocabulary.avoid}
          max={VOCABULARY_MAX}
          disabled={disabled}
          onChange={(avoid) =>
            set({ vocabulary: { ...value.vocabulary, avoid } })
          }
        />
      </div>
      <div className="grid grid-cols-1 tablet:grid-cols-2 gap-[16px]">
        <StringListEditor
          label={t('content_studio_writing_dos', 'Do')}
          values={value.dos}
          max={RULES_MAX}
          disabled={disabled}
          onChange={(dos) => set({ dos })}
        />
        <StringListEditor
          label={t('content_studio_writing_donts', "Don't")}
          values={value.donts}
          max={RULES_MAX}
          disabled={disabled}
          onChange={(donts) => set({ donts })}
        />
      </div>
      <FieldGroup
        label={t('content_studio_writing_examples', 'Examples')}
        hint={t(
          'content_studio_writing_examples_hint',
          'Up to 5 examples of writing in this voice.'
        )}
      >
        {value.examples.map((example, index) => (
          <div
            key={index}
            className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
          >
            <LongTextField
              label={`${t('content_studio_writing_example', 'Example')} ${
                index + 1
              }`}
              value={example.text}
              disabled={disabled}
              onChange={(text) =>
                set({
                  examples: value.examples.map((other, at) =>
                    at === index ? { ...other, text } : other
                  ),
                })
              }
            />
            <ShortTextField
              label={`${t('content_studio_writing_example_note', 'Note')} ${
                index + 1
              }`}
              value={example.note ?? ''}
              disabled={disabled}
              onChange={(note) =>
                set({
                  examples: value.examples.map((other, at) =>
                    at === index ? { ...other, note: orNull(note) } : other
                  ),
                })
              }
            />
            {!disabled && (
              <div>
                <Button
                  secondary
                  aria-label={`${t(
                    'content_studio_remove_example',
                    'Remove example'
                  )} ${index + 1}`}
                  onClick={() =>
                    set({
                      examples: value.examples.filter((_, at) => at !== index),
                    })
                  }
                >
                  {t('content_studio_remove_example', 'Remove example')}
                </Button>
              </div>
            )}
          </div>
        ))}
        {!disabled && (
          <div>
            <Button
              secondary
              disabled={value.examples.length >= EXAMPLES_MAX}
              onClick={() =>
                set({ examples: [...value.examples, { text: '', note: null }] })
              }
            >
              {t('content_studio_add_example', 'Add example')}
            </Button>
          </div>
        )}
      </FieldGroup>
    </div>
  );
};

export const WritingProfilesSection: FC = () => {
  const t = useT();
  return (
    <NamedProfilesSection
      config={{
        kind: 'writing',
        base: WRITING_PROFILES_PATH,
        labels: {
          newProfile: t(
            'content_studio_new_writing_profile',
            'New writing profile'
          ),
          empty: t(
            'content_studio_no_writing_profiles',
            'No writing profiles yet.'
          ),
          emptyArchived: t(
            'content_studio_no_archived_writing_profiles',
            'No archived writing profiles.'
          ),
          content: t('content_studio_writing_dna', 'Writing DNA'),
        },
        empty: emptyWritingProfileContent,
        Form: WritingProfileForm,
      }}
    />
  );
};
