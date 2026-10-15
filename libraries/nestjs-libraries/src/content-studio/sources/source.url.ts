import { utf8ByteLength } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';

// The canonical form of a source URL: what a source is stored and compared
// under, and how a version's requested and final URL are kept.
//
// This is syntax only. It does not decide whether a URL is safe to fetch:
// http://127.0.0.1/ or http://10.0.0.1/ are valid source URLs here. Network
// safety (private and reserved addresses, DNS answers, redirects, ports)
// belongs to SafeFetch, which ingestion has to go through for every request.
//
// Canonical means what the WHATWG URL parser makes of it (lowercase scheme
// and host, punycode, default port removed, dot segments resolved, percent
// encoding where required) with the fragment removed. Nothing that can change
// which resource the URL names is touched: the path keeps its case and
// trailing slash, the query keeps every parameter in its order

export const CONTENT_STUDIO_SOURCE_URL_MAX_BYTES = 2048;

const SCHEMES = ['http:', 'https:'];
// C0 controls, DEL and C1 controls. The URL parser would silently drop some
// of them (tab, newline), so they are refused before parsing
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// A fixed message: a URL can carry tokens in its query, so it is never quoted
export class ContentStudioSourceUrlError extends Error {
  constructor() {
    super('The source URL is invalid');
    this.name = 'ContentStudioSourceUrlError';
  }
}

export function canonicalContentStudioSourceUrl(input: unknown): string {
  if (
    typeof input !== 'string' ||
    CONTROL.test(input) ||
    UNPAIRED_SURROGATE.test(input) ||
    utf8ByteLength(input) > CONTENT_STUDIO_SOURCE_URL_MAX_BYTES
  ) {
    throw new ContentStudioSourceUrlError();
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ContentStudioSourceUrlError();
  }
  // credentials in a URL would be stored and shown with the source
  if (
    !SCHEMES.includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new ContentStudioSourceUrlError();
  }
  url.hash = '';

  // the serialized URL is ASCII, but it can be longer than the input
  const canonical = url.href;
  if (utf8ByteLength(canonical) > CONTENT_STUDIO_SOURCE_URL_MAX_BYTES) {
    throw new ContentStudioSourceUrlError();
  }
  return canonical;
}
