'use client';

import { FC } from 'react';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { ContentStudioDraft } from '@gitroom/frontend/components/content-studio/content-studio.api';
import { withThread } from '@gitroom/frontend/components/content-studio/content-studio.thread.editor';
import { ContentStudioAIProposal } from '@gitroom/frontend/components/content-studio/content-studio.ai-writing';

// The suggested texts by item id
const suggestedTexts = (proposal: ContentStudioAIProposal) =>
  new Map(
    proposal.proposal.type === 'item'
      ? [[proposal.proposal.itemId, proposal.proposal.text]]
      : proposal.proposal.items.map((entry) => [entry.itemId, entry.text])
  );

// The draft with the suggested texts in place. Only texts change: every
// item keeps its id, position and media, and none is added or removed
export const applyContentStudioAIProposal = (
  draft: ContentStudioDraft,
  proposal: ContentStudioAIProposal
): ContentStudioDraft => {
  const texts = suggestedTexts(proposal);
  return withThread(draft, (thread) =>
    thread.map((item) =>
      texts.has(item.id)
        ? { ...item, text: texts.get(item.id) as string }
        : item
    )
  );
};

// A suggestion fits the draft only while the draft is exactly the saved one
// it was made from: the same version, nothing unsaved, and (for a thread)
// the same items in the same order. Anything else needs a new suggestion
export const isContentStudioAIProposalCurrent = (
  proposal: ContentStudioAIProposal,
  draft: ContentStudioDraft,
  version: number,
  saved: boolean
) => {
  if (!saved || version !== proposal.baseDraftVersion) {
    return false;
  }
  const ids = draft.copy.global.thread.map((item) => item.id);
  return proposal.proposal.type === 'item'
    ? ids.includes(proposal.proposal.itemId)
    : proposal.proposal.items.length === ids.length &&
        proposal.proposal.items.every(
          (entry, index) => entry.itemId === ids[index]
        );
};

const TextPanel: FC<{ title: string; text: string }> = ({ title, text }) => (
  <div className="flex-1 min-w-[240px] flex flex-col gap-[4px]">
    <div className="text-[13px] font-[600]">{title}</div>
    <div className="whitespace-pre-wrap break-words border border-newTableBorder rounded-[8px] p-[12px] min-h-[48px]">
      {text}
    </div>
  </div>
);

// Current and Suggestion side by side (stacked on narrow screens), for one
// post or every post of the thread. Nothing changes until Accept; Discard
// writes nothing
export const ContentStudioAIProposalReview: FC<{
  proposal: ContentStudioAIProposal;
  draft: ContentStudioDraft;
  current: boolean;
  busy: boolean;
  onAccept: () => void;
  onDiscard: () => void;
}> = ({ proposal, draft, current, busy, onAccept, onDiscard }) => {
  const t = useT();
  const texts = suggestedTexts(proposal);
  const items = draft.copy.global.thread
    .map((item, index) => ({
      item,
      label:
        index === 0
          ? t('content_studio_main_post', 'Post')
          : `${t('content_studio_followup', 'Follow-up')} ${index}`,
    }))
    .filter(({ item }) => texts.has(item.id));

  return (
    <section
      aria-label={t('content_studio_ai_suggestion', 'AI suggestion')}
      className="flex flex-col gap-[12px] border border-newTableBorder rounded-[8px] p-[16px]"
    >
      <h3 className="font-[600]">
        {t('content_studio_ai_suggestion', 'AI suggestion')}
      </h3>
      {!current && (
        <div role="alert" className="text-textItemBlur">
          {t(
            'content_studio_ai_suggestion_stale',
            'This suggestion was generated from an older draft. Generate a new suggestion before applying it.'
          )}
        </div>
      )}
      {items.map(({ item, label }) => (
        <div
          key={item.id}
          data-proposal-item={item.id}
          className="flex flex-col gap-[8px]"
        >
          {proposal.proposal.type === 'thread' && (
            <div className="font-[600]">{label}</div>
          )}
          <div className="flex flex-wrap gap-[12px]">
            <TextPanel
              title={t('content_studio_ai_current', 'Current')}
              text={item.text}
            />
            <TextPanel
              title={t('content_studio_ai_suggestion_text', 'Suggestion')}
              text={texts.get(item.id) as string}
            />
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-[8px]">
        <Button loading={busy} disabled={busy || !current} onClick={onAccept}>
          {t('content_studio_ai_accept', 'Accept')}
        </Button>
        <Button secondary disabled={busy} onClick={onDiscard}>
          {t('content_studio_ai_discard', 'Discard')}
        </Button>
      </div>
    </section>
  );
};
