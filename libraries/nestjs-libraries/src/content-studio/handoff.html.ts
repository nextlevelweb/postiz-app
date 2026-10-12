import { sanitizePostContent } from '@gitroom/helpers/utils/sanitize.post.content';

// Escapes text the way an HTML serializer writes a text node (&, <, > and the
// no-break space), so sanitizing the result leaves it byte for byte the
// same. Quotes need no escaping outside attributes
const TEXT_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\u00a0': '&nbsp;',
};
const escapeText = (text: string) =>
  text.replace(/[&<>\u00a0]/g, (character) => TEXT_ESCAPES[character]);

// One <p> per line, the shape the composer builds itself and the one
// stripHtmlValidation turns back into lines. Each line is escaped before it
// is wrapped, so the only markup is the <p> added here
const paragraphHtml = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<p>${escapeText(line)}</p>`)
    .join('');

// Turns one plain-text Content Studio thread item into composer HTML. The
// result always contains <p>, so the composer never takes its unescaped
// plain-text path for Studio content. It then goes through the same
// sanitizer as a saved post, as a second line of defence
export const contentStudioTextToComposerHtml = (text: string) =>
  sanitizePostContent(paragraphHtml(text));
