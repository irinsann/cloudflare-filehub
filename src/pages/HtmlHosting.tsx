import { tr } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { Upload, FileCode2, Copy, ExternalLink, RotateCcw, Eye, Link2, X } from 'lucide-react';
import type { HtmlHostingItem } from '../../shared/html-hosting';
import type { useHtmlUploads } from '../hooks/useHtmlUploads';
import { apiPage, copy, send, dateLabel, sizeLabel } from '../lib/api';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { EmptyState } from '../components/EmptyState';
import { ManualCopy } from '../components/ManualCopy';
import { LinkOriginSelect, usePublicLinks } from '../components/PublicLinks';
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
    [refresh, setRefresh] = useState(0),
    [drag, setDrag] = useState(false);
  const [manual, setManual] = useState(''),
    [action, setAction] = useState<HtmlHostingItem | null>(null),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    dragDepth = useRef(0);
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
    <div className="hosting-page">
      <section
        className={`hosting-drop ${drag ? 'is-dragging' : ''}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('Files')) {
            event.preventDefault();
            dragDepth.current++;
            setDrag(true);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDrag(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDrag(false);
          uploads.add(Array.from(event.dataTransfer.files));
        }}
      >
        <span className="hosting-emblem">
          <FileCode2 size={30} />
        </span>
        <div>
          <h2>{tr('上传 HTML', 'Upload HTML')}</h2>
          <p>
            {tr(
              '拖入 HTML 文件，或选择多个文件上传。',
              'Drop HTML files here or choose files to upload.',
            )}
          </p>
        </div>
        <Button onClick={() => input.current?.click()}>
          <Upload size={17} />
          {tr('选择 HTML', 'Choose HTML files')}
        </Button>
        <input
          type="file"
          accept=".html,.htm,text/html"
          multiple
          hidden
          ref={input}
          onChange={(event) => {
            uploads.add(Array.from(event.target.files || []));
            event.target.value = '';
          }}
        />
      </section>
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
      <section className="management-list">
        <div className="file-toolbar">
          <div className="hosting-list-title">
            <Link2 size={17} />
            <strong>{tr('HTML 文件', 'HTML files')}</strong>
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
          rows.map((row) => {
            const expired = row.expires_at !== null && row.expires_at <= Date.now();
            const available = row.enabled && !expired;
            return (
              <article className="management-row" key={row.file_id}>
                <div className="type-icon">
                  <FileCode2 />
                </div>
                <div className="management-info">
                  <strong>{row.name}</strong>
                  <p>
                    {sizeLabel(row.size)} · {dateLabel(row.created_at)} ·{' '}
                    {!row.enabled
                      ? tr('已撤销', 'Revoked')
                      : expired
                        ? tr('已过期', 'Expired')
                        : row.password_protected
                          ? tr('密码保护', 'Password protected')
                          : tr('已分享', 'Shared')}{' '}
                    · <Eye size={12} /> {row.views}
                  </p>
                </div>
                <div className="management-actions">
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
          })
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
