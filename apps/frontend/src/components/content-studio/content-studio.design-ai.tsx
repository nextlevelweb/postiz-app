'use client';

import { FC, ReactNode, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type {
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignFontRef,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  applyContentStudioDesignAIProposal,
  ContentStudioDesignAIChange,
  ContentStudioDesignAIIntent,
  ContentStudioDesignAIProposalV1,
  DESIGN_AI_COPY_INTENTS,
  parseContentStudioDesignAIProposal,
} from '@gitroom/nestjs-libraries/content-studio/design/design.ai.proposal';
import {
  ContentStudioRequestError,
  request,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import {
  AI_WRITING_INSTRUCTION_MAX,
  aiWritingErrorMessage,
  ProfileChoice,
  usable,
} from '@gitroom/frontend/components/content-studio/content-studio.ai-writing';
import {
  AUDIENCE_PROFILES_PATH,
  EDITORIAL_POLICY_PATH,
  EXPERTISE_PROFILES_PATH,
  useContentStudioAIConnections,
  useContentStudioAIProviders,
  useContentStudioRevisionPage,
  WRITING_PROFILES_PATH,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';
import {
  ChoiceField,
  FieldGroup,
  LongTextField,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import { designPath } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  ContentStudioDesignPageThumbnail,
  resolveDesignPreviewColor,
  resolveDesignPreviewFont,
} from '@gitroom/frontend/components/content-studio/content-studio.design.preview';
import type { ContentStudioDesignEditor } from '@gitroom/frontend/components/content-studio/content-studio.design.editing';

// AI suggestions in Creative Studio (P6-02): one suggestion at a time for
// exactly the saved current revision shown, never for unsaved changes. The
// server reads that revision, its Brand Kit revision and the connection's
// model, and answers a proposal of operations on existing layers with what
// it changes. Nothing is saved or applied by asking: the suggestion is shown
// with its changes and a before and after preview, and Apply puts it into
// the editor's draft as one undo step, still unsaved. It applies only while
// the editor shows exactly the revision it was made for, with no other
// changes; Discard drops it. Nothing chosen or suggested here is kept after
// the workspace is left. There are no image, Media or generation controls

export interface ContentStudioDesignAIBase {
  designId: string;
  revisionId: string;
  revisionNumber: number;
  contentHash: string;
}

// What the user chose. The design and its revision are the route; there is
// no field for a model, provider, key, hash or document
export interface ContentStudioDesignAIRequest {
  intent: ContentStudioDesignAIIntent;
  connectionId: string;
  writingProfileId: string | null;
  editorialPolicy: boolean;
  audienceProfileId: string | null;
  expertiseProfileId: string | null;
  instruction: string | null;
}

export interface ContentStudioDesignAIResponse {
  operationId: string;
  base: ContentStudioDesignAIBase;
  proposal: ContentStudioDesignAIProposalV1;
  proposalHash: string;
  changes: ContentStudioDesignAIChange[];
  ai: { provider: string; model: string; promptVersion: string };
}

// One request per Generate, never retried: a repeated request would be a
// second provider call. Nothing is cached and nothing reloads: no design or
// revision changes
export const useContentStudioDesignAIApi = () => {
  const fetch = useFetch();
  return useMemo(
    () => ({
      propose: (
        designId: string,
        revisionId: string,
        body: ContentStudioDesignAIRequest
      ) =>
        request<ContentStudioDesignAIResponse>(
          fetch,
          `${designPath(designId)}/revisions/${encodeURIComponent(
            revisionId
          )}/ai/propose`,
          { method: 'POST', body: JSON.stringify(body) }
        ),
    }),
    [fetch]
  );
};

type Translate = (key: string, fallback: string) => string;

// Fixed text for the refusals of a design suggestion, then the AI writing
// texts for the connection and provider codes they share
export const designAIErrorMessage = (t: Translate, error: unknown) => {
  const code =
    error instanceof ContentStudioRequestError ? error.code : undefined;
  switch (code) {
    case 'CS_AI_DESIGN_BASE_STALE':
      return t(
        'content_studio_design_ai_error_stale',
        'This revision is no longer the current one. Reload the design and try again.'
      );
    case 'CS_AI_DESIGN_PROPOSAL_INVALID':
      return t(
        'content_studio_design_ai_error_invalid',
        'The AI suggestion did not fit this design and was not used. Try again.'
      );
    case 'CS_AI_DESIGN_INTENT_INVALID':
      return t(
        'content_studio_design_ai_error_intent',
        'This kind of suggestion is not available.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_design_not_found', 'Design not found.');
    case 'CS_DESIGN_ARCHIVED':
      return t(
        'content_studio_design_ai_error_archived',
        'This design is archived.'
      );
    case 'CS_DESIGN_INTEGRITY_ERROR':
    case 'CS_DESIGN_SOURCE_INTEGRITY_ERROR':
    case 'CS_DESIGN_BRAND_REFERENCE_INTEGRITY_ERROR':
      return t(
        'content_studio_design_error_integrity',
        'Stored design data could not be read safely.'
      );
    case 'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND':
    case 'CS_DESIGN_BRAND_REFERENCE_INVALID':
      return t(
        'content_studio_design_ai_error_brand',
        'The pinned Brand Kit revision of this design is not available.'
      );
    default:
      return (
        aiWritingErrorMessage(t, error) ??
        t(
          'content_studio_design_ai_error_failed',
          'Could not generate a suggestion.'
        )
      );
  }
};

const INTENTS: Array<{
  value: ContentStudioDesignAIIntent;
  key: string;
  label: string;
}> = [
  {
    value: 'improve_copy',
    key: 'content_studio_design_ai_improve_copy',
    label: 'Copy: improve the texts',
  },
  {
    value: 'tighten_copy',
    key: 'content_studio_design_ai_tighten_copy',
    label: 'Copy: make the texts shorter',
  },
  {
    value: 'adapt_tone',
    key: 'content_studio_design_ai_adapt_tone',
    label: 'Copy: change the tone',
  },
  {
    value: 'improve_hierarchy',
    key: 'content_studio_design_ai_improve_hierarchy',
    label: 'Style: improve the text hierarchy',
  },
  {
    value: 'restyle',
    key: 'content_studio_design_ai_restyle',
    label: 'Style: restyle the design',
  },
  {
    value: 'rebalance_layout',
    key: 'content_studio_design_ai_rebalance_layout',
    label: 'Layout: rebalance positions and sizes',
  },
];

const FIELDS: Record<string, [string, string]> = {
  fontSize: ['content_studio_design_font_size', 'Font size'],
  lineHeight: ['content_studio_design_line_height', 'Line height'],
  letterSpacing: ['content_studio_design_letter_spacing', 'Letter spacing'],
  align: ['content_studio_design_alignment', 'Alignment'],
  verticalAlign: [
    'content_studio_design_vertical_alignment',
    'Vertical alignment',
  ],
  color: ['content_studio_design_color', 'Color'],
  font: ['content_studio_design_font', 'Font'],
  fill: ['content_studio_design_fill', 'Fill'],
  cornerRadius: ['content_studio_design_corner_radius', 'Corner radius'],
};

const LAYER_TYPES: Record<string, [string, string]> = {
  text: ['content_studio_design_layer_text', 'Text'],
  shape: ['content_studio_design_layer_shape', 'Shape'],
  image: ['content_studio_design_layer_image', 'Image'],
};

const isColor = (value: unknown): value is ContentStudioDesignColorValue =>
  typeof value === 'object' &&
  value !== null &&
  ((value as { type?: unknown }).type === 'literal' ||
    (value as { type?: unknown }).type === 'brand') &&
  !('family' in value);

// A value as people read it: Brand Kit tokens by name, from the exact kit
const valueText = (
  field: string,
  value: unknown,
  brand: ContentStudioBrandKitContentV1 | null
) => {
  if (field === 'font') {
    const font = value as ContentStudioDesignFontRef;
    const resolved = resolveDesignPreviewFont(font, brand);
    const token =
      font.type === 'brand'
        ? brand?.typography.find((entry) => entry.id === font.tokenId)
        : undefined;
    const spec = resolved
      ? `${resolved.family} · ${resolved.weight} · ${resolved.style}`
      : '?';
    return token ? `${token.name} · ${spec}` : spec;
  }
  if (isColor(value)) {
    const color = resolveDesignPreviewColor(value, brand) ?? '?';
    const token =
      value.type === 'brand'
        ? brand?.colors.find((entry) => entry.id === value.tokenId)
        : undefined;
    return token ? `${token.name} · ${color}` : color;
  }
  return String(value);
};

const box = (value: { x: number; y: number; width: number; height: number }) =>
  `${value.x}, ${value.y} · ${value.width} × ${value.height}`;

// What the suggestion changes, from the server's comparison of the two
// documents, never from the AI's summary
const DesignAIChangeList: FC<{
  changes: ContentStudioDesignAIChange[];
  document: ContentStudioDesignDocumentV1;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ changes, document, brand }) => {
  const t = useT();
  const pageLabel = (pageId: string) =>
    `${t('content_studio_design_page', 'Page')} ${
      document.pages.findIndex((page) => page.id === pageId) + 1
    }`;
  if (!changes.length) {
    return (
      <div role="status" className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_design_ai_no_changes',
          'This suggestion changes nothing in the design.'
        )}
      </div>
    );
  }
  return (
    <ol
      aria-label={t('content_studio_design_ai_changes', 'Changes')}
      className="flex flex-col gap-[8px]"
    >
      {changes.map((change, index) => {
        if (change.kind === 'background') {
          return (
            <li key={index} data-ai-change="background" className="text-[13px]">
              {t('content_studio_design_ai_background', 'Background of')}{' '}
              {pageLabel(change.pageId)}:{' '}
              {valueText('color', change.before, brand)} →{' '}
              {valueText('color', change.after, brand)}
            </li>
          );
        }
        const [key, fallback] = LAYER_TYPES[change.layerType];
        const layer = `${change.layerName || t(key, fallback)} (${pageLabel(
          change.pageId
        )})`;
        if (change.kind === 'text') {
          return (
            <li
              key={index}
              data-ai-change="text"
              className="flex flex-col gap-[4px] text-[13px]"
            >
              <span className="font-[600]">
                {t('content_studio_design_ai_text_changed', 'Changed text in')}{' '}
                {layer}
              </span>
              <span className="text-textItemBlur">
                {t('content_studio_design_ai_before', 'Before')}:
              </span>
              <span className="whitespace-pre-wrap break-words max-h-[160px] overflow-auto border border-newTableBorder rounded-[6px] p-[6px]">
                {change.before}
              </span>
              <span className="text-textItemBlur">
                {t('content_studio_design_ai_after', 'After')}:
              </span>
              <span
                data-ai-after=""
                className="whitespace-pre-wrap break-words max-h-[160px] overflow-auto border border-newTableBorder rounded-[6px] p-[6px]"
              >
                {change.after}
              </span>
            </li>
          );
        }
        if (change.kind === 'bounds') {
          return (
            <li key={index} data-ai-change="bounds" className="text-[13px]">
              {t('content_studio_design_ai_moved', 'Moved or resized')} {layer}:{' '}
              {box(change.before)} → {box(change.after)}
            </li>
          );
        }
        const [fieldKey, fieldLabel] = FIELDS[change.field];
        return (
          <li key={index} data-ai-change="style" className="text-[13px]">
            {t(fieldKey, fieldLabel)} {t('content_studio_design_ai_of', 'of')}{' '}
            {layer}: {valueText(change.field, change.before, brand)} →{' '}
            {valueText(change.field, change.after, brand)}
          </li>
        );
      })}
    </ol>
  );
};

interface Suggestion extends ContentStudioDesignAIResponse {
  // the shown document with the proposal applied, for the preview only
  preview: ContentStudioDesignDocumentV1;
}

interface DesignAIProps {
  base: ContentStudioDesignAIBase | null;
  document: ContentStudioDesignDocumentV1;
  brand: ContentStudioBrandKitContentV1 | null;
  brandReady: boolean;
  editor: ContentStudioDesignEditor;
}

// The panel of the design workspace, closed until it is opened: nothing is
// loaded before. Closing it drops a suggestion that was not applied. base is
// the saved current revision shown, or null while an older revision is
// shown; document is that revision's document and brand its exact Brand Kit
// content (null without a kit, or while it is not ready)
export const DesignAISuggestions: FC<DesignAIProps> = (props) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <section
      aria-label={t('content_studio_design_ai_suggestions', 'AI suggestions')}
      className="flex flex-col gap-[12px] border border-newTableBorder rounded-[8px] p-[12px] min-w-0"
    >
      <div className="flex flex-wrap items-center gap-[8px]">
        <h2 className="text-[16px] font-[600] flex-1">
          {t('content_studio_design_ai_suggestions', 'AI suggestions')}
        </h2>
        <Button
          secondary
          aria-expanded={open}
          disabled={open && props.editor.saving}
          onClick={() => setOpen(!open)}
        >
          {open
            ? t('content_studio_design_ai_close', 'Close AI suggestions')
            : t('content_studio_design_ai_open', 'Open AI suggestions')}
        </Button>
      </div>
      {open && <DesignAISuggestionsPanel {...props} />}
    </section>
  );
};

const DesignAISuggestionsPanel: FC<DesignAIProps> = ({
  base,
  document,
  brand,
  brandReady,
  editor,
}) => {
  const t = useT();
  const toaster = useToaster();
  const api = useContentStudioDesignAIApi();
  const connections = useContentStudioAIConnections();
  const providers = useContentStudioAIProviders();
  const policy = useContentStudioRevisionPage(
    EDITORIAL_POLICY_PATH,
    undefined,
    1
  );
  const { busy, run } = useSingleFlight();
  const [intent, setIntent] =
    useState<ContentStudioDesignAIIntent>('improve_copy');
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [writingProfileId, setWritingProfileId] = useState('');
  const [editorialPolicy, setEditorialPolicy] = useState(false);
  const [audienceProfileId, setAudienceProfileId] = useState('');
  const [expertiseProfileId, setExpertiseProfileId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  const shell = (children: ReactNode) => (
    <div className="flex flex-col gap-[12px] min-w-0">{children}</div>
  );

  if (connections.error || providers.error) {
    return shell(
      <div role="alert">
        {t(
          'content_studio_design_ai_load_error',
          'AI connections could not be loaded.'
        )}
      </div>
    );
  }
  if (!connections.data || !providers.data) {
    return shell(<LoadingComponent width={32} height={32} />);
  }
  const catalog = providers.data;
  const available = connections.data.filter((connection) =>
    usable(connection, catalog)
  );
  if (!available.length) {
    return shell(
      <div className="flex flex-col gap-[8px]">
        <div role="status">
          {t(
            'content_studio_design_ai_connect',
            'Connect an AI provider in Brand & AI to get design suggestions.'
          )}
        </div>
        <Link href="/content-studio/intelligence?tab=ai" className="underline">
          {t('content_studio_brand_ai', 'Brand & AI')}
        </Link>
      </div>
    );
  }

  const connection =
    available.find((entry) => entry.id === connectionId) || available[0];
  const copy = DESIGN_AI_COPY_INTENTS.includes(intent);
  const tone = intent === 'adapt_tone';
  const trimmed = instruction.trim();
  const policyAvailable = !!policy.data?.results.length;
  const generating = busy === 'generate';
  const locked = generating || editor.saving;
  // suggestions are made for the saved revision only: unsaved changes would
  // be ignored, so they block asking
  const canGenerate =
    !!base &&
    brandReady &&
    !editor.dirty &&
    !locked &&
    instruction.length <= AI_WRITING_INSTRUCTION_MAX &&
    (!tone || !!trimmed);

  const generate = () =>
    run('generate', async () => {
      if (!base) {
        return;
      }
      setSuggestion(null);
      let response: ContentStudioDesignAIResponse;
      try {
        response = await api.propose(base.designId, base.revisionId, {
          intent,
          connectionId: connection.id,
          writingProfileId: copy ? writingProfileId || null : null,
          editorialPolicy: copy && editorialPolicy && policyAvailable,
          audienceProfileId: copy ? audienceProfileId || null : null,
          expertiseProfileId: copy ? expertiseProfileId || null : null,
          instruction: trimmed || null,
        });
      } catch (err) {
        toaster.show(designAIErrorMessage(t, err), 'warning');
        return;
      }
      // shown only once it is exactly a proposal for the revision asked for
      // that applies to the document shown
      try {
        if (
          response.base?.designId !== base.designId ||
          response.base.revisionId !== base.revisionId ||
          !Array.isArray(response.changes)
        ) {
          throw new Error('Unexpected suggestion');
        }
        const proposal = parseContentStudioDesignAIProposal(response.proposal);
        setSuggestion({
          ...response,
          proposal,
          preview: applyContentStudioDesignAIProposal(
            document,
            proposal,
            document.brandKit ? brand : null
          ),
        });
      } catch {
        toaster.show(
          t(
            'content_studio_design_ai_unsafe',
            'The suggestion could not be shown safely. Try again.'
          ),
          'warning'
        );
      }
    });

  // Apply only onto exactly the revision the suggestion was made for, as it
  // is saved: a newer revision, an older one shown or changes in the editor
  // refuse it. It becomes one undo step of the draft; nothing is saved
  const stale = !!suggestion && suggestion.base.revisionId !== base?.revisionId;
  const conflicting =
    !!suggestion &&
    !!editor.state &&
    (editor.state.base.revisionId !== suggestion.base.revisionId ||
      editor.dirty);
  const canApply =
    !!suggestion &&
    !!base &&
    !stale &&
    !conflicting &&
    !locked &&
    brandReady &&
    !!suggestion.changes.length;

  const apply = () => {
    if (!suggestion || !base || !canApply) {
      return;
    }
    if (!editor.state) {
      editor.begin(
        { id: base.revisionId, revisionNumber: base.revisionNumber },
        document
      );
    }
    const applied = editor.apply((latest) => ({
      document: applyContentStudioDesignAIProposal(
        latest,
        suggestion.proposal,
        document.brandKit ? brand : null
      ),
      result: true,
    }));
    if (applied) {
      setSuggestion(null);
      toaster.show(
        t(
          'content_studio_design_ai_applied',
          'Suggestion applied to your unsaved changes. Review it, then save to keep it.'
        ),
        'success'
      );
    }
  };

  const changedPages = suggestion
    ? Array.from(new Set(suggestion.changes.map((change) => change.pageId)))
    : [];

  return shell(
    <div className="flex flex-col gap-[12px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_design_ai_hint',
          'Suggestions change existing layers only: texts, styles, positions and sizes. Nothing changes until you apply a suggestion, and nothing is saved until you save.'
        )}
      </div>
      {!base && (
        <div role="status" className="text-[13px]">
          {t(
            'content_studio_design_ai_current_only',
            'Suggestions are made for the current revision. Go back to the current revision to ask for one.'
          )}
        </div>
      )}
      {!!base && !brandReady && (
        <div className="text-[13px]">
          {t(
            'content_studio_design_edit_brand_required',
            'The pinned Brand Kit revision must be available before this design can be edited.'
          )}
        </div>
      )}
      {!!base && editor.dirty && (
        <div role="status" className="text-[13px]">
          {t(
            'content_studio_design_ai_save_first',
            'Save or discard your changes first: suggestions are made for the saved revision.'
          )}
        </div>
      )}
      <div className="grid grid-cols-2 tablet:grid-cols-1 gap-[12px] min-w-0">
        <ChoiceField
          label={t('content_studio_design_ai_intent', 'Suggestion')}
          value={intent}
          disabled={locked}
          options={INTENTS.map((entry) => ({
            value: entry.value,
            label: t(entry.key, entry.label),
          }))}
          onChange={(next) => setIntent(next as ContentStudioDesignAIIntent)}
        />
        <ChoiceField
          label={t('content_studio_ai_connection', 'AI connection')}
          hint={t(
            'content_studio_design_ai_connection_hint',
            "Uses the connection's own model."
          )}
          value={connection.id}
          disabled={locked}
          options={available.map((entry) => ({
            value: entry.id,
            label: `${entry.name} (${
              catalog.find((info) => info.provider === entry.provider)
                ?.displayName || entry.provider
            })`,
          }))}
          onChange={setConnectionId}
        />
      </div>
      {copy && (
        <div className="grid grid-cols-2 tablet:grid-cols-1 gap-[12px] min-w-0">
          <ProfileChoice
            base={WRITING_PROFILES_PATH}
            label={t('content_studio_ai_writing_profile', 'Writing Profile')}
            value={writingProfileId}
            disabled={locked}
            onChange={setWritingProfileId}
          />
          <FieldGroup
            label={t('content_studio_editorial_policy', 'Editorial Policy')}
          >
            <label className="flex items-center gap-[8px] text-[14px]">
              <input
                type="checkbox"
                checked={editorialPolicy && policyAvailable}
                disabled={locked || !policyAvailable}
                onChange={(e) => setEditorialPolicy(e.target.checked)}
              />
              {t('content_studio_ai_use_policy', 'Use Editorial Policy')}
            </label>
          </FieldGroup>
          <ProfileChoice
            base={AUDIENCE_PROFILES_PATH}
            label={t('content_studio_ai_audience_profile', 'Audience Profile')}
            value={audienceProfileId}
            disabled={locked}
            onChange={setAudienceProfileId}
          />
          <ProfileChoice
            base={EXPERTISE_PROFILES_PATH}
            label={t(
              'content_studio_ai_expertise_profile',
              'Expertise Profile'
            )}
            value={expertiseProfileId}
            disabled={locked}
            onChange={setExpertiseProfileId}
          />
        </div>
      )}
      <LongTextField
        label={
          tone
            ? t('content_studio_ai_tone', 'Tone')
            : t('content_studio_ai_instruction', 'Additional instruction')
        }
        hint={
          tone
            ? t(
                'content_studio_ai_tone_hint',
                'Required. Describe the tone, for example "playful" or "formal". Up to 2000 characters.'
              )
            : t(
                'content_studio_ai_instruction_hint',
                'Optional. Up to 2000 characters.'
              )
        }
        value={instruction}
        disabled={locked}
        rows={2}
        onChange={setInstruction}
      />
      <div className="flex flex-wrap gap-[8px] items-center">
        <Button loading={generating} disabled={!canGenerate} onClick={generate}>
          {t('content_studio_ai_generate_suggestion', 'Generate suggestion')}
        </Button>
        {generating && (
          <span role="status" aria-live="polite" className="text-[13px]">
            {t(
              'content_studio_design_ai_generating',
              'Generating a suggestion…'
            )}
          </span>
        )}
      </div>

      {!!suggestion && (
        <div
          data-ai-suggestion=""
          className="flex flex-col gap-[12px] border-t border-newTableBorder pt-[12px] min-w-0"
        >
          <h3 className="font-[600]">
            {t('content_studio_design_ai_suggestion_for', 'Suggestion for')}{' '}
            {t('content_studio_design_revision', 'Revision')}{' '}
            {suggestion.base.revisionNumber}
          </h3>
          <FieldGroup
            label={t('content_studio_design_ai_summary', 'AI summary')}
            hint={t(
              'content_studio_design_ai_summary_hint',
              "The AI's own description. The changes below are what applying does."
            )}
          >
            <div
              data-ai-summary=""
              className="text-[13px] whitespace-pre-wrap break-words"
            >
              {suggestion.proposal.summary}
            </div>
          </FieldGroup>
          <FieldGroup label={t('content_studio_design_ai_changes', 'Changes')}>
            <DesignAIChangeList
              changes={suggestion.changes}
              document={document}
              brand={brand}
            />
          </FieldGroup>
          {!!changedPages.length && (
            <FieldGroup
              label={t('content_studio_design_ai_preview', 'Preview')}
            >
              <div className="flex flex-col gap-[12px]">
                {changedPages.map((pageId) => {
                  const index = document.pages.findIndex(
                    (page) => page.id === pageId
                  );
                  const before = document.pages[index];
                  const after = suggestion.preview.pages[index];
                  return (
                    <div
                      key={pageId}
                      data-ai-preview={pageId}
                      className="flex flex-col gap-[6px]"
                    >
                      <span className="text-[13px] font-[600]">
                        {t('content_studio_design_page', 'Page')} {index + 1}
                      </span>
                      <div className="flex flex-wrap gap-[12px]">
                        <figure className="flex flex-col gap-[4px]">
                          <ContentStudioDesignPageThumbnail
                            page={before}
                            brand={brand}
                          />
                          <figcaption className="text-[12px] text-textItemBlur">
                            {t('content_studio_design_ai_before', 'Before')}
                          </figcaption>
                        </figure>
                        <figure className="flex flex-col gap-[4px]">
                          <ContentStudioDesignPageThumbnail
                            page={after}
                            brand={brand}
                          />
                          <figcaption className="text-[12px] text-textItemBlur">
                            {t('content_studio_design_ai_after', 'After')}
                          </figcaption>
                        </figure>
                      </div>
                    </div>
                  );
                })}
              </div>
            </FieldGroup>
          )}
          {stale && (
            <div role="alert" className="text-[13px]">
              {t(
                'content_studio_design_ai_stale',
                'This suggestion was created for an older revision. Generate a new suggestion.'
              )}
            </div>
          )}
          {!stale && conflicting && (
            <div role="alert" className="text-[13px]">
              {t(
                'content_studio_design_ai_dirty',
                'The design changed after this suggestion was made. Discard your changes, or save them and generate a new suggestion.'
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-[8px]">
            <Button disabled={!canApply} onClick={apply}>
              {t('content_studio_design_ai_apply', 'Apply suggestion')}
            </Button>
            <Button
              secondary
              disabled={locked}
              onClick={() => setSuggestion(null)}
            >
              {t('content_studio_design_ai_discard', 'Discard suggestion')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
