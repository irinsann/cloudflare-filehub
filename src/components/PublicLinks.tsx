import { tr } from '../lib/i18n';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, Globe2, Server } from 'lucide-react';
import type { Settings } from '../../shared/types';
import { useLocale } from '../lib/i18n';
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
  const { locale } = useLocale();
  const currentOrigin = typeof location === 'undefined' ? '' : location.origin;
  const options = useMemo(
    () => publicLinkOptions(settings, currentOrigin),
    [settings, currentOrigin, locale],
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
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [feedback, setFeedback] = useState<{
    origin: string;
    label: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 1800);
    return () => clearTimeout(timer);
  }, [feedback]);
  function choose(option: PublicLinkOption) {
    const label = option.origin === origin ? tr('已选中', 'Selected') : tr('已切换', 'Switched');
    setOrigin(option.origin);
    setFeedback({ origin: option.origin, label, message: `${label}：${option.label}` });
  }
  if (!options.length) return null;
  return (
    <div
      className={['public-link-origin', compact && 'public-link-origin-compact', className]
        .filter(Boolean)
        .join(' ')}
    >
      {!compact && <span className="public-link-caption">{tr('链接域名', 'Link domain')}</span>}
      <div
        className="public-link-switch"
        role="radiogroup"
        aria-label={tr('链接域名', 'Link domain')}
      >
        {options.map((option, index) => {
          const selected = option.origin === origin;
          const confirmed = selected && feedback?.origin === option.origin;
          const Icon = option.kind === 'global' ? Globe2 : Server;
          return (
            <button
              key={option.origin}
              ref={(node) => {
                if (node) buttons.current.set(option.origin, node);
                else buttons.current.delete(option.origin);
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              tabIndex={selected ? 0 : -1}
              className={['public-link-option', confirmed && 'public-link-option-confirmed']
                .filter(Boolean)
                .join(' ')}
              onClick={() => choose(option)}
              onKeyDown={(event) => {
                let next: number;
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
                  next = (index + 1) % options.length;
                else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
                  next = (index - 1 + options.length) % options.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = options.length - 1;
                else return;
                event.preventDefault();
                choose(options[next]);
                buttons.current.get(options[next].origin)?.focus();
              }}
            >
              <span className="public-link-option-icon" aria-hidden="true">
                <Icon size={17} />
              </span>
              <span className="public-link-option-copy" aria-hidden="true">
                <strong>
                  {option.kind === 'global'
                    ? tr('全球 CDN', 'Global CDN')
                    : tr('香港反代', 'Hong Kong proxy')}
                </strong>
                <small className={confirmed ? 'public-link-confirmation' : undefined}>
                  {confirmed ? feedback.label : option.host}
                </small>
              </span>
              <span className="public-link-check" aria-hidden="true">
                <Check size={12} strokeWidth={3} />
              </span>
            </button>
          );
        })}
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {feedback?.message ?? ''}
      </span>
    </div>
  );
}
