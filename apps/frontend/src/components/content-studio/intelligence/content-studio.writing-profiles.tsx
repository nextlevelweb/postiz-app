'use client';

import { FC, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
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

// Writing DNA v1, as the API takes and returns it. Entered by hand or
// reviewed from the guided setup's AI draft
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

// The reason a word is avoided is kept as a Don't rule: the word in double
// quotes, a dash and the reason. The Writing DNA has no field for a reason,
// and its rules are what every AI request reads. The same format as the
// guided setup's AI draft (ai.setup.proposal.ts)
const AVOID_REASON_RULE = /^"([^"]+)" \u2014 ([\s\S]+)$/;
const RULE_MAX = 300;

export const avoidReasonRule = (term: string, reason: string) =>
  `"${term}" \u2014 ${reason}`;

export const parseAvoidReasonRule = (rule: string) => {
  const match = AVOID_REASON_RULE.exec(rule);
  return match ? { term: match[1], reason: match[2] } : null;
};

// The reason under one avoided word: shown, added or changed in place
const AvoidReason: FC<{
  term: string;
  donts: string[];
  disabled?: boolean;
  onChange: (donts: string[]) => void;
}> = ({ term, donts, disabled, onChange }) => {
  const t = useT();
  const index = donts.findIndex(
    (rule) => parseAvoidReasonRule(rule)?.term === term
  );
  const current = index >= 0 ? parseAvoidReasonRule(donts[index])?.reason : '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current || '');
  const max = RULE_MAX - avoidReasonRule(term, '').length;

  const save = () => {
    const reason = draft.trim();
    const next = donts.filter((_, at) => at !== index);
    if (reason) {
      next.splice(
        index >= 0 ? index : next.length,
        0,
        avoidReasonRule(term, reason)
      );
    }
    onChange(next);
    setEditing(false);
  };

  if (editing && !disabled) {
    return (
      <div className="flex flex-wrap items-center gap-[8px]">
        <div className="flex-1 min-w-[160px]">
          <Input
            label=""
            name={`reason-${term}`}
            aria-label={`${t(
              'content_studio_writing_avoid_reason',
              'Why avoid'
            )} ${term}`}
            disableForm={true}
            removeError={true}
            value={draft}
            maxLength={max}
            placeholder={t(
              'content_studio_writing_avoid_reason_placeholder',
              'e.g. Sounds like hype. Name the concrete benefit instead.'
            )}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
          />
        </div>
        <Button secondary onClick={save}>
          {t('content_studio_done', 'Done')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-[8px] text-[13px] text-textItemBlur">
      {current ? <span className="break-words">{current}</span> : null}
      {!disabled && (
        <button
          type="button"
          className="underline"
          aria-label={`${
            current
              ? t('content_studio_writing_edit_reason', 'Edit why')
              : t('content_studio_writing_add_reason', 'Add why')
          } ${term}`}
          onClick={() => {
            setDraft(current || '');
            setEditing(true);
          }}
        >
          {current
            ? t('content_studio_writing_edit_reason', 'Edit why')
            : t('content_studio_writing_add_reason', 'Add why')}
        </button>
      )}
    </div>
  );
};

// Who is speaking in the posts, in plain words; Mixed says what is mixed
const PerspectiveField: FC<{
  value: WritingProfileContent['perspective'];
  disabled?: boolean;
  onChange: (next: WritingProfileContent['perspective']) => void;
}> = ({ value, disabled, onChange }) => {
  const t = useT();
  const hints: Record<string, string> = {
    '': t(
      'content_studio_writing_perspective_none_hint',
      'No fixed perspective: the AI chooses per post.'
    ),
    first_singular: t(
      'content_studio_writing_first_singular_hint',
      'One person speaks: "I helped a client…". For founders and freelancers.'
    ),
    first_plural: t(
      'content_studio_writing_first_plural_hint',
      'The team speaks as one: "We build…", "Our approach…".'
    ),
    second: t(
      'content_studio_writing_second_hint',
      'Posts talk to the reader: "You can…", "Your team…".'
    ),
    third: t(
      'content_studio_writing_third_hint',
      'Neutral, about the company: "Acme builds…", "They offer…".'
    ),
    mixed: t(
      'content_studio_writing_mixed_hint',
      'Switches on purpose, usually we for the company and you for the reader. Describe the mix under Voice.'
    ),
  };
  return (
    <ChoiceField
      label={t('content_studio_writing_perspective', 'Perspective')}
      hint={hints[value ?? '']}
      value={value ?? ''}
      disabled={disabled}
      options={[
        { value: '', label: t('content_studio_not_set', 'Not set') },
        {
          value: 'first_singular',
          label: t(
            'content_studio_writing_first_singular',
            'First person singular — I / me'
          ),
        },
        {
          value: 'first_plural',
          label: t(
            'content_studio_writing_first_plural',
            'First person plural — we / us'
          ),
        },
        {
          value: 'second',
          label: t('content_studio_writing_second', 'Second person — you'),
        },
        {
          value: 'third',
          label: t(
            'content_studio_writing_third',
            'Third person — the company / they'
          ),
        },
        {
          value: 'mixed',
          label: t(
            'content_studio_writing_mixed',
            'Mixed — e.g. we and you, described under Voice'
          ),
        },
      ]}
      onChange={(next) =>
        onChange((next || null) as WritingProfileContent['perspective'])
      }
    />
  );
};

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
        chips
        onChange={(toneTags) => set({ toneTags })}
      />
      <PerspectiveField
        value={value.perspective}
        disabled={disabled}
        onChange={(perspective) => set({ perspective })}
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
          hint={t(
            'content_studio_writing_prefer_hint',
            'Words and phrases that sound like you.'
          )}
          values={value.vocabulary.prefer}
          max={VOCABULARY_MAX}
          disabled={disabled}
          chips
          onChange={(prefer) =>
            set({ vocabulary: { ...value.vocabulary, prefer } })
          }
        />
        <StringListEditor
          label={t('content_studio_writing_avoid', 'Words to avoid')}
          hint={t(
            'content_studio_writing_avoid_hint',
            'Add why, so colleagues and the AI know what to write instead.'
          )}
          values={value.vocabulary.avoid}
          max={VOCABULARY_MAX}
          disabled={disabled}
          chips
          renderDetail={(term) => (
            <AvoidReason
              term={term}
              donts={value.donts}
              disabled={disabled}
              onChange={(donts) => set({ donts })}
            />
          )}
          onChange={(avoid) =>
            set({
              vocabulary: { ...value.vocabulary, avoid },
              // a removed word takes its reason with it
              donts: value.donts.filter((rule) => {
                const reason = parseAvoidReasonRule(rule);
                return !reason || avoid.includes(reason.term);
              }),
            })
          }
        />
      </div>
      <div className="grid grid-cols-1 tablet:grid-cols-2 gap-[16px]">
        <StringListEditor
          label={t('content_studio_writing_dos', 'Do')}
          hint={t(
            'content_studio_writing_dos_hint',
            'Concrete habits, e.g. "Open with the reader\'s problem".'
          )}
          values={value.dos}
          max={RULES_MAX}
          disabled={disabled}
          onChange={(dos) => set({ dos })}
        />
        <StringListEditor
          label={t('content_studio_writing_donts', "Don't")}
          hint={t(
            'content_studio_writing_donts_hint',
            'What never fits, e.g. "No exclamation marks in headlines".'
          )}
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
          back: t('content_studio_writing_back', 'Writing profiles'),
          emptyHint: t(
            'content_studio_writing_empty_hint',
            'A writing profile tells the AI and your team how your brand sounds: voice, perspective, words to use and avoid.'
          ),
        },
        empty: emptyWritingProfileContent,
        Form: WritingProfileForm,
      }}
    />
  );
};
