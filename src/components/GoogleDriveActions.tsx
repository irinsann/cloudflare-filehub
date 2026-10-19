import { useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import {
  GOOGLE_DRIVE_FOLDER,
  type GoogleDriveFile,
  type GoogleDriveListing,
} from '../../shared/google-drive';
import { api } from '../lib/api';
import { driveWrite } from '../lib/google-drive-api';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { Select } from './ui/select';
export type DriveAction = {
  type: 'folder' | 'rename' | 'move' | 'trash' | 'restore' | 'delete' | 'export';
  file?: GoogleDriveFile;
  connectionId: string;
};
export const driveDownloadUrl = (file: GoogleDriveFile, format?: string) =>
  `/api/admin/google-drive/files/${encodeURIComponent(file.id)}/download${format ? '?format=' + encodeURIComponent(format) : ''}`;
export function googleFileLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['docs.google.com', 'drive.google.com'].includes(url.hostname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function GoogleDriveActions({
  action,
  parentId,
  connectionId,
  onClose,
  onDone,
}: {
  action: DriveAction;
  parentId: string;
  connectionId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(action.file?.name || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [destination, setDestination] = useState<GoogleDriveFile | null>(null),
    [crumbs, setCrumbs] = useState<GoogleDriveFile[]>([]);
  const [folders, setFolders] = useState<GoogleDriveFile[]>([]),
    [loading, setLoading] = useState(action.type === 'move'),
    [pages, setPages] = useState<string[]>(['']),
    [page, setPage] = useState(0),
    [nextToken, setNextToken] = useState<string>();
  const [format, setFormat] = useState(action.file?.exportFormats?.[0]?.id || '');
  useEffect(() => {
    if (action.type !== 'move') return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setFolders([]);
    setNextToken(undefined);
    const query = new URLSearchParams({ parent: destination?.id || 'root' });
    if (pages[page]) query.set('page_token', pages[page]);
    void api<GoogleDriveListing>('/google-drive/files?' + query, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setFolders(
            result.files.filter(
              (file) => file.mimeType === GOOGLE_DRIVE_FOLDER && file.id !== action.file?.id,
            ),
          );
          setNextToken(result.nextPageToken);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '读取文件夹失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [action.type, action.file?.id, destination?.id, page, pages]);
  function go(index: number, folder?: GoogleDriveFile) {
    setDestination(folder || null);
    setCrumbs(folder ? crumbs.slice(0, index + 1) : []);
    setPages(['']);
    setPage(0);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (action.type === 'export') return;
    setBusy(true);
    setError('');
    try {
      const path = '/files/' + encodeURIComponent(action.file?.id || '');
      if (action.type === 'folder')
        await driveWrite('/folders', 'POST', connectionId, { name, parentId });
      if (action.type === 'rename') await driveWrite(path, 'PATCH', connectionId, { name });
      if (action.type === 'move')
        await driveWrite(path, 'PATCH', connectionId, { parentId: destination?.id || 'root' });
      if (action.type === 'trash' || action.type === 'restore')
        await driveWrite(path, 'PATCH', connectionId, { trashed: action.type === 'trash' });
      if (action.type === 'delete') await driveWrite(path, 'DELETE', connectionId);
      onDone();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  const titles = {
    folder: '新建文件夹',
    rename: '重命名',
    move: '移动到文件夹',
    trash: '移入 Google 回收站',
    restore: '恢复文件',
    delete: '永久删除',
    export: '导出文件',
  };
  return (
    <Modal
      title={titles[action.type]}
      description={action.file?.name}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        {['folder', 'rename'].includes(action.type) && (
          <label>
            名称
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={255}
            />
          </label>
        )}
        {action.type === 'move' && (
          <>
            <nav className="move-path" aria-label="目标文件夹">
              <button type="button" onClick={() => go(-1)}>
                我的云端硬盘
              </button>
              {crumbs.map((folder, index) => (
                <button type="button" key={folder.id} onClick={() => go(index, folder)}>
                  / {folder.name}
                </button>
              ))}
            </nav>
            <div className="folder-picker">
              {loading ? (
                <p role="status">加载中…</p>
              ) : folders.length ? (
                folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => {
                      setDestination(folder);
                      setCrumbs([...crumbs, folder]);
                      setPages(['']);
                      setPage(0);
                    }}
                  >
                    <Folder size={17} />
                    {folder.name}
                    <ChevronRight size={15} />
                  </button>
                ))
              ) : (
                <p>当前页没有子文件夹</p>
              )}
            </div>
            <div className="drive-picker-pagination">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={loading || page === 0}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>
              <span>{page + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={loading || !nextToken}
                onClick={() => {
                  setPages([...pages.slice(0, page + 1), nextToken!]);
                  setPage(page + 1);
                }}
              >
                下一页
              </Button>
            </div>
            <p>目标：{destination?.name || '我的云端硬盘'}</p>
          </>
        )}
        {action.type === 'trash' && <p>将此项目移入 Google Drive 回收站？</p>}
        {action.type === 'restore' && <p>恢复此项目？</p>}
        {action.type === 'delete' && <p>永久删除此项目？此操作无法恢复。</p>}
        {action.type === 'export' && (
          <label>
            导出格式
            <Select
              value={format}
              onValueChange={setFormat}
              aria-label="导出格式"
              options={(action.file?.exportFormats || []).map((item) => ({
                value: item.id,
                label: item.label,
              }))}
            />
          </label>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          {action.type === 'export' ? (
            <Button asChild disabled={!format}>
              <a href={driveDownloadUrl(action.file!, format)}>下载</a>
            </Button>
          ) : (
            <Button
              disabled={
                busy ||
                (action.type === 'move' &&
                  (loading ||
                    !!error ||
                    (destination !== null && destination.capabilities?.canAddChildren !== true)))
              }
              variant={action.type === 'delete' ? 'danger' : 'default'}
            >
              {busy ? '处理中…' : '确认'}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
