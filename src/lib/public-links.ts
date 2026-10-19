import { tr } from './i18n';
export interface PublicLinkOption {
  origin: string;
  host: string;
  label: string;
  kind: 'global' | 'hong-kong';
}

interface OriginSettings {
  adminOrigin?: string;
  markdownOrigin?: string;
  filesOrigin?: string;
}

export function normalizePublicOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value.trim())) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.href !== parsed.origin + '/'
    )
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function publicLinkOptions(
  settings: OriginSettings | null,
  currentOrigin: string,
): PublicLinkOption[] {
  const global =
    normalizePublicOrigin(settings?.adminOrigin) ??
    normalizePublicOrigin(settings?.markdownOrigin) ??
    normalizePublicOrigin(currentOrigin);
  const hongKong = normalizePublicOrigin(settings?.filesOrigin);
  const options: PublicLinkOption[] = [];
  if (global) {
    const host = new URL(global).host;
    options.push({
      origin: global,
      host,
      label: tr('全球 CDN · ', 'Global CDN · ') + host,
      kind: 'global',
    });
  }
  if (hongKong && hongKong !== global) {
    const host = new URL(hongKong).host;
    options.push({
      origin: hongKong,
      host,
      label: tr('香港反代 · ', 'Hong Kong proxy · ') + host,
      kind: 'hong-kong',
    });
  }
  return options;
}

export function preferredPublicOrigin(
  options: readonly PublicLinkOption[],
  saved: unknown,
): string {
  const preferred = normalizePublicOrigin(saved);
  if (preferred && options.some((option) => option.origin === preferred)) return preferred;
  return options.find((option) => option.kind === 'hong-kong')?.origin ?? options[0]?.origin ?? '';
}

export function rewritePublicLink(
  url: string,
  origin: string,
  trustedOrigins: readonly string[],
): string {
  const target = normalizePublicOrigin(origin);
  const trusted = new Set(trustedOrigins.map(normalizePublicOrigin).filter(Boolean));
  if (!target || !trusted.has(target) || !/^https?:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !trusted.has(parsed.origin)) return url;
    // The serialized suffix retains encoded paths, queries, fragments and empty ?/# delimiters.
    return target + parsed.href.slice(parsed.origin.length);
  } catch {
    return url;
  }
}
