import { tr } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { UploadCloud, FileCode2, Copy, ExternalLink, RotateCcw, Eye, Link2, X } from 'lucide-react';
import type { HtmlHostingItem } from '../../shared/html-hosting';
import type { useHtmlUploads } from '../hooks/useHtmlUploads';
import { apiPage, copy, send, dateLabel, sizeLabel } from '../lib/api';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { EmptyState } from '../components/EmptyState';
import { ManualCopy } from '../components/ManualCopy';
import { LinkOriginSelect, usePublicLinks } from '../components/PublicLinks';
import { HostingDropZone } from '../components/HostingDropZone';
import { useHostingDrop } from '../hooks/useHostingDrop';
export function HtmlHosting({
  uploads,
  revision,
  notify,
}: {
  uploads: ReturnType<typeof useHtmlUploads>;
  revision: number;
  notify: (message: string) => void;
}) {
  const { link } = usePublicLinks();
  const [rows, setRows] = useState<HtmlHostingItem[]>([]),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [manual, setManual] = useState(''),
    [action, setAction] = useState<HtmlHostingItem | null>(null),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const dropDisabled = busy || uploads.busy || !!action || !!manual;
  const drop = useHostingDrop({
    disabled: dropDisabled,
    onFiles: uploads.add,
    onBlocked: () => notify(tr('请等待当前操作完成', 'Wait for the current action to finish')),
  });
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setRows([]);
    void apiPage<HtmlHostingItem>(`/html-hosting?page=${page}&limit=40`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const last = Math.max(1, Math.ceil(result.total / 40));
        if (page > last) {
          setPage(last);
          return;
        }
        setRows(result.data);
        setTotal(result.total);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : tr('加载失败', 'Could not load'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, revision, refresh]);
  async function copyLink(url: string) {
    const selected = link(url);
    try {
      await copy(selected);
      notify(tr('链接已复制', 'Link copied'));
    } catch {
      setManual(selected);
    }
  }
  async function update() {
    if (!action || busy) return;
    setBusy(true);
    setError('');
    try {
      await send(
        '/html-hosting/' + action.file_id + (action.enabled ? '' : '/restore'),
        action.enabled ? 'DELETE' : 'POST',
        { version: action.version },
      );
      setAction(null);
      setRefresh((value) => value + 1);
      notify(
        action.enabled ? tr('已撤销分享', 'Share revoked') : tr('已重新分享', 'Share restored'),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr('操作失败', 'Action failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`hosting-page html-hosting-page${drop.active ? ' is-dragging' : ''}`}
      {...drop.handlers}
    >
      <HostingDropZone
        kind="html"
        active={drop.active}
        busy={uploads.busy}
        disabled={dropDisabled}
        onChoose={() => input.current?.click()}
      />
      {drop.active && (
        <div className="hosting-drop-feedback" role="status">
          <UploadCloud size={18} />
          {tr('松开上传 HTML', 'Drop to upload HTML')}
        </div>
      )}
      <input
        type="file"
        accept=".html,.htm,text/html"
        multiple
        hidden
        ref={input}
        onChange={(event) => {
          if (!dropDisabled) uploads.add(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />
      {!!uploads.items.length && (
        <section className="hosting-tasks">
          <header>
            <strong>{tr('上传任务', 'Uploads')}</strong>
            <Button variant="ghost" size="sm" onClick={uploads.clear}>
              <X size={14} />
              {tr('清除已完成任务', 'Clear completed uploads')}
            </Button>
          </header>
          {uploads.items.map((item) => (
            <article key={item.id}>
              <div>
                <FileCode2 size={17} />
                <strong>{item.file.name}</strong>
                <span>{sizeLabel(item.file.size)}</span>
              </div>
              <progress
                max={100}
                value={item.progress}
                aria-label={tr('上传进度', 'Upload progress')}
              />
              <div className="hosting-task-status">
                <span role="status" className={item.state === 'error' ? 'error-text' : 'muted'}>
                  {item.error ||
                    {
                      queued: tr('等待上传', 'Queued'),
                      uploading: tr('正在上传', 'Uploading'),
                      publishing: tr('正在生成链接', 'Creating link'),
                      success: tr('已完成', 'Complete'),
                      error: tr('上传失败', 'Upload failed'),
                    }[item.state]}
                </span>
                {item.state === 'error' && !item.invalid && (
                  <Button size="sm" variant="outline" onClick={() => uploads.retry(item.id)}>
                    <RotateCcw size={14} />
                    {tr('重试', 'Retry')}
                  </Button>
                )}
                {item.state === 'error' && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tr('移除此任务', 'Dismiss this upload')}
                    onClick={() => uploads.dismiss(item.id)}
                  >
                    <X size={14} />
                  </Button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
      <section className="hosting-library">
        <div className="hosting-toolbar">
          <div className="hosting-list-title">
            <Link2 size={17} />
            <strong>{tr('已托管', 'Hosted')}</strong>
            <span>{total}</span>
          </div>
          <LinkOriginSelect compact />
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <Button variant="ghost" size="sm" onClick={() => setRefresh((value) => value + 1)}>
              {tr('重试', 'Retry')}
            </Button>
          </div>
        )}
        {loading ? (
          <div className="skeleton-list">
            {[1, 2, 3].map((value) => (
              <div key={value} className="skeleton" />
            ))}
          </div>
        ) : (
          <div className="hosting-cards">
            {rows.map((row) => {
              const expired = row.expires_at !== null && row.expires_at <= Date.now();
              const available = row.enabled && !expired;
              return (
                <article className="hosting-card hosting-html-card" key={row.file_id}>
                  <div className="hosting-card-icon" aria-hidden="true">
                    <FileCode2 size={22} strokeWidth={1.7} />
                  </div>
                  <div className="hosting-card-info">
                    <strong className="hosting-card-name">{row.name}</strong>
                    <div className="hosting-card-details">
                      <span className={`hosting-state${available ? '' : ' is-inactive'}`}>
                        {!row.enabled
                          ? tr('已撤销', 'Revoked')
                          : expired
                            ? tr('已过期', 'Expired')
                            : row.password_protected
                              ? tr('密码保护', 'Password protected')
                              : tr('已分享', 'Shared')}
                      </span>
                      <span>{sizeLabel(row.size)}</span>
                      <time dateTime={new Date(row.created_at).toISOString()}>
                        {dateLabel(row.created_at)}
                      </time>
                      <span className="hosting-card-stat">
                        <Eye size={13} />
                        {tr('访问', 'Views')} {row.views}
                      </span>
                    </div>
                  </div>
                  <div className="hosting-card-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!available}
                      onClick={() => void copyLink(row.url)}
                    >
                      <Copy size={14} />
                      {tr('复制链接', 'Copy link')}
                    </Button>
                    {available && (
                      <Button asChild size="sm" variant="ghost">
                        <a href={link(row.url)} target="_blank" rel="noreferrer">
                          <ExternalLink size={14} />
                          {tr('打开', 'Open')}
                        </a>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setError('');
                        setAction(row);
                      }}
                    >
                      {row.enabled ? tr('撤销', 'Revoke') : tr('重新分享', 'Share again')}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {!loading && !error && !rows.length && (
          <EmptyState label={tr('还没有 HTML 文件', 'No HTML files yet')} />
        )}
        {total > 40 && (
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
                disabled={loading || page === 1}
                onClick={() => setPage(page - 1)}
              >
                {tr('上一页', 'Previous')}
              </Button>
              <span>
                {page} / {Math.ceil(total / 40)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={loading || page * 40 >= total}
                onClick={() => setPage(page + 1)}
              >
                {tr('下一页', 'Next')}
              </Button>
            </div>
          </div>
        )}
      </section>
      {manual && <ManualCopy value={manual} onClose={() => setManual('')} />}
      {action && (
        <Modal
          title={action.enabled ? tr('撤销分享', 'Revoke share') : tr('重新分享', 'Share again')}
          description={action.name}
          onClose={() => {
            if (!busy) setAction(null);
          }}
        >
          <p>
            {action.enabled
              ? tr(
                  '撤销后，原链接将无法访问。文件会保留。',
                  'The link will stop working. Your file will be kept.',
                )
              : tr('重新启用原来的公开链接？', 'Enable the original public link again?')}
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-footer">
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void update()}>
              {busy ? tr('处理中…', 'Working…') : tr('确认', 'Confirm')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
