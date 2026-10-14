import { useEffect, useState } from 'react';
import { Copy, ExternalLink, FileText, Link2, ShieldCheck } from 'lucide-react';
import { api, copy, send, dateLabel } from '../lib/api';
import { StorageMeter } from '../components/workspace/WorkspaceShell';
import { Button } from '../components/ui/button';
import { ApiTokens } from '../components/ApiTokens';
import { EmptyState } from '../components/EmptyState';
import { LinkOriginSelect, usePublicLinks } from '../components/PublicLinks';
import type { Settings, ShareRecord } from '../../shared/types';
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
  const [shares, setShares] = useState<(ShareRecord & { password_protected: number })[]>([]),
    [docs, setDocs] = useState<DocumentRow[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    setLoading(true);
    setError('');
    if (view === 'settings') {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void (
      view === 'shares'
        ? api<(ShareRecord & { password_protected: number })[]>('/shares', {
            signal: controller.signal,
          }).then(setShares)
        : api<DocumentRow[]>('/markdown', { signal: controller.signal }).then(setDocs)
    )
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [view, refresh, revision]);
  async function revoke(id: string, article: boolean) {
    try {
      await send(
        article ? `/markdown/${id}/unpublish` : `/shares/${id}`,
        article ? 'POST' : 'DELETE',
      );
      setRevision((r) => r + 1);
      notify(article ? '已取消发布' : '已撤销分享');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }
  if (view === 'settings')
    return (
      <div className="settings-grid">
        <section className="settings-card">
          <ShieldCheck />
          <h3>账号</h3>
          {settings?.authMode === 'password_totp' && (
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const r = await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'X-Drive-Request': '1' },
                  });
                  if (!r.ok) throw Error('退出失败');
                  location.assign('/login');
                } catch {
                  notify('退出失败，请稍后重试');
                }
              }}
            >
              退出登录
            </Button>
          )}
          <p className="account-email">{settings?.email ?? '正在读取'}</p>
        </section>
        <section className="settings-card">
          <FileText />
          <h3>存储</h3>
          <StorageMeter settings={settings} />
          <p>文本编辑上限：{settings ? `${settings.maxTextBytes / 1048576} MB` : '—'}</p>
        </section>
        <ApiTokens notify={notify} uploadOrigin={settings?.filesOrigin || location.origin} />
      </div>
    );
  return (
    <>
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
      ) : view === 'shares' ? (
        <div className="management-list">
          {shares.map((s) => (
            <article key={s.id} className="management-row">
              <div className="type-icon">
                <Link2 />
              </div>
              <div className="management-info">
                <strong>{s.name}</strong>
                <p>
                  {!s.enabled
                    ? '已撤销'
                    : s.expires_at && s.expires_at < Date.now()
                      ? '已过期'
                      : s.expires_at
                        ? `有效至 ${dateLabel(s.expires_at)}`
                        : '永久有效'}{' '}
                  · {s.password_protected ? '密码保护' : '持链接可访问'} · 访问 {s.views} / 下载{' '}
                  {s.downloads}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!s.enabled}
                onClick={() => void revoke(s.id, false)}
              >
                撤销分享
              </Button>
            </article>
          ))}
          {!shares.length && <EmptyState label="暂无文件分享" />}
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
                      /{d.slug} · {d.views ?? 0} 次阅读 · 已发布 v{d.published_version}
                      {d.version !== d.published_version ? ' · 有新草稿' : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="复制文章链接"
                    title="复制文章链接"
                    onClick={() =>
                      void copy(url)
                        .then(() => notify('阅读链接已复制'))
                        .catch(() => setError('复制失败，请打开文章后复制地址'))
                    }
                  >
                    <Copy size={16} />
                  </Button>
                  <Button variant="ghost" size="icon" asChild>
                    <a href={url} target="_blank" rel="noreferrer" aria-label="打开文章">
                      <ExternalLink size={16} />
                    </a>
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onEdit(d.id)}>
                    编辑
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void revoke(d.id, true)}>
                    取消发布
                  </Button>
                </article>
              );
            })}
          {!docs.some((d) => d.published) && <EmptyState label="暂无已发布文章" />}
        </div>
      )}
    </>
  );
}
