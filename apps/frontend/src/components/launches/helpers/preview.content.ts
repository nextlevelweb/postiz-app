import { escape } from 'lodash';

// The previews turn mentions into [[[name]]] before stripHtmlValidation
const MENTION = /\[\[\[([.\s\S]*?)]]]/;

const highlightMention = (text: string) =>
  text.replace(
    MENTION,
    (match, name) =>
      `<span class="font-bold font-[arial]" style="color: #ae8afc">${name}</span>`
  );

// stripHtmlValidation returns plain text with &lt;/&gt; decoded, so typed
// markup comes back as real tags. The text is sliced first (same offsets as the
// character counter), then every user-controlled piece, mention names included,
// is escaped; only the hard-coded span/mark here is ever markup
export const previewHtml = (text: string, start: number, end: number) =>
  highlightMention(escape(text.slice(start, end))) +
  `<mark class="bg-red-500" data-tooltip-id="tooltip" data-tooltip-content="This text will be cropped">` +
  highlightMention(escape(text.slice(end))) +
  `</mark>`;
