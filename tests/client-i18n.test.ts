import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocale, setLocale, tr } from '../src/lib/i18n';
import { sections } from '../src/lib/navigation';
import { publicLinkOptions } from '../src/lib/public-links';
import { api, dateLabel, sizeLabel } from '../src/lib/api';
import { formatDate, normalizeLocale, translate } from '../shared/i18n';

afterEach(() => {
  setLocale('zh');
  vi.unstubAllGlobals();
});
describe('client language preferences', () => {
  it('switches existing navigation, domain options and formatters without a reload', () => {
    const navigation = sections;
    setLocale('en');
    expect(navigation[0].label).toBe('My files');
    expect(
      publicLinkOptions(
        { adminOrigin: 'https://233334.xyz', filesOrigin: 'https://s.irin.im' },
        '',
      ).map((item) => item.label),
    ).toEqual(['Global CDN · 233334.xyz', 'Hong Kong proxy · s.irin.im']);
    expect(dateLabel(1720000000000)).toBe(formatDate('en', 1720000000000));
    expect(sizeLabel(1536)).toBe('1.5 KB');
    setLocale('zh');
    expect(navigation[0].label).toBe('我的文件');
    expect(publicLinkOptions({ filesOrigin: 'https://s.irin.im' }, '').at(-1)?.label).toBe(
      '香港反代 · s.irin.im',
    );
  });
  it('saves a shared cookie and storage preference while keeping user content literal', () => {
    const storage = { setItem: vi.fn() },
      document = { documentElement: { lang: '' }, cookie: '' };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('document', document);
    vi.stubGlobal('location', { protocol: 'https:' });
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(storage.setItem).toHaveBeenCalledWith('rcloud-locale', 'en');
    expect(document.cookie).toContain(
      'rcloud-locale=en; Path=/; SameSite=Lax; Max-Age=31536000; Secure',
    );
    expect(tr('文件：{name}', 'File: {name}', { name: '中文{token}.html' })).toBe(
      'File: 中文{token}.html',
    );
    expect(translate('en', { zh: '{name}', en: '{name}' }, { name: '<script>' })).toBe('<script>');
  });
  it('keeps switching when browser preference storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      setItem() {
        throw new Error('Blocked');
      },
    });
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(tr('重试', 'Retry')).toBe('Retry');
  });
  it('sends the active UI language with API calls', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    setLocale('en');
    await api('/settings');
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).get('Accept-Language')).toBe('en');
    expect(new Headers(options.headers).get('X-Drive-Request')).toBe('1');
  });
  it('normalizes language hints deterministically', () => {
    expect(normalizeLocale('en-US,en;q=0.8')).toBe('en');
    expect(normalizeLocale('zh-TW')).toBe('zh');
    expect(normalizeLocale(null)).toBe('zh');
  });
});
