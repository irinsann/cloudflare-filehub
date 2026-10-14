import { useEffect, useRef, useState } from 'react';
import { Upload, Copy, Link2, ImagePlus } from 'lucide-react';
import { api, send, copy, fileUrl, sizeLabel } from '../lib/api';
import { uploadFile } from '../lib/upload';
import { Empty } from './Management';
import { Button } from '../components/ui/button';
import type { FileRecord, Settings } from '../../shared/types';
interface Row {
  name: string;
  file_id: string;
  size: number;
  enabled: number;
  url: string;
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
  const [rows, setRows] = useState<Row[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<Row[]>('/images?page=' + page, { signal: controller.signal })
      .then(setRows)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, revision]);
  async function upload(files: File[]) {
    if (!settings || busy) return;
    setBusy(true);
    setError('');
    try {
      const folder = await send<{ id: string }>('/images/folder', 'POST');
      for (const file of files) {
        if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(file.name)) {
          setError('仅支持 PNG、JPEG、GIF 和 WebP 图片');
          continue;
        }
        if (!file.size) {
          setError(file.name + ' 是空文件');
          continue;
        }
        let uploaded: FileRecord | undefined;
        try {
          uploaded = await uploadFile(file, folder.id, (percent) =>
            setStatus(file.name + ' · ' + percent + '%'),
          );
          setStatus(file.name + ' · 生成直链');
          const r = await send<{ name: string; file_id: string; url: string; duplicate: boolean }>(
            '/images',
            'POST',
            { file_id: uploaded.id },
          );
          if (r.duplicate && r.file_id !== uploaded.id) {
            await send('/files/' + uploaded.id, 'DELETE');
            await send('/files/' + uploaded.id + '/permanent', 'DELETE');
          }
          setStatus(r.name + ' · 已上传');
          setRevision((n) => n + 1);
        } catch (e) {
          setError(file.name + '：' + (e instanceof Error ? e.message : '上传失败'));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setBusy(false);
      onComplete();
    }
  }
  async function revoke(r: Row) {
    try {
      await send('/images/' + r.name, 'DELETE');
      setRevision((n) => n + 1);
      notify('直链已撤销');
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销失败');
    }
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
        <Button disabled={busy || !settings} onClick={() => input.current?.click()}>
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
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {loading ? (
        <div className="skeleton-list" aria-label="加载图片">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : (
        <div className="image-host-grid">
          {rows.map((r) => (
            <article className="image-host-card" key={r.name}>
              <a href={fileUrl(r.file_id, true)} target="_blank" rel="noreferrer">
                <img loading="lazy" src={fileUrl(r.file_id, true)} alt={r.name} />
              </a>
              <div>
                <strong title={r.name}>{r.name}</strong>
                <small>
                  {sizeLabel(r.size)} · {r.enabled ? '公开' : '已撤销'}
                </small>
                <input
                  readOnly
                  value={r.url}
                  aria-label="图片直链"
                  onFocus={(e) => e.target.select()}
                />
                <div className="image-host-actions">
                  <Button size="sm" variant="outline" onClick={() => copied(r.url)}>
                    <Link2 size={14} />
                    直链
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copied('![图片](' + r.url + ')')}
                  >
                    <Copy size={14} />
                    Markdown
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!r.enabled}
                    onClick={() => void revoke(r)}
                  >
                    撤销
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !rows.length && !error && <Empty label="暂无图片" />}
      <div className="image-pagination">
        <Button variant="outline" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>
          上一页
        </Button>
        <span>{page}</span>
        <Button variant="outline" disabled={rows.length < 40} onClick={() => setPage((n) => n + 1)}>
          下一页
        </Button>
      </div>
    </section>
  );
}
