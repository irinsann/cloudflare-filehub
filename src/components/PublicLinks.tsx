import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Settings } from '../../shared/types';
import {
  normalizePublicOrigin,
  preferredPublicOrigin,
  publicLinkOptions,
  rewritePublicLink,
  type PublicLinkOption,
} from '../lib/public-links';

const storageKey = 'rcloud-public-link-origin';
interface PublicLinksContextValue {
  options: PublicLinkOption[];
  origin: string;
  setOrigin: (origin: string) => void;
  link: (url: string) => string;
}
const PublicLinksContext = createContext<PublicLinksContextValue | null>(null);

function readPreference() {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}
function savePreference(origin: string) {
  try {
    localStorage.setItem(storageKey, origin);
  } catch {
    // The current session still uses the selected origin when browser storage is unavailable.
  }
}

export function PublicLinksProvider({
  settings,
  children,
}: {
  settings: Settings | null;
  children: ReactNode;
}) {
  const [preferred, setPreferred] = useState(readPreference);
  const currentOrigin = typeof location === 'undefined' ? '' : location.origin;
  const options = useMemo(
    () => publicLinkOptions(settings, currentOrigin),
    [settings, currentOrigin],
  );
  const trustedOrigins = useMemo(
    () =>
      [settings?.adminOrigin, settings?.markdownOrigin, settings?.filesOrigin, currentOrigin]
        .map(normalizePublicOrigin)
        .filter((value): value is string => value !== null),
    [settings, currentOrigin],
  );
  const origin = preferredPublicOrigin(options, preferred);
  const ready = settings !== null;
  useEffect(() => {
    // Wait for configured origins before discarding a saved preference during initial loading.
    if (!ready || !origin) return;
    if (preferred !== origin) setPreferred(origin);
    savePreference(origin);
  }, [ready, origin, preferred]);
  const setOrigin = useCallback(
    (next: string) => {
      const normalized = normalizePublicOrigin(next);
      if (!normalized || !options.some((option) => option.origin === normalized)) return;
      setPreferred(normalized);
      savePreference(normalized);
    },
    [options],
  );
  const link = useCallback(
    (url: string) => rewritePublicLink(url, origin, trustedOrigins),
    [origin, trustedOrigins],
  );
  const value = useMemo(
    () => ({ options, origin, setOrigin, link }),
    [options, origin, setOrigin, link],
  );
  return <PublicLinksContext.Provider value={value}>{children}</PublicLinksContext.Provider>;
}

export function usePublicLinks() {
  const context = useContext(PublicLinksContext);
  if (!context) throw new Error('usePublicLinks must be used within PublicLinksProvider');
  return context;
}

export function LinkOriginSelect({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { options, origin, setOrigin } = usePublicLinks();
  if (!options.length) return null;
  return (
    <label
      className={['public-link-origin', compact && 'public-link-origin-compact', className]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={compact ? 'sr-only' : undefined}>链接域名</span>
      <select value={origin} onChange={(event) => setOrigin(event.target.value)}>
        {options.map((option) => (
          <option key={option.origin} value={option.origin}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
