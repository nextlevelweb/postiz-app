import fs from 'fs';
import path from 'path';
import {
  ContentStudioSourceFeedError,
  parseContentStudioSourceFeed,
  SOURCE_FEED_ENTRY_TITLE_MAX,
  SOURCE_FEED_MAX_ENTRIES,
  SOURCE_FEED_MEDIA_TYPES,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.feed';

// The feed reader (P8-01) on bytes only: no network, no clock. Every feed
// here is a literal; nothing is ever fetched
const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (
  xml: string | Uint8Array,
  contentType: unknown = 'application/rss+xml; charset=utf-8',
  maxEntries?: number
) =>
  parseContentStudioSourceFeed({
    contentType,
    body: typeof xml === 'string' ? bytes(xml) : xml,
    maxEntries,
  });
const refused = (call: () => unknown) => {
  try {
    call();
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioSourceFeedError);
    return (err as ContentStudioSourceFeedError).code;
  }
  throw new Error('expected a refusal');
};

const MARKER = 'FEED_PARSER_PRIVATE_MARKER_123';
const rss = (items: string, channel = '<title>News</title>') =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${channel}${items}</channel></rss>`;
const item = (link: string | null, extra = '<title>Story</title>', guid = '') =>
  `<item>${extra}${link === null ? '' : `<link>${link}</link>`}${guid}</item>`;
const atom = (entries: string) =>
  `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><id>urn:blog</id>${entries}</feed>`;

describe('parseContentStudioSourceFeed: formats', () => {
  it('FC1/EN1/EN7 reads RSS 2.0: page link, guid, title and date of each item, in feed order', () => {
    const feed = parse(
      rss(
        item(
          'https://news.example/a?x=1#top',
          '<title>First &amp; best</title><pubDate>Tue, 20 Oct 2026 08:00:00 GMT</pubDate>',
          '<guid isPermaLink="false">guid-a</guid>'
        ) +
          item(
            'https://news.example/b',
            '<title><![CDATA[Second <b>bold</b>]]></title><dc:date>2026-10-19T07:30:00Z</dc:date>'
          )
      )
    );
    expect(feed).toEqual({
      format: 'rss',
      mediaType: 'application/rss+xml',
      entriesSeen: 2,
      entriesSkipped: 0,
      entriesIgnored: 0,
      entries: [
        {
          // canonical: the fragment is gone, the query stays
          url: 'https://news.example/a?x=1',
          entryId: 'guid-a',
          title: 'First & best',
          publishedAt: new Date('2026-10-20T08:00:00.000Z'),
        },
        {
          url: 'https://news.example/b',
          entryId: null,
          // an RSS title is text: markup in it stays characters
          title: 'Second <b>bold</b>',
          publishedAt: new Date('2026-10-19T07:30:00.000Z'),
        },
      ],
    });
  });

  it('FC2 reads Atom: the alternate (or rel-less) link, id, html or xhtml title, published else updated', () => {
    const feed = parse(
      atom(
        `<entry><title type="html">&lt;em&gt;Launch&lt;/em&gt; day</title><link rel="enclosure" href="https://blog.example/a.mp3"/><link rel="alternate" type="text/html" href="https://blog.example/launch"/><id>urn:1</id><published>2026-10-01T10:00:00+02:00</published><updated>2026-10-02T10:00:00Z</updated></entry>` +
          `<entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Plain <b>part</b></div></title><link href="https://blog.example/plain"/><id>urn:2</id><updated>2026-10-03T00:00:00Z</updated></entry>`
      ),
      'application/atom+xml'
    );
    expect(feed.format).toBe('atom');
    expect(feed.entries).toEqual([
      {
        url: 'https://blog.example/launch',
        entryId: 'urn:1',
        title: 'Launch day',
        publishedAt: new Date('2026-10-01T08:00:00.000Z'),
      },
      {
        url: 'https://blog.example/plain',
        entryId: 'urn:2',
        title: 'Plain part',
        publishedAt: new Date('2026-10-03T00:00:00.000Z'),
      },
    ]);
  });

  it('reads RSS 1.0 (RDF): items next to the channel, rdf:about as the id', () => {
    const feed = parse(
      `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="https://r.example/"><title>R</title></channel><item rdf:about="https://r.example/1"><title>One</title><link>https://r.example/1</link><dc:date>2026-09-09T09:09:09Z</dc:date></item></rdf:RDF>`,
      'application/rdf+xml'
    );
    expect(feed.format).toBe('rdf');
    expect(feed.entries).toEqual([
      {
        url: 'https://r.example/1',
        entryId: 'https://r.example/1',
        title: 'One',
        publishedAt: new Date('2026-09-09T09:09:09.000Z'),
      },
    ]);
  });

  it('a feed without entries is a feed: nothing to find', () => {
    expect(parse(rss('')).entries).toEqual([]);
    expect(parse(atom(''), 'text/xml').entriesSeen).toBe(0);
  });
});

describe('parseContentStudioSourceFeed: entries', () => {
  it('EN2/EN3/EN4/EN6 uses an absolute https link only: relative, missing, other schemes and guid-only entries are skipped', () => {
    const feed = parse(
      rss(
        [
          item('/relative/path'),
          item('relative'),
          item(null, '<title>No link</title>'),
          item('javascript:alert(1)'),
          item('file:///etc/passwd'),
          item('ftp://files.example/a'),
          item('data:text/html,hi'),
          item('mailto:a@b.example'),
          // capture fetches https only
          item('http://plain.example/a'),
          item('https://user:pass@secret.example/a'),
          item('https://'),
          item(' '),
          // the guid is a permalink by RSS rules, and still never a link here
          item(
            null,
            '<title>Guid only</title>',
            '<guid isPermaLink="true">https://news.example/guid-only</guid>'
          ),
          item('https://news.example/kept'),
        ].join('')
      )
    );
    expect(feed.entries.map((entry) => entry.url)).toEqual([
      'https://news.example/kept',
    ]);
    expect(feed.entriesSeen).toBe(14);
    expect(feed.entriesSkipped).toBe(13);
    expect(JSON.stringify(feed)).not.toContain('guid-only');
  });

  it('an Atom entry with only enclosure or related links has no page', () => {
    const feed = parse(
      atom(
        '<entry><title>Pod</title><link rel="enclosure" href="https://a.example/x.mp3"/><link rel="related" href="https://a.example/rel"/><id>urn:x</id></entry>'
      ),
      'application/atom+xml'
    );
    expect(feed.entries).toEqual([]);
    expect(feed.entriesSkipped).toBe(1);
  });

  it('EN5 lists a page once per capture: the first entry of it wins', () => {
    const feed = parse(
      rss(
        item('https://news.example/a', '<title>First</title>') +
          item('https://NEWS.example/a#again', '<title>Second</title>') +
          item('https://news.example/b')
      )
    );
    expect(feed.entries.map((entry) => [entry.url, entry.title])).toEqual([
      ['https://news.example/a', 'First'],
      ['https://news.example/b', 'Story'],
    ]);
    expect(feed.entriesSkipped).toBe(1);
  });

  it('EN8 a date that is no date is null, never an error', () => {
    const feed = parse(
      rss(
        [
          item('https://d.example/1', '<pubDate>yesterday-ish</pubDate>'),
          item('https://d.example/2', '<pubDate></pubDate>'),
          item(
            'https://d.example/3',
            '<pubDate>Mon, 01 Jan 1900 00:00:00 GMT</pubDate>'
          ),
          item(
            'https://d.example/4',
            '<pubDate>Mon, 32 Foo 2026 99:99:99 ZZZ</pubDate>'
          ),
        ].join('')
      )
    );
    expect(feed.entries.map((entry) => entry.publishedAt)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    // an invalid Atom date as well (published, then updated)
    expect(
      parse(
        atom(
          '<entry><title>A</title><link href="https://d.example/a"/><published>not a date</published><updated>also not</updated></entry>'
        ),
        'application/atom+xml'
      ).entries[0].publishedAt
    ).toBeNull();
  });

  it('titles are plain labels: whitespace collapsed, controls dropped, cut to the source name limit', () => {
    const long = 'Ä'.repeat(SOURCE_FEED_ENTRY_TITLE_MAX + 40);
    const feed = parse(
      rss(
        item(
          'https://t.example/1',
          '<title>  Many\n\t spaces   here </title>'
        ) +
          item('https://t.example/2', `<title>${long}</title>`) +
          item('https://t.example/3', '<title>   </title>') +
          item('https://t.example/4', '<title>a&#1;b&#x7F;c</title>') +
          item('https://t.example/5', `<title>${'x'.repeat(199)}😀tail</title>`)
      )
    );
    expect(feed.entries.map((entry) => entry.title)).toEqual([
      'Many spaces here',
      'Ä'.repeat(SOURCE_FEED_ENTRY_TITLE_MAX),
      null,
      'abc',
      // never half a character
      'x'.repeat(199),
    ]);
  });

  it('an id that is too long or has controls is no id; the entry stays', () => {
    const feed = parse(
      rss(
        item('https://i.example/1', '', `<guid>${'g'.repeat(2049)}</guid>`) +
          item('https://i.example/2', '', '<guid>ok-id</guid>')
      )
    );
    expect(feed.entries.map((entry) => entry.entryId)).toEqual([null, 'ok-id']);
  });

  it('FL1/FL2/FL3 reads the first maxEntries entries in feed order only; the rest is counted, never read', () => {
    const items = Array.from({ length: SOURCE_FEED_MAX_ENTRIES + 7 }, (_, i) =>
      item(`https://l.example/${i}`, `<title>T${i}</title>`)
    ).join('');
    const feed = parse(rss(items));
    expect(feed.entries.map((entry) => entry.url)).toEqual(
      Array.from(
        { length: SOURCE_FEED_MAX_ENTRIES },
        (_, i) => `https://l.example/${i}`
      )
    );
    expect(feed.entriesSeen).toBe(SOURCE_FEED_MAX_ENTRIES + 7);
    expect(feed.entriesIgnored).toBe(7);
    // dates are not used to reorder: an undated later entry keeps its place
    const ordered = parse(
      rss(
        item(
          'https://o.example/old',
          '<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>'
        ) +
          item('https://o.example/undated') +
          item(
            'https://o.example/new',
            '<pubDate>Mon, 19 Oct 2026 00:00:00 GMT</pubDate>'
          )
      ),
      undefined,
      2
    );
    expect(ordered.entries.map((entry) => entry.url)).toEqual([
      'https://o.example/old',
      'https://o.example/undated',
    ]);
    expect(ordered.entriesIgnored).toBe(1);
  });
});

describe('parseContentStudioSourceFeed: what it refuses', () => {
  it('FC5 malformed XML, an unknown root or an rss without channel is no feed', () => {
    expect(
      refused(() => parse('<rss version="2.0"><channel><item></rss>'))
    ).toBe('INVALID_XML');
    expect(refused(() => parse(`not xml at all ${MARKER}`))).toBe(
      'INVALID_XML'
    );
    expect(refused(() => parse(''))).toBe('INVALID_XML');
    expect(refused(() => parse('<html><body>Hi</body></html>'))).toBe(
      'NOT_A_FEED'
    );
    expect(refused(() => parse('<rss version="2.0"></rss>'))).toBe(
      'NOT_A_FEED'
    );
  });

  it('63 refuses any document type declaration: no entity can be declared, nothing external is read', () => {
    const doctypes = [
      `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel><item><title>&xxe;</title><link>https://x.example/a</link></item></channel></rss>`,
      `<!DOCTYPE rss [<!ENTITY a "${'x'.repeat(
        50
      )}"><!ENTITY b "&a;&a;&a;&a;&a;">]><rss version="2.0"><channel><title>&b;</title></channel></rss>`,
      `<!-- a comment first --><!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd"><rss version="0.91"><channel></channel></rss>`,
      `﻿<?xml version="1.0"?>\n  <!doctype feed SYSTEM "https://evil.example/x.dtd"><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
    ];
    for (const xml of doctypes) {
      expect(refused(() => parse(xml))).toBe('DOCTYPE_REFUSED');
    }
    // an undeclared entity is not expanded into anything: it stays text
    expect(
      parse(rss(item('https://x.example/a', '<title>&undeclared;</title>')))
        .entries[0].title
    ).toBe('&undeclared;');
  });

  it('names that could pollute an object fail the whole feed closed', () => {
    for (const name of ['__proto__', 'constructor']) {
      const result = (() => {
        try {
          return parse(
            rss(
              item(
                'https://p.example/a',
                `<${name}>x</${name}><title>T</title>`
              )
            )
          );
        } catch (err) {
          return err;
        }
      })();
      if (result instanceof Error) {
        expect(result).toBeInstanceOf(ContentStudioSourceFeedError);
      } else {
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      }
    }
  });

  it('refuses documents nested too deeply', () => {
    const deep = `${'<x>'.repeat(150)}${'</x>'.repeat(150)}`;
    expect(
      refused(() =>
        parse(
          rss(
            item(
              'https://n.example/a',
              `<title>T</title><extra>${deep}</extra>`
            )
          )
        )
      )
    ).toBe('INVALID_XML');
  });

  it('FC6 reads XML media types only: HTML, text, JSON and binary are refused before parsing', () => {
    expect([...SOURCE_FEED_MEDIA_TYPES].sort()).toEqual([
      'application/atom+xml',
      'application/rdf+xml',
      'application/rss+xml',
      'application/xml',
      'text/xml',
    ]);
    for (const type of [
      'text/html',
      'text/plain',
      'application/octet-stream',
      'application/json',
      'image/svg+xml',
      '',
      undefined,
      42,
      `text/xml\u0000`,
    ]) {
      expect(
        refused(() =>
          parseContentStudioSourceFeed({
            contentType: type,
            body: bytes(rss('')),
          })
        )
      ).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    for (const type of [
      'application/rss+xml',
      'APPLICATION/ATOM+XML; charset="UTF-8"',
      'application/xml',
      'text/xml; charset=iso-8859-1',
    ]) {
      expect(parse(rss(''), type).format).toBe('rss');
    }
  });

  it('64 decodes UTF-8 (with or without a byte order mark) and windows-1252 only, strictly', () => {
    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...bytes(rss(item('https://e.example/a', '<title>Café</title>'))),
    ]);
    expect(parse(bom, 'application/rss+xml').entries[0].title).toBe('Café');
    // the XML declaration names windows-1252; the header has no charset
    const latin = new Uint8Array([
      ...bytes(
        '<?xml version="1.0" encoding="ISO-8859-1"?><rss version="2.0"><channel><item><title>Caf'
      ),
      0xe9,
      ...bytes(
        '</title><link>https://e.example/b</link></item></channel></rss>'
      ),
    ]);
    expect(parse(latin, 'text/xml').entries[0].title).toBe('Café');
    // the header charset wins over the declaration
    expect(
      parse(latin, 'text/xml; charset=windows-1252').entries[0].title
    ).toBe('Café');
    expect(refused(() => parse(latin, 'text/xml; charset=utf-8'))).toBe(
      'INVALID_ENCODING'
    );
    expect(refused(() => parse(rss(''), 'text/xml; charset=utf-16'))).toBe(
      'UNSUPPORTED_CHARSET'
    );
    expect(
      refused(() =>
        parse(
          '<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel></channel></rss>',
          'text/xml'
        )
      )
    ).toBe('UNSUPPORTED_CHARSET');
    // UTF-16 bytes are not UTF-8
    const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x72, 0x00]);
    expect(refused(() => parse(utf16, 'text/xml'))).toBe('INVALID_ENCODING');
  });

  it('errors are fixed: never a byte of the feed', () => {
    for (const call of [
      () => parse(`<rss>${MARKER}`),
      () => parse(rss(MARKER), `text/${MARKER}`),
      () => parse(`<!DOCTYPE x [<!ENTITY m "${MARKER}">]><rss/>`),
    ]) {
      try {
        call();
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(ContentStudioSourceFeedError);
        expect(String((err as Error).message)).not.toContain(MARKER);
        expect(JSON.stringify(err)).not.toContain(MARKER);
      }
    }
  });
});

describe('source.feed.ts boundaries', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'source.feed.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('P801-1/P801-2/FC4 parses a string only: no fetch, no URL loading, no rss-parser, no file or network module', () => {
    const imports = Array.from(
      text.matchAll(/^import[\s\S]*?from '([^']+)';$/gm),
      (match) => match[1]
    );
    expect(imports.sort()).toEqual(
      [
        '@gitroom/nestjs-libraries/content-studio/sources/source.extract',
        '@gitroom/nestjs-libraries/content-studio/sources/source.types',
        '@gitroom/nestjs-libraries/content-studio/sources/source.url',
        'fast-xml-parser',
        'parse5',
      ].sort()
    );
    expect(text).not.toMatch(
      /rss-parser|parseURL|\bfetch\(|safeFetch|axios|undici|\bhttps?\b'|require\(|import\(|XMLHttpRequest|\bfs\b|readFile|process\.env|Date\.now|new Date\(\)/
    );
  });

  it('P801-5 has no AI, scoring, topic or summary field', () => {
    expect(text).not.toMatch(
      /AIExecution|openai|anthropic|embedding|score|sentiment|topic|cluster|summary/i
    );
  });
});
