import { useEffect, useSyncExternalStore } from 'react';
import { normalizeLocale, translate, type Locale } from '../../shared/i18n';
let locale: Locale = 'zh';
let preference: string | null = null;
try {
  preference = localStorage.getItem('rcloud-locale');
} catch {
  /* Storage is optional. */
}
try {
  preference ||= /(?:^|;\s*)rcloud-locale=(zh|en)(?:;|$)/.exec(document.cookie)?.[1] || null;
} catch {
  /* Cookies are optional. */
}
locale = normalizeLocale(
  preference ||
    (typeof document !== 'undefined' && typeof navigator !== 'undefined'
      ? navigator.language
      : 'zh'),
);
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export function setLocale(value: Locale) {
  locale = value;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en';
    document.title = value === 'zh' ? 'RCloud · 私人云盘' : 'RCloud · Private drive';
  }
  try {
    localStorage.setItem('rcloud-locale', value);
  } catch {
    /* Storage is optional. */
  }
  try {
    document.cookie = `rcloud-locale=${value}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === 'https:' ? '; Secure' : ''}`;
  } catch {
    /* The current tab still switches. */
  }
  for (const listener of listeners) listener();
}
export function useLocale() {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLocale,
    () => 'zh' as Locale,
  );
  useEffect(() => {
    document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
    document.title = current === 'zh' ? 'RCloud · 私人云盘' : 'RCloud · Private drive';
  }, [current]);
  return { locale: current, setLocale };
}
export const tr = (zh: string, en: string, params?: Record<string, string | number>) =>
  translate(locale, { zh, en }, params);
