import { useEffect, useRef, useState } from 'react';
import { Upload, Copy, Link2, ImagePlus, RotateCcw, Trash2, Eye, Download } from 'lucide-react';
import { api, send, copy, fileUrl, sizeLabel, dateLabel } from '../lib/api';
import { imageMarkdown, uploadHostedImage } from '../lib/image-upload';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { LinkOriginSelect, usePublicLinks } from '../components/PublicLinks';
import type { Settings } from '../../shared/types';
interface Row {
  name: string;
  file_id: string;
  size: number;
  enabled: number;
  created_at: number;
  views: number;
  downloads: number;
  last_access_at: number | null;
  url: string;
}
type ImageAction = 'revoke' | 'restore' | 'permanent';
export function ImageHosting({
  settings,
  notify,
  onComplete,
}: {
  settings: Settings | null;
  notify: (s: string) => void;
  onComplete: () => void;
}) {
  const { link: publicLink } = usePublicLinks();
  const [rows, setRows] = useState<Row[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [operation, setOperation] = useState<{ name: string; action: ImageAction } | null>(null),
    [deleting, setDeleting] = useState<Row | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [previewLoading, setPreviewLoading] = useState(false),
    [previewError, setPreviewError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const working = busy || operation !== null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<Row[]>('/images?page=' + page, { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return;
        if (!next.length && page > 1) setPage((n) => n - 1);
        else setRows(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, revision]);
  async function upload(files: File[]) {
    if (!settings || locked.current || !files.length) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      for (const file of files) {
        try {
          const r = await uploadHostedImage(file, (percent) => {
            if (mounted.current)
              setStatus(file.name + ' · ' + (percent === null ? '生成直链' : percent + '%'));
          });
          if (!mounted.current) break;
          if (r.cleanupWarning) setError(r.cleanupWarning);
          setStatus(r.name + ' · 已上传');
          setRevision((n) => n + 1);
        } catch (e) {
          if (!mounted.current) break;
          setError(file.name + '：' + (e instanceof Error ? e.message : '上传失败'));
        }
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
      onComplete();
    }
  }
  async function changeImage(r: Row, action: ImageAction) {
    if (locked.current) return;
    locked.current = true;
    setOperation({ name: r.name, action });
    setError('');
    setStatus('');
    try {
      await send(
        '/images/' + encodeURIComponent(r.name) + (action === 'revoke' ? '' : '/' + action),
        action === 'restore' ? 'POST' : 'DELETE',
      );
      onComplete();
      if (!mounted.current) return;
      setDeleting(null);
      if (action === 'permanent' && rows.length === 1 && page > 1) setPage((n) => n - 1);
      else setRevision((n) => n + 1);
      notify(
        action === 'permanent'
          ? '图片已彻底删除'
          : action === 'restore'
            ? '直链已恢复'
            : '直链已撤销',
      );
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      locked.current = false;
      if (mounted.current) setOperation(null);
    }
  }
  function closeDelete() {
    if (locked.current) return;
    setDeleting(null);
    setError('');
  }
  const copied = (value: string) =>
    void copy(value)
      .then(() => notify('已复制'))
      .catch(() => notify('复制失败，请手动复制'));
  return (
    <section>
      <div
        className="image-host-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        <ImagePlus size={28} />
        <strong>上传图片</strong>
        <Button disabled={working || !settings} onClick={() => input.current?.click()}>
          <Upload size={16} />
          {busy ? '上传中…' : '选择图片'}
        </Button>
        <small>
          PNG / JPEG / GIF / WebP · 剩余{' '}
          {settings ? sizeLabel(settings.storageAvailableBytes) : '—'}
        </small>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => {
            void upload(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
      </div>
      {status && (
        <p role="status" className="muted">
          {status}
        </p>
      )}
      {error && !deleting && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="public-links-toolbar">
        <LinkOriginSelect />
      </div>
      {loading ? (
        <div className="skeleton-list" aria-label="加载图片">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : rows.length > 0 ? (
        <div className="image-host-list">
          <table aria-label="图床图片">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">大小</th>
                <th scope="col">状态</th>
                <th scope="col">上传时间</th>
                <th scope="col">引用</th>
                <th scope="col">下载</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} aria-busy={operation?.name === r.name}>
                  <th scope="row" className="image-host-name">
                    <span title={r.name}>{r.name}</span>
                  </th>
                  <td className="image-host-meta">{sizeLabel(r.size)}</td>
                  <td className="image-host-meta">{r.enabled ? '公开' : '已撤销'}</td>
                  <td className="image-host-meta">
                    <time dateTime={new Date(r.created_at).toISOString()}>
                      {dateLabel(r.created_at)}
                    </time>
                  </td>
                  <td className="image-host-meta">
                    <span className="image-host-mobile-label" aria-hidden="true">
                      引用{' '}
                    </span>
                    {r.views ?? 0}
                  </td>
                  <td className="image-host-meta">
                    <span className="image-host-mobile-label" aria-hidden="true">
                      下载{' '}
                    </span>
                    {r.downloads ?? 0}
                  </td>
                  <td className="image-host-action-cell">
                    <div className="image-host-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={working}
                        onClick={() => {
                          setPreviewLoading(true);
                          setPreviewError(false);
                          setPreview(r);
                        }}
                      >
                        <Eye size={14} />
                        预览
                      </Button>
                      <Button size="sm" variant="ghost" asChild>
                        <a href={'/api/admin/images/' + encodeURIComponent(r.name) + '/download'}>
                          <Download size={14} />
                          下载
                        </a>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => copied(publicLink(r.url))}>
                        <Link2 size={14} />
                        直链
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copied(imageMarkdown('图片', publicLink(r.url)))}
                      >
                        <Copy size={14} />
                        Markdown
                      </Button>
                      {r.enabled ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={working}
                          onClick={() => void changeImage(r, 'revoke')}
                        >
                          {operation?.name === r.name ? '撤销中…' : '撤销'}
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working}
                            onClick={() => void changeImage(r, 'restore')}
                          >
                            <RotateCcw size={14} />
                            {operation?.name === r.name && operation.action === 'restore'
                              ? '恢复中…'
                              : '恢复直链'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="danger-text"
                            disabled={working}
                            onClick={() => {
                              setError('');
                              setDeleting(r);
                            }}
                          >
                            <Trash2 size={14} />
                            彻底删除
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!loading && !rows.length && !error && <EmptyState label="暂无图片" />}
      {(page > 1 || rows.length >= 40) && (
        <div className="image-pagination">
          <Button
            variant="outline"
            disabled={page === 1 || working || loading}
            onClick={() => setPage((n) => n - 1)}
          >
            上一页
          </Button>
          <span>{page}</span>
          <Button
            variant="outline"
            disabled={rows.length < 40 || working || loading}
            onClick={() => setPage((n) => n + 1)}
          >
            下一页
          </Button>
        </div>
      )}
      {preview && (
        <Modal title="图片预览" description={preview.name} onClose={() => setPreview(null)} wide>
          {previewLoading && (
            <p role="status" className="muted">
              加载中…
            </p>
          )}
          {previewError ? (
            <p role="alert" className="error-text">
              图片加载失败，请稍后重试。
            </p>
          ) : (
            <img
              className="image-host-preview"
              src={fileUrl(preview.file_id, true)}
              alt={preview.name}
              onLoad={() => setPreviewLoading(false)}
              onError={() => {
                setPreviewLoading(false);
                setPreviewError(true);
              }}
            />
          )}
        </Modal>
      )}
      {deleting && (
        <Modal
          title="彻底删除图片"
          description="图片文件也将删除，引用它的文章将无法显示此图片。此操作无法撤销。"
          onClose={closeDelete}
        >
          <p className="image-delete-name">{deleting.name}</p>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="dialog-footer">
            <Button variant="ghost" disabled={working} onClick={closeDelete}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={working}
              onClick={() => void changeImage(deleting, 'permanent')}
            >
              {working ? '删除中…' : '彻底删除'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
