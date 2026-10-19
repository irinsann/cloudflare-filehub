import { tr } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import {
  Upload,
  Copy,
  Link2,
  ImagePlus,
  RotateCcw,
  Trash2,
  Eye,
  Download,
  List,
  LayoutGrid,
  RefreshCw,
} from 'lucide-react';
import { api, send, copy, fileUrl, sizeLabel, dateLabel } from '../lib/api';
import { imageMarkdown, uploadHostedImage } from '../lib/image-upload';
import { loadImageGallery } from '../lib/image-gallery';
import { EmptyState } from '../components/EmptyState';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { ManualCopy } from '../components/ManualCopy';
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
type ImageView = 'list' | 'gallery';

function GalleryThumbnail({
  image,
  disabled,
  onPreview,
}: {
  image: Row;
  disabled: boolean;
  onPreview: () => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  return (
    <div className="image-gallery-thumbnail" aria-busy={state === 'loading'}>
      <button
        type="button"
        className="image-gallery-open"
        aria-label={tr('预览 ', 'Preview ') + image.name}
        disabled={disabled || state === 'error'}
        onClick={onPreview}
      >
        <img
          key={attempt}
          src={fileUrl(image.file_id, true)}
          alt={image.name}
          loading="eager"
          decoding="async"
          hidden={state === 'error'}
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
        />
      </button>
      {state === 'loading' && (
        <span className="image-gallery-state">{tr('加载中…', 'Loading…')}</span>
      )}
      {state === 'error' && (
        <div className="image-gallery-state" role="alert">
          <span>{tr('图片加载失败', 'Could not load image')}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setState('loading');
              setAttempt((value) => value + 1);
            }}
          >
            {tr('重试', 'Retry')}
          </Button>
        </div>
      )}
    </div>
  );
}

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
    [loadError, setLoadError] = useState(''),
    [loadedCount, setLoadedCount] = useState(0),
    [view, setView] = useState<ImageView>('list'),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0),
    [operation, setOperation] = useState<{ name: string; action: ImageAction } | null>(null),
    [deleting, setDeleting] = useState<Row | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [previewLoading, setPreviewLoading] = useState(false),
    [previewError, setPreviewError] = useState(false),
    [manualCopy, setManualCopy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listingRequest = useRef<AbortController | null>(null);
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
    listingRequest.current = controller;
    setLoading(true);
    setLoadError('');
    setLoadedCount(0);
    setRows([]);
    async function loadImages() {
      try {
        if (view === 'list') {
          const next = await api<Row[]>('/images?page=' + page, { signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!next.length && page > 1) setPage((n) => n - 1);
          else setRows(next);
        } else {
          const all = await loadImageGallery<Row>(controller.signal, setLoadedCount);
          if (!controller.signal.aborted) setRows(all);
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setLoadError(
            cause instanceof Error ? cause.message : tr('读取图片失败', 'Could not load images'),
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadImages();
    return () => controller.abort();
  }, [page, revision, view]);
  function changeView(next: ImageView) {
    if (next === view) return;
    listingRequest.current?.abort();
    setRows([]);
    setLoading(true);
    setLoadError('');
    setView(next);
  }
  function refreshImages() {
    listingRequest.current?.abort();
    setLoading(true);
    setRevision((value) => value + 1);
  }
  async function upload(files: File[]) {
    if (!settings || locked.current || !files.length) return;
    locked.current = true;
    setBusy(true);
    setError('');
    let changed = false;
    try {
      for (const file of files) {
        try {
          const r = await uploadHostedImage(file, (percent) => {
            if (mounted.current)
              setStatus(
                file.name +
                  ' · ' +
                  (percent === null ? tr('生成直链', 'Create direct link') : percent + '%'),
              );
          });
          if (!mounted.current) break;
          if (r.cleanupWarning) setError(r.cleanupWarning);
          setStatus(r.name + tr(' · 已上传', ' · Uploaded'));
          changed = true;
        } catch (e) {
          if (!mounted.current) break;
          setError(
            file.name + '：' + (e instanceof Error ? e.message : tr('上传失败', 'Upload failed')),
          );
        }
      }
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : tr('上传失败', 'Upload failed'));
    } finally {
      locked.current = false;
      if (mounted.current) {
        setBusy(false);
        if (changed) {
          setPage(1);
          refreshImages();
        }
      }
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
      if (action === 'permanent' && preview?.name === r.name) setPreview(null);
      if (action !== 'permanent') {
        setRows((current) =>
          current.map((row) =>
            row.name === r.name ? { ...row, enabled: action === 'restore' ? 1 : 0 } : row,
          ),
        );
      } else if (view === 'gallery') {
        setRows((current) => current.filter((row) => row.name !== r.name));
      } else if (rows.length === 1 && page > 1) {
        setPage((n) => n - 1);
      } else {
        refreshImages();
      }
      notify(
        action === 'permanent'
          ? tr('图片已彻底删除', 'Image permanently deleted')
          : action === 'restore'
            ? tr('直链已恢复', 'Direct link restored')
            : tr('直链已撤销', 'Direct link revoked'),
      );
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : tr('操作失败', 'Action failed'));
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
      .then(() => notify(tr('已复制', 'Copied')))
      .catch(() => {
        if (mounted.current) setManualCopy(value);
      });
  function openPreview(row: Row) {
    setPreviewLoading(true);
    setPreviewError(false);
    setPreview(row);
  }
  function imageActions(row: Row) {
    return (
      <div className="image-host-actions">
        <Button size="sm" variant="ghost" disabled={working} onClick={() => openPreview(row)}>
          <Eye size={14} />
          {tr('预览', 'Preview')}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={'/api/admin/images/' + encodeURIComponent(row.name) + '/download'}>
            <Download size={14} />
            {tr('下载', 'Download')}
          </a>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copied(publicLink(row.url))}>
          <Link2 size={14} />
          {tr('直链', 'Direct link')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => copied(imageMarkdown(tr('图片', 'Image'), publicLink(row.url)))}
        >
          <Copy size={14} />
          Markdown
        </Button>
        {row.enabled ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={working}
            onClick={() => void changeImage(row, 'revoke')}
          >
            {operation?.name === row.name ? tr('撤销中…', 'Revoking…') : tr('撤销', 'Revoke')}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={working}
              onClick={() => void changeImage(row, 'restore')}
            >
              <RotateCcw size={14} />
              {operation?.name === row.name && operation.action === 'restore'
                ? tr('恢复中…', 'Restoring…')
                : tr('恢复直链', 'Restore link')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="danger-text"
              disabled={working}
              onClick={() => {
                setError('');
                setDeleting(row);
              }}
            >
              <Trash2 size={14} />
              {tr('彻底删除', 'Delete permanently')}
            </Button>
          </>
        )}
      </div>
    );
  }
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
        <strong>{tr('上传图片', 'Upload images')}</strong>
        <Button disabled={working || !settings} onClick={() => input.current?.click()}>
          <Upload size={16} />
          {busy ? tr('上传中…', 'Uploading…') : tr('选择图片', 'Choose images')}
        </Button>
        <small>
          {tr('PNG / JPEG / GIF / WebP · 剩余', 'PNG / JPEG / GIF / WebP · Available ')}{' '}
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
      <div className="public-links-toolbar image-host-toolbar">
        <LinkOriginSelect />
        <div className="image-host-view-tools">
          <div
            className="image-host-view-switch"
            role="group"
            aria-label={tr('图片显示方式', 'Image display')}
          >
            <Button
              variant={view === 'list' ? 'outline' : 'ghost'}
              size="sm"
              aria-label={tr('列表视图', 'List view')}
              title={tr('列表视图', 'List view')}
              aria-pressed={view === 'list'}
              disabled={working}
              onClick={() => changeView('list')}
            >
              <List size={18} />
              {tr('列表', 'List')}
            </Button>
            <Button
              variant={view === 'gallery' ? 'outline' : 'ghost'}
              size="sm"
              aria-label={tr('画廊视图', 'Gallery view')}
              title={tr('画廊视图', 'Gallery view')}
              aria-pressed={view === 'gallery'}
              disabled={working}
              onClick={() => changeView('gallery')}
            >
              <LayoutGrid size={18} />
              {tr('画廊', 'Gallery')}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={tr('刷新图片', 'Refresh images')}
            title={tr('刷新图片', 'Refresh images')}
            disabled={working || loading}
            onClick={refreshImages}
          >
            <RefreshCw size={17} />
          </Button>
        </div>
      </div>
      {loading ? (
        <div className="skeleton-list" aria-label={tr('加载图片', 'Loading images')}>
          {view === 'gallery' && (
            <p className="muted" role="status">
              {tr('正在读取全部图片', 'Loading all images')}
              {loadedCount > 0 ? tr(' · {0} 张', ' · {0} images', { '0': loadedCount }) : '…'}
            </p>
          )}
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : loadError ? (
        <div className="error-banner" role="alert">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={refreshImages}>
            {tr('重试', 'Retry')}
          </Button>
        </div>
      ) : rows.length > 0 && view === 'gallery' ? (
        <div className="image-gallery" aria-label={tr('图床画廊', 'Image gallery')}>
          {rows.map((row) => (
            <article
              className="image-gallery-card"
              key={row.name}
              aria-busy={operation?.name === row.name}
            >
              <GalleryThumbnail
                key={row.file_id}
                image={row}
                disabled={working}
                onPreview={() => openPreview(row)}
              />
              <div className="image-gallery-info">
                <button
                  type="button"
                  className="image-gallery-name"
                  title={row.name}
                  disabled={working}
                  onClick={() => openPreview(row)}
                >
                  {row.name}
                </button>
                <div className="image-gallery-meta">
                  <span>{sizeLabel(row.size)}</span>
                  <span className={row.enabled ? 'image-gallery-public' : undefined}>
                    {row.enabled ? tr('公开', 'Public') : tr('已撤销', 'Revoked')}
                  </span>
                  <time dateTime={new Date(row.created_at).toISOString()}>
                    {dateLabel(row.created_at)}
                  </time>
                </div>
                <div className="image-gallery-stats">
                  <span>
                    <Eye size={14} />
                    {tr('引用', 'Views')}
                    {row.views ?? 0}
                  </span>
                  <span>
                    <Download size={14} />
                    {tr('下载', 'Download')}
                    {row.downloads ?? 0}
                  </span>
                </div>
                {imageActions(row)}
              </div>
            </article>
          ))}
        </div>
      ) : rows.length > 0 ? (
        <div className="image-host-list">
          <table aria-label={tr('图床图片', 'Hosted images')}>
            <thead>
              <tr>
                <th scope="col">{tr('名称', 'Name')}</th>
                <th scope="col">{tr('大小', 'Size')}</th>
                <th scope="col">{tr('状态', 'Status')}</th>
                <th scope="col">{tr('上传时间', 'Uploaded')}</th>
                <th scope="col">{tr('引用', 'Views')}</th>
                <th scope="col">{tr('下载', 'Download')}</th>
                <th scope="col">{tr('操作', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} aria-busy={operation?.name === r.name}>
                  <th scope="row" className="image-host-name">
                    <span title={r.name}>{r.name}</span>
                  </th>
                  <td className="image-host-meta">{sizeLabel(r.size)}</td>
                  <td className="image-host-meta">
                    {r.enabled ? tr('公开', 'Public') : tr('已撤销', 'Revoked')}
                  </td>
                  <td className="image-host-meta">
                    <time dateTime={new Date(r.created_at).toISOString()}>
                      {dateLabel(r.created_at)}
                    </time>
                  </td>
                  <td className="image-host-meta">
                    <span className="image-host-mobile-label" aria-hidden="true">
                      {tr('引用', 'Views')}{' '}
                    </span>
                    {r.views ?? 0}
                  </td>
                  <td className="image-host-meta">
                    <span className="image-host-mobile-label" aria-hidden="true">
                      {tr('下载', 'Download')}{' '}
                    </span>
                    {r.downloads ?? 0}
                  </td>
                  <td className="image-host-action-cell">{imageActions(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!loading && !rows.length && !error && !loadError && (
        <EmptyState label={tr('暂无图片', 'No images yet')} />
      )}
      {view === 'list' && !loadError && (page > 1 || rows.length >= 40) && (
        <div className="image-pagination">
          <Button
            variant="outline"
            disabled={page === 1 || working || loading}
            onClick={() => setPage((n) => n - 1)}
          >
            {tr('上一页', 'Previous')}
          </Button>
          <span>{page}</span>
          <Button
            variant="outline"
            disabled={rows.length < 40 || working || loading}
            onClick={() => setPage((n) => n + 1)}
          >
            {tr('下一页', 'Next')}
          </Button>
        </div>
      )}
      {manualCopy !== null && <ManualCopy value={manualCopy} onClose={() => setManualCopy(null)} />}
      {preview && (
        <Modal
          title={tr('图片预览', 'Image preview')}
          description={preview.name}
          onClose={() => setPreview(null)}
          wide
        >
          {previewLoading && (
            <p role="status" className="muted">
              {tr('加载中…', 'Loading…')}
            </p>
          )}
          {previewError ? (
            <div role="alert" className="error-banner">
              <span>{tr('图片加载失败', 'Could not load image')}</span>
              <Button variant="outline" size="sm" onClick={() => openPreview(preview)}>
                {tr('重试', 'Retry')}
              </Button>
            </div>
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
          title={tr('彻底删除图片', 'Delete image permanently')}
          description={tr(
            '图片文件也将删除，引用它的文章将无法显示此图片。此操作无法撤销。',
            'The image file will be deleted. Articles using it will show a broken image. This cannot be undone.',
          )}
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
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={working}
              onClick={() => void changeImage(deleting, 'permanent')}
            >
              {working ? tr('删除中…', 'Deleting…') : tr('彻底删除', 'Delete permanently')}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
