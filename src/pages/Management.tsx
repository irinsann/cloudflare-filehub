import { tr, getLocale } from '../lib/i18n';
import { useEffect, useState } from 'react';
import {
  Copy,
  ExternalLink,
  FileText,
  Link2,
  ShieldCheck,
  Globe2,
  Eye,
  Download,
  LockKeyhole,
} from 'lucide-react';
import { apiPage, copy, send, dateLabel } from '../lib/api';
import { StorageMeter } from '../components/workspace/WorkspaceShell';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { ApiTokens } from '../components/ApiTokens';
import { WebDavSettings } from '../components/WebDavSettings';
import { EmptyState } from '../components/EmptyState';
import { LinkOriginSelect, usePublicLinks } from '../components/PublicLinks';
import type { Settings, ShareListItem } from '../../shared/types';
import type { SiteShareListItem } from '../../shared/site-shares';
type ShareKind = 'files' | 'sites';

function ShareDetails({
  enabled,
  expiresAt,
  passwordProtected,
  views,
  downloads,
}: {
  enabled: number | boolean;
  expiresAt: number | null;
  passwordProtected: number | boolean;
  views: number;
  downloads?: number;
}) {
  const expired = !!expiresAt && expiresAt <= Date.now();
  const available = !!enabled && !expired;
  return (
    <div className="share-details">
      <span className={`share-state${available ? '' : ' is-inactive'}`}>
        {!enabled
          ? tr('已撤销', 'Revoked')
          : expired
            ? tr('已过期', 'Expired')
            : expiresAt
              ? tr('有效至 {0}', 'Expires {0}', { '0': dateLabel(expiresAt) })
              : tr('永久有效', 'No expiry')}
      </span>
      {available && (
        <span className="share-access">
          {passwordProtected ? (
            <LockKeyhole size={13} aria-hidden="true" />
          ) : (
            <Link2 size={13} aria-hidden="true" />
          )}
          {passwordProtected
            ? tr('密码保护', 'Password protected')
            : tr('持链接访问', 'Link access')}
        </span>
      )}
      <span className="share-stats">
        <span>
          <Eye size={14} aria-hidden="true" />
          <span>{tr('访问 {0}', '{0} views', { '0': views.toLocaleString(getLocale()) })}</span>
        </span>
        {downloads !== undefined && (
          <span>
            <Download size={14} aria-hidden="true" />
            <span>
              {tr('下载 {0}', '{0} downloads', { '0': downloads.toLocaleString(getLocale()) })}
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

interface DocumentRow {
  id: string;
  name: string;
  title: string | null;
  slug: string | null;
  published: number | null;
  published_at: number | null;
  published_version: number | null;
  version: number;
  views: number | null;
}
export function Management({
  view,
  refresh,
  settings,
  onEdit,
  notify,
}: {
  view: 'published' | 'shares' | 'settings';
  refresh: number;
  settings: Settings | null;
  onEdit: (id: string) => void;
  notify: (s: string) => void;
}) {
  const publicLinks = usePublicLinks();
  const [shares, setShares] = useState<ShareListItem[]>([]),
    [sites, setSites] = useState<SiteShareListItem[]>([]),
    [shareKind, setShareKind] = useState<ShareKind>('files'),
    [docs, setDocs] = useState<DocumentRow[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [pagination, setPagination] = useState({ view, page: 1 }),
    [total, setTotal] = useState(0);
  const page = pagination.view === view ? pagination.page : 1;
  const pageSize = 40;
  const [manualCopy, setManualCopy] = useState<{ url: string; name: string } | null>(null);
  function selectShareKind(value: ShareKind) {
    setShareKind(value);
    setPagination({ view, page: 1 });
  }
  useEffect(() => {
    setLoading(true);
    setError('');
    if (view === 'settings') {
      setLoading(false);
      return;
    }
    setShares([]);
    setSites([]);
    setDocs([]);
    setTotal(0);
    const controller = new AbortController();
    async function load() {
      const options = { signal: controller.signal };
      const params = `page=${page}&limit=${pageSize}`;
      const result =
        view === 'shares'
          ? shareKind === 'sites'
            ? await apiPage<SiteShareListItem>('/site-shares?' + params, options)
            : await apiPage<ShareListItem>('/shares?' + params, options)
          : await apiPage<DocumentRow>('/markdown?published=1&' + params, options);
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
      if (page > lastPage) {
        setPagination({ view, page: lastPage });
        return;
      }
      setTotal(result.total);
      if (view === 'shares' && shareKind === 'sites') setSites(result.data as SiteShareListItem[]);
      else if (view === 'shares') setShares(result.data as ShareListItem[]);
      else setDocs(result.data as DocumentRow[]);
    }
    void load()
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [view, refresh, revision, page, shareKind]);
  function copyShareLink(url: string, name: string) {
    void copy(publicLinks.link(url))
      .then(() => notify(tr('链接已复制', 'Link copied')))
      .catch(() => setManualCopy({ url, name }));
  }
  async function revoke(id: string, article: boolean) {
    try {
      await send(
        article
          ? `/markdown/${id}/unpublish`
          : shareKind === 'sites'
            ? `/site-shares/${id}`
            : `/shares/${id}`,
        article ? 'POST' : 'DELETE',
      );
      setRevision((r) => r + 1);
      notify(article ? tr('已取消发布', 'Unpublished') : tr('已撤销分享', 'Share revoked'));
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('操作失败', 'Action failed'));
    }
  }
  if (view === 'settings')
    return (
      <div className="settings-grid">
        <section className="settings-card">
          <ShieldCheck />
          <h3>{tr('账号', 'Account')}</h3>
          {settings?.authMode === 'password_totp' && (
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const r = await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'X-Drive-Request': '1', 'Accept-Language': getLocale() },
                  });
                  if (!r.ok) throw Error(tr('退出失败', 'Could not sign out'));
                  location.assign('/login');
                } catch {
                  notify(tr('退出失败，请稍后重试', 'Could not sign out. Try again shortly.'));
                }
              }}
            >
              {tr('退出登录', 'Sign out')}
            </Button>
          )}
          <p className="account-email">{settings?.email ?? tr('正在读取', 'Loading')}</p>
        </section>
        <section className="settings-card">
          <FileText />
          <h3>{tr('存储', 'Storage')}</h3>
          <StorageMeter settings={settings} />
          <p>
            {tr('文本编辑上限：', 'Text editing limit: ')}
            {settings ? `${settings.maxTextBytes / 1048576} MB` : '—'}
          </p>
        </section>
        <ApiTokens notify={notify} uploadOrigin={settings?.filesOrigin || location.origin} />
        <WebDavSettings notify={notify} />
      </div>
    );
  return (
    <>
      {view === 'shares' && (
        <div className="share-kind-toolbar">
          <div className="share-kind-tabs" role="tablist" aria-label={tr('分享类型', 'Share type')}>
            {(
              [
                { value: 'files', label: tr('链接', 'Links'), icon: Link2 },
                { value: 'sites', label: tr('网页', 'Websites'), icon: Globe2 },
              ] as const
            ).map(({ value, label, icon: Icon }, index) => (
              <button
                key={value}
                type="button"
                id={`share-tab-${value}`}
                role="tab"
                aria-controls="share-content"
                aria-selected={shareKind === value}
                tabIndex={shareKind === value ? 0 : -1}
                onClick={() => selectShareKind(value)}
                onKeyDown={(event) => {
                  const nextIndex =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? 1
                        : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
                          ? 1 - index
                          : null;
                  if (nextIndex === null) return;
                  event.preventDefault();
                  selectShareKind(nextIndex === 0 ? 'files' : 'sites');
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [nextIndex]?.focus();
                }}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <LinkOriginSelect compact />
        </div>
      )}
      <div
        id={view === 'shares' ? 'share-content' : undefined}
        className={view === 'shares' ? 'share-content' : undefined}
        role={view === 'shares' ? 'tabpanel' : undefined}
        aria-labelledby={view === 'shares' ? `share-tab-${shareKind}` : undefined}
        aria-busy={loading}
        tabIndex={view === 'shares' ? 0 : undefined}
      >
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {loading ? (
          <div className="skeleton-list">
            {[1, 2, 3].map((n) => (
              <div className="skeleton" key={n} />
            ))}
          </div>
        ) : view === 'shares' && shareKind === 'sites' ? (
          <div className="management-list share-list">
            {sites.map((site) => {
              const expired = !!site.expires_at && site.expires_at <= Date.now();
              const available = site.enabled && !expired;
              return (
                <article key={site.id} className="management-row share-row share-row-site">
                  <div className="type-icon">
                    <Globe2 />
                  </div>
                  <div className="management-info">
                    <strong>{site.name}</strong>
                    <ShareDetails
                      enabled={site.enabled}
                      expiresAt={site.expires_at}
                      passwordProtected={site.password_protected}
                      views={site.views}
                    />
                  </div>
                  <div className="management-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!available}
                      onClick={() => copyShareLink(site.url, site.name)}
                    >
                      <Copy size={15} />
                      {tr('复制链接', 'Copy link')}
                    </Button>
                    {available && (
                      <Button variant="ghost" size="sm" asChild>
                        <a href={publicLinks.link(site.url)} target="_blank" rel="noreferrer">
                          <ExternalLink size={15} />
                          {tr('打开网站', 'Open website')}
                        </a>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="share-revoke"
                      size="sm"
                      disabled={!site.enabled}
                      onClick={() => void revoke(site.id, false)}
                    >
                      {tr('撤销分享', 'Revoke share')}
                    </Button>
                  </div>
                </article>
              );
            })}
            {!sites.length && <EmptyState label={tr('暂无网页分享', 'No shared websites')} />}
          </div>
        ) : view === 'shares' ? (
          <div className="management-list share-list">
            {shares.map((s) => {
              const expired = !!s.expires_at && s.expires_at <= Date.now();
              const available = !!s.enabled && !expired;
              return (
                <article key={s.id} className="management-row share-row">
                  <div className="type-icon">
                    <Link2 />
                  </div>
                  <div className="management-info">
                    <strong>{s.name}</strong>
                    <ShareDetails
                      enabled={s.enabled}
                      expiresAt={s.expires_at}
                      passwordProtected={s.password_protected}
                      views={s.views}
                      downloads={s.downloads}
                    />
                  </div>
                  <div className="management-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!available}
                      onClick={() => copyShareLink(s.url, s.name)}
                    >
                      <Copy size={15} />
                      {tr('复制链接', 'Copy link')}
                    </Button>
                    {!!s.allow_download && !s.password_protected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!available}
                        onClick={() => copyShareLink(s.directUrl, s.name)}
                      >
                        {tr('复制直链', 'Copy direct link')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="share-revoke"
                      size="sm"
                      disabled={!s.enabled}
                      onClick={() => void revoke(s.id, false)}
                    >
                      {tr('撤销分享', 'Revoke share')}
                    </Button>
                  </div>
                </article>
              );
            })}
            {!shares.length && <EmptyState label={tr('暂无分享链接', 'No shared links')} />}
          </div>
        ) : (
          <div className="management-list">
            <div className="file-toolbar">
              <LinkOriginSelect compact />
            </div>
            {docs
              .filter((d) => d.published)
              .map((d) => {
                const url = publicLinks.link(
                  `${settings?.markdownOrigin || location.origin}/p/${d.slug}`,
                );
                return (
                  <article key={d.id} className="management-row">
                    <div className="type-icon">
                      <FileText />
                    </div>
                    <div className="management-info">
                      <strong>{d.title ?? d.name}</strong>
                      <p>
                        /{d.slug} · {d.views ?? 0}
                        {tr('次阅读 · 已发布 v', ' views · Published v')}
                        {d.published_version}
                        {d.version !== d.published_version
                          ? tr(' · 有新草稿', ' · New draft available')
                          : ''}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={tr('复制文章链接', 'Copy article link')}
                      title={tr('复制文章链接', 'Copy article link')}
                      onClick={() =>
                        void copy(url)
                          .then(() => notify(tr('阅读链接已复制', 'Article link copied')))
                          .catch(() =>
                            setError(
                              tr(
                                '复制失败，请打开文章后复制地址',
                                'Could not copy. Open the article and copy its address.',
                              ),
                            ),
                          )
                      }
                    >
                      <Copy size={16} />
                    </Button>
                    <Button variant="ghost" size="icon" asChild>
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={tr('打开文章', 'Open article')}
                      >
                        <ExternalLink size={16} />
                      </a>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onEdit(d.id)}>
                      {tr('编辑', 'Edit')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void revoke(d.id, true)}>
                      {tr('取消发布', 'Unpublish')}
                    </Button>
                  </article>
                );
              })}
            {!docs.some((d) => d.published) && (
              <EmptyState label={tr('暂无已发布文章', 'No published articles')} />
            )}
          </div>
        )}
        {!loading && !error && total > pageSize && (
          <div className="file-footer">
            <span>
              {tr('共', 'Total ')}
              {total}
              {tr('项', ' items')}
            </span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPagination({ view, page: page - 1 })}
              >
                {tr('上一页', 'Previous')}
              </Button>
              <span>
                {page} / {Math.ceil(total / pageSize)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page * pageSize >= total}
                onClick={() => setPagination({ view, page: page + 1 })}
              >
                {tr('下一页', 'Next')}
              </Button>
            </div>
          </div>
        )}
      </div>
      {manualCopy && (
        <Modal
          title={tr('复制链接', 'Copy link')}
          description={manualCopy.name}
          onClose={() => setManualCopy(null)}
        >
          <div className="form-stack">
            <LinkOriginSelect />
            <label>
              {tr('链接', 'Link')}
              <input
                autoFocus
                readOnly
                value={publicLinks.link(manualCopy.url)}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <p role="status">
              {tr('无法访问剪贴板，请手动复制。', 'Clipboard unavailable. Copy manually.')}
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
