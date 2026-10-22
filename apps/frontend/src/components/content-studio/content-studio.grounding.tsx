'use client';

import { FC, FormEvent, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  CLAIM_EVIDENCE_MAX,
  CLAIM_TEXT_MAX,
  contentPackageClaims,
  EVIDENCE_QUOTE_MAX,
  GROUNDING_CLAIMS_MAX,
  withContentPackageClaim,
  withoutContentPackageClaim,
} from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  ContentStudioClaim,
  ContentStudioClaimEvidence,
  ContentStudioDraft,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  useContentStudioSource,
  useContentStudioSourceVersion,
  useContentStudioSourceVersions,
} from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import { ContentStudioSourcePicker } from '@gitroom/frontend/components/content-studio/content-studio.source.picker';

// Grounding (P3-11): the claims a package makes, each for one post, with the
// exact blocks of exact source versions that support it. A claim says what
// the source material says, never that it is true. Evidence is shown from
// the stored version it names, through the Source Library's own reads:
// nothing is fetched from the web, refreshed or re-extracted here. Claims are
// written by hand here or come with an accepted AI suggestion; the server
// checks every piece of evidence whenever the draft is saved

type Translate = (key: string, fallback: string) => string;

const fieldClass =
  'bg-newBgColorInner h-[32px] px-[8px] border-newTableBorder border rounded-[8px] text-textColor text-[13px] w-full min-w-0';
const textareaClass =
  'bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0';

// c_ and 16 hex characters from the browser's random source: a claim id
// the schema accepts, unique within a draft
export const createClaimId = () =>
  `c_${Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;

const postLabel = (t: Translate, index: number) =>
  index === 0
    ? t('content_studio_main_post', 'Post')
    : `${t('content_studio_followup', 'Follow-up')} ${index}`;

// One piece of evidence: the version it names and the block itself, read
// from that stored version only when shown. A version that does not hold it
// is said to, never replaced by another version
const EvidenceDetail: FC<{ evidence: ContentStudioClaimEvidence }> = ({
  evidence,
}) => {
  const t = useT();
  const source = useContentStudioSource(evidence.sourceId);
  const version = useContentStudioSourceVersion(
    evidence.sourceId,
    evidence.versionId
  );
  const block = version.data?.content.blocks.find(
    (entry) => entry.id === evidence.blockId
  );
  const matches =
    !!version.data &&
    version.data.id === evidence.versionId &&
    version.data.versionNumber === evidence.versionNumber &&
    version.data.contentHash === evidence.contentHash &&
    !!block &&
    (evidence.quote === null || block.text.includes(evidence.quote));

  return (
    <li
      className="flex flex-col gap-[4px] border border-newTableBorder rounded-[8px] p-[8px] text-[13px]"
      data-evidence-version={evidence.versionId}
      data-evidence-block={evidence.blockId}
    >
      <div className="font-[600] break-words">
        {[
          source.data?.name || t('content_studio_grounding_source', 'Source'),
          version.data?.title,
          `${t('content_studio_ai_source_version', 'Version')} ${
            evidence.versionNumber
          }`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>
      {evidence.quote !== null && (
        <blockquote className="border-s-[3px] border-newTableBorder ps-[8px] whitespace-pre-wrap break-words">
          {evidence.quote}
        </blockquote>
      )}
      {version.error ? (
        <div className="text-textItemBlur">
          {t(
            'content_studio_grounding_evidence_load_error',
            'Could not load this source version.'
          )}
        </div>
      ) : !version.data ? (
        <LoadingComponent width={24} height={24} />
      ) : !matches ? (
        <div role="alert" className="text-textItemBlur">
          {t(
            'content_studio_grounding_evidence_mismatch',
            'This evidence does not match its source version.'
          )}
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-textItemBlur">
          {block?.text}
        </div>
      )}
    </li>
  );
};

// One claim: its text, the post it belongs to and its evidence, opened on
// demand
const ClaimCard: FC<{
  claim: ContentStudioClaim;
  label: string;
  editable: boolean;
  onEdit: () => void;
  onRemove: () => void;
}> = ({ claim, label, editable, onEdit, onRemove }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <li
      className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
      data-claim-id={claim.id}
    >
      <div className="text-[12px] text-textItemBlur">{label}</div>
      <div className="whitespace-pre-wrap break-words">{claim.text}</div>
      <div className="flex flex-wrap items-center gap-[8px]">
        <span className="text-[12px] text-textItemBlur flex-1">
          {t('content_studio_grounding_evidence_count', 'Evidence')}:{' '}
          {claim.evidence.length}
        </span>
        <Button
          secondary
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open
            ? t('content_studio_grounding_hide_evidence', 'Hide evidence')
            : t('content_studio_grounding_show_evidence', 'Show evidence')}
        </Button>
        {editable && (
          <>
            <Button secondary onClick={onEdit}>
              {t('content_studio_grounding_edit_claim', 'Edit claim')}
            </Button>
            <Button secondary onClick={onRemove}>
              {t('content_studio_grounding_remove_claim', 'Remove claim')}
            </Button>
          </>
        )}
      </div>
      {open && (
        <ul className="flex flex-col gap-[8px]">
          {claim.evidence.map((evidence) => (
            <EvidenceDetail
              key={`${evidence.versionId}/${evidence.blockId}`}
              evidence={evidence}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

// One captured version of the chosen source (the newest first) and its
// blocks, as the server stored them; an optional quote must be words of the
// chosen block
const VersionBlockPicker: FC<{
  sourceId: string;
  onAdd: (evidence: ContentStudioClaimEvidence) => void;
}> = ({ sourceId, onAdd }) => {
  const t = useT();
  const versions = useContentStudioSourceVersions(sourceId, 1);
  const [versionId, setVersionId] = useState('');
  const chosenVersion = versionId || versions.data?.results[0]?.id || null;
  const version = useContentStudioSourceVersion(sourceId, chosenVersion);
  const [blockId, setBlockId] = useState('');
  const [quote, setQuote] = useState('');
  const block = version.data?.content.blocks.find(
    (entry) => entry.id === blockId
  );
  const quoteOk =
    !quote ||
    (!!quote.trim() &&
      quote.length <= EVIDENCE_QUOTE_MAX &&
      !!block &&
      block.text.includes(quote));

  const add = () => {
    if (!version.data || !block || !quoteOk) {
      return;
    }
    onAdd({
      sourceId,
      versionId: version.data.id,
      versionNumber: version.data.versionNumber,
      contentHash: version.data.contentHash,
      blockId: block.id,
      quote: quote || null,
    });
    setBlockId('');
    setQuote('');
  };

  return (
    <>
      <label className="flex flex-col gap-[4px] text-[12px]">
        {t('content_studio_ai_source_version', 'Version')}
        <select
          className={fieldClass}
          value={chosenVersion || ''}
          onChange={(e) => {
            setVersionId(e.target.value);
            setBlockId('');
            setQuote('');
          }}
        >
          {(versions.data?.results || []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${t('content_studio_ai_source_version', 'Version')} ${
                entry.versionNumber
              }${entry.title ? ` · ${entry.title}` : ''}`}
            </option>
          ))}
        </select>
      </label>
      {(versions.error || version.error) && (
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_grounding_evidence_load_error',
            'Could not load this source version.'
          )}
        </div>
      )}
      {!!chosenVersion && !version.data && !version.error && (
        <LoadingComponent width={24} height={24} />
      )}
      {!!version.data && (
        <div
          role="radiogroup"
          aria-label={t('content_studio_grounding_block', 'Source passage')}
          className="flex flex-col gap-[4px] max-h-[240px] overflow-y-auto"
        >
          {!version.data.content.blocks.length && (
            <div className="text-[12px] text-textItemBlur">
              {t(
                'content_studio_source_no_text',
                'No text was captured from this source.'
              )}
            </div>
          )}
          {version.data.content.blocks.map((entry) => (
            <label
              key={entry.id}
              className="flex items-start gap-[8px] text-[13px]"
            >
              <input
                type="radio"
                name={`grounding-block-${sourceId}`}
                value={entry.id}
                checked={blockId === entry.id}
                onChange={() => setBlockId(entry.id)}
              />
              <span className="whitespace-pre-wrap break-words min-w-0">
                {entry.text}
              </span>
            </label>
          ))}
        </div>
      )}
      {!!block && (
        <label className="flex flex-col gap-[4px] text-[12px]">
          {t(
            'content_studio_grounding_quote',
            'Quote (optional, exact words of this passage)'
          )}
          <input
            className={fieldClass}
            value={quote}
            maxLength={EVIDENCE_QUOTE_MAX}
            onChange={(e) => setQuote(e.target.value)}
          />
          {!quoteOk && (
            <span className="text-textItemBlur">
              {t(
                'content_studio_grounding_quote_invalid',
                'The quote must be exact words of the chosen passage.'
              )}
            </span>
          )}
        </label>
      )}
      <div>
        <Button secondary disabled={!block || !quoteOk} onClick={add}>
          {t('content_studio_grounding_add_evidence', 'Add evidence')}
        </Button>
      </div>
    </>
  );
};

// Picks one block of one captured version of an active web page of the
// organization, found through the Source picker (P8-03): searched by the
// server and paged, so any page can be chosen. Choosing the page adds
// nothing: evidence is the version, block and quote chosen after it
const EvidencePicker: FC<{
  onAdd: (evidence: ContentStudioClaimEvidence) => void;
}> = ({ onAdd }) => {
  const t = useT();
  const [sourceId, setSourceId] = useState('');

  return (
    <fieldset className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]">
      <legend className="px-[4px] text-[13px] font-[600]">
        {t('content_studio_grounding_add_evidence', 'Add evidence')}
      </legend>
      <div className="flex flex-col gap-[4px] text-[12px]">
        {t('content_studio_grounding_source', 'Source')}
        <ContentStudioSourcePicker
          mode="single"
          value={sourceId ? [sourceId] : []}
          onChange={(ids) => setSourceId(ids[0] ?? '')}
          errorText={t(
            'content_studio_source_picker_error',
            'Sources could not be loaded.'
          )}
          emptyText={t(
            'content_studio_grounding_no_sources',
            'Capture a source in the Source Library to use it as evidence.'
          )}
        />
      </div>
      {!!sourceId && (
        <VersionBlockPicker key={sourceId} sourceId={sourceId} onAdd={onAdd} />
      )}
    </fieldset>
  );
};

// Writes one claim: the post it belongs to (fixed once the claim exists), its
// text and its evidence. The claim id of an edited claim stays
const ClaimForm: FC<{
  draft: ContentStudioDraft;
  claim: ContentStudioClaim | null;
  onSave: (claim: ContentStudioClaim) => void;
  onCancel: () => void;
}> = ({ draft, claim, onSave, onCancel }) => {
  const t = useT();
  const thread = draft.copy.global.thread;
  const [itemId, setItemId] = useState(
    claim?.threadItemId ?? thread[0]?.id ?? ''
  );
  const [text, setText] = useState(claim?.text ?? '');
  const [evidence, setEvidence] = useState<ContentStudioClaimEvidence[]>(
    claim?.evidence ?? []
  );
  const trimmed = text.trim();
  const valid =
    !!trimmed &&
    trimmed.length <= CLAIM_TEXT_MAX &&
    !text.includes('\u0000') &&
    !!evidence.length &&
    evidence.length <= CLAIM_EVIDENCE_MAX &&
    thread.some((item) => item.id === itemId);

  const add = (entry: ContentStudioClaimEvidence) =>
    setEvidence((current) =>
      current.some(
        (item) =>
          item.versionId === entry.versionId && item.blockId === entry.blockId
      ) || current.length >= CLAIM_EVIDENCE_MAX
        ? current
        : [...current, entry]
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) {
      return;
    }
    onSave({
      id: claim?.id ?? createClaimId(),
      threadItemId: itemId,
      text: trimmed,
      evidence,
    });
  };

  return (
    <form
      onSubmit={submit}
      aria-label={
        claim
          ? t('content_studio_grounding_edit_claim', 'Edit claim')
          : t('content_studio_grounding_add_claim', 'Add claim')
      }
      className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
    >
      <label className="flex flex-col gap-[4px] text-[12px]">
        {t('content_studio_grounding_claim_post', 'Post')}
        <select
          className={fieldClass}
          value={itemId}
          disabled={!!claim}
          onChange={(e) => setItemId(e.target.value)}
        >
          {thread.map((item, index) => (
            <option key={item.id} value={item.id}>
              {postLabel(t, index)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-[4px] text-[12px]">
        {t('content_studio_grounding_claim_text', 'Claim')}
        <textarea
          className={textareaClass}
          value={text}
          maxLength={CLAIM_TEXT_MAX}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {!!evidence.length && (
        <ul className="flex flex-col gap-[4px]">
          {evidence.map((entry, index) => (
            <li
              key={`${entry.versionId}/${entry.blockId}`}
              className="flex flex-wrap items-center gap-[8px] text-[13px]"
              data-form-evidence={entry.blockId}
            >
              <span className="flex-1 min-w-0 break-words">
                {`${t('content_studio_ai_source_version', 'Version')} ${
                  entry.versionNumber
                }`}
                {entry.quote ? ` · ${entry.quote}` : ''}
              </span>
              <Button
                secondary
                onClick={() =>
                  setEvidence((current) =>
                    current.filter((_, at) => at !== index)
                  )
                }
              >
                {t(
                  'content_studio_grounding_remove_evidence',
                  'Remove evidence'
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {evidence.length < CLAIM_EVIDENCE_MAX && <EvidencePicker onAdd={add} />}
      {!evidence.length && (
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_grounding_evidence_required',
            'A grounded claim needs at least one piece of evidence.'
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-[8px]">
        <Button type="submit" disabled={!valid}>
          {t('content_studio_grounding_save_claim', 'Save claim')}
        </Button>
        <Button secondary onClick={onCancel}>
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
};

// The grounding of a draft (editable) or of a saved version (read-only).
// A version saved without grounding says so; nothing is looked up to fill it
export const ContentStudioGroundingPanel: FC<{
  draft: ContentStudioDraft;
  mode: 'draft' | 'revision';
  editable?: boolean;
  edit?: (update: (draft: ContentStudioDraft) => ContentStudioDraft) => boolean;
}> = ({ draft, mode, editable = false, edit }) => {
  const t = useT();
  const [editing, setEditing] = useState<ContentStudioClaim | 'new' | null>(
    null
  );
  const claims = contentPackageClaims(draft) as ContentStudioClaim[];
  const thread = draft.copy.global.thread;
  const canEdit = editable && !!edit;

  const save = (claim: ContentStudioClaim) => {
    if (
      edit?.((latest) =>
        latest.copy.global.thread.some((item) => item.id === claim.threadItemId)
          ? (withContentPackageClaim(latest, claim) as ContentStudioDraft)
          : latest
      )
    ) {
      setEditing(null);
    }
  };
  const remove = (claimId: string) =>
    edit?.(
      (latest) =>
        withoutContentPackageClaim(latest, claimId) as ContentStudioDraft
    );

  return (
    <section
      aria-label={t('content_studio_grounding', 'Grounding')}
      className="flex flex-col gap-[12px] border border-newTableBorder rounded-[8px] p-[16px]"
      data-grounding-schema={draft.schemaVersion}
    >
      <div className="flex flex-wrap items-center gap-[8px]">
        <h3 className="flex-1 font-[600]">
          {t('content_studio_grounding', 'Grounding')}
        </h3>
        <span className="text-textItemBlur" data-claim-count={claims.length}>
          {t('content_studio_grounding_claims', 'Grounded claims')}:{' '}
          {claims.length}
        </span>
        {canEdit &&
          editing === null &&
          claims.length < GROUNDING_CLAIMS_MAX && (
            <Button secondary onClick={() => setEditing('new')}>
              {t('content_studio_grounding_add_claim', 'Add claim')}
            </Button>
          )}
      </div>
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_grounding_explain',
          'Claims of this package with the exact source passages that support them. Evidence shows what a captured source says, not that it is true.'
        )}
      </div>
      {!claims.length && (
        <div className="text-textItemBlur">
          {mode === 'revision'
            ? t(
                'content_studio_grounding_none_revision',
                'No grounded claims were recorded in this revision.'
              )
            : t(
                'content_studio_grounding_none_draft',
                'No grounded claims yet.'
              )}
        </div>
      )}
      {editing === 'new' && (
        <ClaimForm
          draft={draft}
          claim={null}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
      {!!claims.length && (
        <ul className="flex flex-col gap-[8px]">
          {thread.flatMap((item, index) =>
            claims
              .filter((claim) => claim.threadItemId === item.id)
              .map((claim) =>
                editing !== 'new' && editing?.id === claim.id ? (
                  <li key={claim.id}>
                    <ClaimForm
                      draft={draft}
                      claim={claim}
                      onSave={save}
                      onCancel={() => setEditing(null)}
                    />
                  </li>
                ) : (
                  <ClaimCard
                    key={claim.id}
                    claim={claim}
                    label={postLabel(t, index)}
                    editable={canEdit && editing === null}
                    onEdit={() => setEditing(claim)}
                    onRemove={() => remove(claim.id)}
                  />
                )
              )
          )}
        </ul>
      )}
    </section>
  );
};
