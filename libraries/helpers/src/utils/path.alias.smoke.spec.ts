import * as viaAlias from '@gitroom/helpers/utils/has.extension';
import * as viaRelative from './has.extension';

// Proves the unit test setup maps tsconfig path aliases to the same module
// instance a relative import loads; it does not test the helper itself
describe('unit test setup (node)', () => {
  it('resolves @gitroom aliases to the source module', () => {
    expect(viaAlias).toBe(viaRelative);
  });
});
