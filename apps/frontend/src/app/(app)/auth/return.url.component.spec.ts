import { createElement as h } from 'react';
import { cleanup, render, renderHook } from '@testing-library/react';
import ReturnUrlComponent, {
  useReturnUrl,
} from '@gitroom/frontend/app/(app)/auth/return.url.component';

let mockSearch = '';
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// After sign-in the layout sends the browser to the stored returnUrl, so it
// may only ever be an http(s) address on this app's own origin
const SAME_ORIGIN = `${window.location.origin}/oauth/authorize?client_id=c1`;
const REFUSED = [
  'https://evil.example.com/login',
  `https://evil.example.com/?next=${window.location.origin}`,
  'javascript:alert(document.cookie)//http',
  `//evil.example.com/${window.location.host}`,
  'data:text/html,<script>alert(1)</script>http',
  '/relative/http',
];

const store = (value: string) => {
  mockSearch = `returnUrl=${encodeURIComponent(value)}`;
  render(h(ReturnUrlComponent));
  return localStorage.getItem('returnUrl');
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  mockSearch = '';
});

describe('ReturnUrlComponent', () => {
  it('stores a returnUrl on this app', () => {
    expect(store(SAME_ORIGIN)).toBe(SAME_ORIGIN);
  });

  it.each(REFUSED)('never stores %s', (value) => {
    expect(store(value)).toBeNull();
  });
});

describe('useReturnUrl', () => {
  it('hands back a same-origin returnUrl once', () => {
    localStorage.setItem('returnUrl', SAME_ORIGIN);
    const { result } = renderHook(() => useReturnUrl());
    expect(result.current.getAndClear()).toBe(SAME_ORIGIN);
    expect(result.current.getAndClear()).toBeNull();
  });

  it.each(REFUSED)(
    'drops %s that was stored before the check, and clears it',
    (value) => {
      localStorage.setItem('returnUrl', value);
      const { result } = renderHook(() => useReturnUrl());
      expect(result.current.getAndClear()).toBeNull();
      expect(localStorage.getItem('returnUrl')).toBeNull();
    }
  );
});
