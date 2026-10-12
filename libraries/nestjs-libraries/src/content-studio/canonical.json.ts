import { createHash } from 'crypto';

// Deterministic JSON for hashing immutable content. Object keys are sorted by
// UTF-16 code units (the default sort, the order RFC 8785 uses), arrays keep
// their order and strings are escaped by JSON.stringify. Only plain JSON data
// is accepted: whatever JSON.stringify would drop, coerce or hand to toJSON
// throws instead, so two different values can never serialize the same way

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  // objects on the current path only: a shared child is fine, a cycle is not
  const active = new WeakSet<object>();

  const write = (current: unknown): string => {
    if (current === null) {
      return 'null';
    }
    switch (typeof current) {
      case 'boolean':
        return current ? 'true' : 'false';
      case 'string':
        return JSON.stringify(current);
      case 'number':
        if (!Number.isSafeInteger(current)) {
          throw new CanonicalJsonError('Only safe integers are supported');
        }
        // -0 is written as 0, like JSON.stringify
        return String(current === 0 ? 0 : current);
      case 'object':
        break;
      default:
        throw new CanonicalJsonError(`Unsupported ${typeof current} value`);
    }

    const object = current as object;
    if (active.has(object)) {
      throw new CanonicalJsonError('Cyclic value');
    }
    active.add(object);
    try {
      if (Array.isArray(object)) {
        // holes read as undefined and are rejected like it
        return `[${Array.from(object, write).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError('Only plain objects are supported');
      }
      if (
        Object.getOwnPropertySymbols(object).some((symbol) =>
          Object.prototype.propertyIsEnumerable.call(object, symbol)
        )
      ) {
        throw new CanonicalJsonError('Symbol keys are not supported');
      }
      const record = object as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${write(record[key])}`)
        .join(',')}}`;
    } finally {
      active.delete(object);
    }
  };

  return write(value);
}

// Hashes exactly the given text (UTF-8). Takes a string only, so a caller
// has to canonicalize first instead of hashing some other serialization
export function sha256Hex(text: string): string {
  if (typeof text !== 'string') {
    throw new TypeError('sha256Hex hashes canonical JSON text only');
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
