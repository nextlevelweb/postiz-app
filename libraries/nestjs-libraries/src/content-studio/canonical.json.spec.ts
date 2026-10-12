import { createHash } from 'crypto';
import {
  canonicalJson,
  CanonicalJsonError,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

const rejection = (value: unknown) => {
  try {
    canonicalJson(value);
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalJsonError);
    return (error as Error).message;
  }
  throw new Error('expected a CanonicalJsonError');
};

describe('canonicalJson', () => {
  describe('primitives', () => {
    it.each([
      [null, 'null'],
      [true, 'true'],
      [false, 'false'],
      [0, '0'],
      [-0, '0'],
      [42, '42'],
      [-7, '-7'],
      [Number.MAX_SAFE_INTEGER, '9007199254740991'],
      [Number.MIN_SAFE_INTEGER, '-9007199254740991'],
      ['', '""'],
      ['plain', '"plain"'],
      ['quote " backslash \\ slash /', '"quote \\" backslash \\\\ slash /"'],
      ['line\nfeed\ttab\u0001\u001f', '"line\\nfeed\\ttab\\u0001\\u001f"'],
      ['emoji 😀 é', '"emoji 😀 é"'],
    ])('writes %p as %s', (value, expected) => {
      expect(canonicalJson(value)).toBe(expected);
      expect(JSON.parse(canonicalJson(value))).toEqual(
        value === -0 ? 0 : value
      );
    });
  });

  describe('objects and arrays', () => {
    it('sorts object keys', () => {
      expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    });

    it('sorts nested keys, inside arrays too', () => {
      expect(
        canonicalJson({ z: { y: 1, x: [{ d: 1, c: 2 }] }, a: { c: null } })
      ).toBe('{"a":{"c":null},"z":{"x":[{"c":2,"d":1}],"y":1}}');
    });

    it('sorts by UTF-16 code units', () => {
      expect(canonicalJson({ b: 1, B: 2, a: 3, '10': 4, '9': 5, é: 6 })).toBe(
        '{"10":4,"9":5,"B":2,"a":3,"b":1,"é":6}'
      );
    });

    it('keeps array order', () => {
      expect(canonicalJson([1, 2])).toBe('[1,2]');
      expect(canonicalJson([2, 1])).toBe('[2,1]');
      expect(canonicalJson([])).toBe('[]');
      expect(canonicalJson({})).toBe('{}');
    });

    it('gives the same text and hash whatever the insertion order', () => {
      const first = {
        name: 'a',
        list: [{ x: 1, y: 2 }],
        nested: { p: 1, q: 2 },
      };
      const second = {
        nested: { q: 2, p: 1 },
        list: [{ y: 2, x: 1 }],
        name: 'a',
      };

      expect(canonicalJson(first)).toBe(canonicalJson(second));
      expect(sha256Hex(canonicalJson(first))).toBe(
        sha256Hex(canonicalJson(second))
      );
    });

    it('writes a child shared by two branches twice', () => {
      const child = { x: 1 };
      expect(canonicalJson({ a: child, b: child })).toBe(
        '{"a":{"x":1},"b":{"x":1}}'
      );
      expect(canonicalJson([child, [child]])).toBe('[{"x":1},[{"x":1}]]');
    });

    it('accepts a null-prototype object', () => {
      const bare = Object.create(null);
      bare.b = 1;
      bare.a = 'x';
      expect(canonicalJson(bare)).toBe('{"a":"x","b":1}');
    });

    it('ignores inherited properties, also from a polluted prototype', () => {
      const prototype = Object.prototype as Record<string, unknown>;
      prototype.polluted = 'yes';
      try {
        expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
      } finally {
        delete prototype.polluted;
      }
    });
  });

  describe('cycles', () => {
    it('rejects an object containing itself', () => {
      const self: Record<string, unknown> = { a: 1 };
      self.self = self;
      expect(rejection(self)).toBe('Cyclic value');
    });

    it('rejects a deep cycle', () => {
      const root: Record<string, any> = { b: { c: { d: {} } } };
      root.b.c.d.back = root;
      expect(rejection(root)).toBe('Cyclic value');
    });

    it('rejects an array containing itself', () => {
      const list: unknown[] = [1];
      list.push(list);
      expect(rejection(list)).toBe('Cyclic value');
    });
  });

  describe('unsupported values', () => {
    class Point {
      x = 1;
    }

    it.each([
      ['undefined', undefined, 'Unsupported undefined value'],
      ['function', () => 1, 'Unsupported function value'],
      ['symbol', Symbol('s'), 'Unsupported symbol value'],
      ['bigint', BigInt(1), 'Unsupported bigint value'],
      ['NaN', NaN, 'Only safe integers are supported'],
      ['Infinity', Infinity, 'Only safe integers are supported'],
      ['-Infinity', -Infinity, 'Only safe integers are supported'],
      ['1.5', 1.5, 'Only safe integers are supported'],
      [
        'unsafe integer',
        Number.MAX_SAFE_INTEGER + 1,
        'Only safe integers are supported',
      ],
      ['Date', new Date(0), 'Only plain objects are supported'],
      ['Map', new Map([['a', 1]]), 'Only plain objects are supported'],
      ['Set', new Set([1]), 'Only plain objects are supported'],
      ['RegExp', /x/, 'Only plain objects are supported'],
      ['class instance', new Point(), 'Only plain objects are supported'],
      ['typed array', new Uint8Array(2), 'Only plain objects are supported'],
      [
        'object with a prototype',
        Object.create({ inherited: 1 }),
        'Only plain objects are supported',
      ],
      [
        'array containing undefined',
        [1, undefined],
        'Unsupported undefined value',
      ],
      // eslint-disable-next-line no-sparse-arrays
      ['sparse array', [1, , 3], 'Unsupported undefined value'],
      [
        'property set to undefined',
        { a: undefined },
        'Unsupported undefined value',
      ],
      [
        'object with toJSON, which is never called',
        { toJSON: () => 'x' },
        'Unsupported function value',
      ],
      [
        'enumerable symbol key',
        { a: 1, [Symbol('s')]: 2 },
        'Symbol keys are not supported',
      ],
    ])('rejects %s', (_name, value, message) => {
      expect(rejection(value)).toBe(message);
    });
  });
});

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'hello',
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    ],
  ])('hashes %p to the standard digest', (text, digest) => {
    expect(sha256Hex(text)).toBe(digest);
  });

  it('hashes the UTF-8 bytes of the text', () => {
    const digestOf = (bytes: number[]) =>
      createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    // "é" is c3 a9 in UTF-8 and e9 in latin1
    expect(sha256Hex('é')).toBe(digestOf([0xc3, 0xa9]));
    expect(sha256Hex('é')).not.toBe(digestOf([0xe9]));
  });

  it('refuses anything but a string', () => {
    expect(() => sha256Hex({ a: 1 } as unknown as string)).toThrow(TypeError);
  });
});

describe('revision content hashing', () => {
  const thread = [
    { id: 'main', text: 'Launch day', mediaIds: ['m1', 'm2'] },
    { id: 'follow', text: 'More soon', mediaIds: [] },
  ];
  const hashOf = (input: unknown) =>
    sha256Hex(canonicalJson(parseContentPackageDraft(input)));

  it('writes a draft as fixed canonical text', () => {
    expect(
      canonicalJson(
        parseContentPackageDraft({
          schemaVersion: 1,
          copy: { global: { thread: [thread[0]] } },
        })
      )
    ).toBe(
      '{"copy":{"global":{"thread":[{"id":"main","mediaIds":["m1","m2"],"text":"Launch day"}]}},"schemaVersion":1}'
    );
  });

  it('hashes the same draft written in another key order identically', () => {
    const forward = { schemaVersion: 1, copy: { global: { thread } } };
    const backward = {
      copy: {
        global: {
          thread: thread.map(({ id, text, mediaIds }) => ({
            mediaIds,
            text,
            id,
          })),
        },
      },
      schemaVersion: 1,
    };
    expect(hashOf(forward)).toBe(hashOf(backward));
    expect(hashOf(forward)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when the thread order changes', () => {
    expect(hashOf({ schemaVersion: 1, copy: { global: { thread } } })).not.toBe(
      hashOf({
        schemaVersion: 1,
        copy: { global: { thread: [...thread].reverse() } },
      })
    );
  });

  it('changes the hash when the media order changes', () => {
    const swapped = [{ ...thread[0], mediaIds: ['m2', 'm1'] }, thread[1]];
    expect(hashOf({ schemaVersion: 1, copy: { global: { thread } } })).not.toBe(
      hashOf({ schemaVersion: 1, copy: { global: { thread: swapped } } })
    );
  });
});
