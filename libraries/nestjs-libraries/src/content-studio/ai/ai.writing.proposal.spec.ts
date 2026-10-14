import fs from 'fs';
import path from 'path';
import {
  parseContentStudioAIItemProposal,
  parseContentStudioAIThreadProposal,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.writing.proposal';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';

const IDS = ['main', 'f1', 'f2'];
const RESULT = 'RESULT_PRIVATE_MARKER_654';
const NUL = String.fromCharCode(0);
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xdca9);

const refused = (run: () => unknown) => {
  let error: unknown;
  try {
    run();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioAIProviderError);
  expect((error as ContentStudioAIProviderError).code).toBe('INVALID_RESPONSE');
  // a fixed message: never the answer it refused
  expect(JSON.stringify(error)).not.toContain(RESULT);
  expect(String(error)).not.toContain(RESULT);
};

const answer = (items: unknown) => JSON.stringify({ items });

describe('AI item proposal', () => {
  it('keeps the text as it came, line endings normalized', () => {
    expect(
      parseContentStudioAIItemProposal(`  ${RESULT}\r\nnext\rlast \n`)
    ).toBe(`  ${RESULT}\nnext\nlast \n`);
  });

  it('accepts exactly 10000 characters, after line endings are normalized', () => {
    expect(parseContentStudioAIItemProposal('a'.repeat(10_000))).toHaveLength(
      10_000
    );
    expect(
      parseContentStudioAIItemProposal('a'.repeat(9_998) + '\r\n')
    ).toHaveLength(9_999);
    expect(parseContentStudioAIItemProposal(`a${HIGH}${LOW}`)).toBe(
      `a${HIGH}${LOW}`
    );
  });

  it.each([
    ['BI14 more than 10000 characters', 'a'.repeat(10_001)],
    ['an empty text', ''],
    ['whitespace only', ' \n\t '],
    ['BI15 a NUL', `${RESULT}${NUL}`],
    ['BI15 a lone high surrogate', `${RESULT}${HIGH}`],
    ['BI15 a lone low surrogate', `${LOW}${RESULT}`],
    ['BI13 a number', 42],
    ['BI13 null', null],
    ['BI13 an object', { text: RESULT }],
    ['BI13 undefined', undefined],
  ])('refuses %s', (_name, value) => {
    refused(() => parseContentStudioAIItemProposal(value));
  });
});

describe('AI thread proposal', () => {
  it('BT4 parses one entry per item', () => {
    expect(
      parseContentStudioAIThreadProposal(
        answer([
          { itemId: 'main', text: `${RESULT} one` },
          { itemId: 'f1', text: 'two\r\nlines' },
          { itemId: 'f2', text: 'three' },
        ]),
        IDS
      )
    ).toEqual([
      { itemId: 'main', text: `${RESULT} one` },
      { itemId: 'f1', text: 'two\nlines' },
      { itemId: 'f2', text: 'three' },
    ]);
  });

  it('BT5 returns the draft order whatever order the provider used', () => {
    expect(
      parseContentStudioAIThreadProposal(
        answer([
          { text: 'three', itemId: 'f2' },
          { itemId: 'main', text: 'one' },
          { itemId: 'f1', text: 'two' },
        ]),
        IDS
      ).map((entry) => entry.itemId)
    ).toEqual(IDS);
  });

  it('accepts whitespace around the JSON object', () => {
    expect(
      parseContentStudioAIThreadProposal(
        `\n  ${answer([{ itemId: 'main', text: 'one' }])}  \n`,
        ['main']
      )
    ).toEqual([{ itemId: 'main', text: 'one' }]);
  });

  it.each([
    [
      'BT6 a missing item',
      answer([
        { itemId: 'main', text: 'one' },
        { itemId: 'f1', text: 'two' },
      ]),
    ],
    [
      'BT7 an extra item',
      answer([
        { itemId: 'main', text: 'one' },
        { itemId: 'f1', text: 'two' },
        { itemId: 'f2', text: 'three' },
        { itemId: 'f3', text: 'four' },
      ]),
    ],
    [
      'BT8 a duplicate item',
      answer([
        { itemId: 'main', text: 'one' },
        { itemId: 'main', text: 'again' },
        { itemId: 'f2', text: 'three' },
      ]),
    ],
    [
      'BT9 an unknown item id',
      answer([
        { itemId: 'main', text: 'one' },
        { itemId: 'other', text: 'two' },
        { itemId: 'f2', text: 'three' },
      ]),
    ],
    [
      'an item id of another case',
      answer([
        { itemId: 'MAIN', text: 'one' },
        { itemId: 'f1', text: 'two' },
        { itemId: 'f2', text: 'three' },
      ]),
    ],
    ['BT10 malformed JSON', `{"items":[{"itemId":"main","text":"${RESULT}"}`],
    ['BT10 no JSON at all', RESULT],
    ['BT10 an empty answer', ''],
    [
      'BT11 a Markdown fence',
      '```json\n' +
        answer([
          { itemId: 'main', text: 'a' },
          { itemId: 'f1', text: 'b' },
          { itemId: 'f2', text: 'c' },
        ]) +
        '\n```',
    ],
    [
      'BT11 commentary before the JSON',
      `Here you go: ${answer([
        { itemId: 'main', text: 'a' },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ])}`,
    ],
    [
      'BT11 commentary after the JSON',
      `${answer([
        { itemId: 'main', text: 'a' },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ])} Hope it helps`,
    ],
    [
      'BT12 an unknown top-level field',
      JSON.stringify({
        items: [
          { itemId: 'main', text: 'a' },
          { itemId: 'f1', text: 'b' },
          { itemId: 'f2', text: 'c' },
        ],
        note: RESULT,
      }),
    ],
    [
      'BT12 an unknown item field',
      answer([
        { itemId: 'main', text: 'a', mediaIds: ['m1'] },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ]),
    ],
    [
      'BT12 a __proto__ field',
      '{"items":[{"itemId":"main","text":"a","__proto__":{"x":1}},{"itemId":"f1","text":"b"},{"itemId":"f2","text":"c"}]}',
    ],
    [
      'a missing text',
      answer([
        { itemId: 'main' },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ]),
    ],
    [
      'a text that is not a string',
      answer([
        { itemId: 'main', text: 7 },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ]),
    ],
    [
      'BT13 an overlong text',
      answer([
        { itemId: 'main', text: 'a'.repeat(10_001) },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ]),
    ],
    [
      'an empty text',
      answer([
        { itemId: 'main', text: '  ' },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ]),
    ],
    [
      'a NUL in a text',
      answer([
        { itemId: 'main', text: `a${NUL}` },
        { itemId: 'f1', text: 'b' },
        { itemId: 'f2', text: 'c' },
      ]),
    ],
    ['items that are not a list', JSON.stringify({ items: { main: 'a' } })],
    ['a list at the top', JSON.stringify([{ itemId: 'main', text: 'a' }])],
    ['null', 'null'],
    ['a string', JSON.stringify(answer([]))],
    ['an entry that is a string', answer(['main', 'f1', 'f2'])],
    [
      'an entry that is null',
      answer([null, { itemId: 'f1', text: 'b' }, { itemId: 'f2', text: 'c' }]),
    ],
  ])('refuses %s', (_name, raw) => {
    refused(() => parseContentStudioAIThreadProposal(raw, IDS));
  });

  it('refuses an answer that is not text', () => {
    refused(() => parseContentStudioAIThreadProposal({ items: [] }, IDS));
  });
});

describe('AI writing proposal source', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'ai.writing.proposal.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('repairs nothing: no fence stripping, cutting or trimming of the text', () => {
    expect(text).not.toMatch(
      /```|replace\(|slice\(|substring\(|(return|=)[^;\n]*\.trim\(\)/
    );
    expect(text).not.toMatch(/console\.|Logger|prisma|Repository/);
  });
});
