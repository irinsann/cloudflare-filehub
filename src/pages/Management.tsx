import { useEffect, useState } from 'react';
import { ExternalLink, FileText, Link2, ShieldCheck } from 'lucide-react';
import { api, send, dateLabel } from '../lib/api';
import { Button } from '../components/ui/button';
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
    void (
      view === 'shares'
        ? api<(ShareRecord & { password_protected: number })[]>('/shares').then(setShares)
        : api<DocumentRow[]>('/markdown').then(setDocs)
    )
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
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
          <h3>身份与访问</h3>
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
          <p>当前身份：{settings?.email ?? '正在读取'}</p>
          <p>环境：{settings?.environment ?? '—'}</p>
          <p className="muted">
            {settings?.authMode === 'password_totp'
              ? '使用密码与验证器验证码登录，会话有效期为 24 小时。'
              : '后台仅允许配置的管理员身份登录。'}
          </p>
        </section>
        <section className="settings-card">
          <FileText />
          <h3>存储与发布</h3>
          <p>单文件上限：{settings ? `${settings.maxUploadBytes / 1048576} MB` : '—'}</p>
          <p>文本编辑上限：{settings ? `${settings.maxTextBytes / 1048576} MB` : '—'}</p>
          <p className="muted">文件保存在私有 R2，元数据保存在 D1。环境参数在部署配置中修改。</p>
        </section>
        <section className="settings-card">
          <Link2 />
          <h3>公开域名</h3>
          <p>文件：{settings?.filesOrigin || '当前域名 /s/:token'}</p>
          <p>文章：{settings?.markdownOrigin || '当前域名 /p/:slug'}</p>
          <p className="muted">
            分享列表最多显示最近 100 条。分享令牌只保存哈希，创建后请妥善保存完整链接。
          </p>
        </section>
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
          {!shares.length && (
            <Empty label="还没有文件分享" note="从文件菜单创建分享，你可以随时撤销访问。" />
          )}
        </div>
      ) : (
        <div className="management-list">
          {docs
            .filter((d) => d.published)
            .map((d) => {
              const url = `${settings?.markdownOrigin || location.origin}${settings?.markdownOrigin && settings.markdownOrigin !== location.origin ? '' : '/p'}/${d.slug}`;
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
          {!docs.some((d) => d.published) && (
            <Empty
              label="让想法拥有一个链接"
              note="新建 Markdown，写下内容，再发布为公开阅读网页。"
            />
          )}
        </div>
      )}
    </>
  );
}
export function Empty({ label, note }: { label: string; note: string }) {
  return (
    <div className="empty-state">
      <div className="empty-art">
        <FileText size={36} strokeWidth={1} />
      </div>
      <h3>{label}</h3>
      <p>{note}</p>
    </div>
  );
}
