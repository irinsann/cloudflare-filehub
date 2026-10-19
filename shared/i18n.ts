export type Locale = 'zh' | 'en';
export const normalizeLocale = (value: string | null | undefined): Locale =>
  value?.toLowerCase().startsWith('en') ? 'en' : 'zh';
export function translate(
  locale: Locale,
  text: { zh: string; en: string },
  params: Record<string, string | number> = {},
) {
  return text[locale].replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : match,
  );
}
export function formatDate(locale: Locale, timestamp: number) {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}
export function formatBytes(locale: Locale, bytes: number) {
  const index = bytes >= 1073741824 ? 3 : bytes >= 1048576 ? 2 : bytes >= 1024 ? 1 : 0;
  return (
    new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
      maximumFractionDigits: index ? 1 : 0,
      minimumFractionDigits: index ? 1 : 0,
    }).format(bytes / 1024 ** index) +
    ' ' +
    ['B', 'KB', 'MB', 'GB'][index]
  );
}
