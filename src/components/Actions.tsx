import { useEffect, useState, type FormEvent } from 'react';
import type { FileRecord, FolderRecord } from '../../shared/types';
import { Modal } from './ui/dialog';
import { Button } from './ui/button';
import { api, copy, send } from '../lib/api';
export type Action = {
  type:
    | 'folder'
    | 'markdown'
    | 'rename'
    | 'move'
    | 'share'
    | 'delete'
    | 'purge'
    | 'emptyTrash'
    | 'direct';
  file?: FileRecord;
  folder?: FolderRecord;
};
export function Actions({
  action,
  currentFolder,
  onClose,
  onDone,
  notify,
}: {
  action: Action;
  currentFolder: string | null;
  onClose: () => void;
  onDone: (id?: string) => void;
  notify: (message: string) => void;
}) {
  const [name, setName] = useState(
    action.file?.name ?? action.folder?.name ?? (action.type === 'markdown' ? '未命名.md' : ''),
  );
  const [password, setPassword] = useState(''),
    [expires, setExpires] = useState(''),
    [download, setDownload] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [link, setLink] = useState('');
  const [destination, setDestination] = useState<string | null>(null),
    [folders, setFolders] = useState<FolderRecord[]>([]),
    [foldersLoading, setFoldersLoading] = useState(action.type === 'move'),
    [path, setPath] = useState<FolderRecord[]>([]);
  useEffect(() => {
    if (action.type !== 'move') return;
    const controller = new AbortController();
    setFolders([]);
    setFoldersLoading(true);
    setError('');
    void api<FolderRecord[]>(`/folders${destination ? `?parent_id=${destination}` : ''}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setFolders(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '读取文件夹失败');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFoldersLoading(false);
      });
    return () => controller.abort();
  }, [action.type, destination]);
  const titles = {
    folder: '新建文件夹',
    markdown: '新建 Markdown',
    rename: '重命名',
    move: '移动到文件夹',
    share: '创建公开分享',
    delete: '移入回收站',
    purge: '永久删除',
    emptyTrash: '清空回收站',
    direct: '生成文件直链',
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const file = action.file,
        folder = action.folder;
      let id: string | undefined;
      if (action.type === 'folder')
        await send('/folders', 'POST', { name, parent_id: currentFolder });
      if (action.type === 'markdown') {
        const result = await send<FileRecord>('/markdown', 'POST', {
          name,
          folder_id: currentFolder,
        });
        id = result.id;
      }
      if (action.type === 'rename')
        await send(file ? `/files/${file.id}` : `/folders/${folder!.id}`, 'PATCH', { name });
      if (action.type === 'move')
        await send(
          file ? `/files/${file.id}` : `/folders/${folder!.id}`,
          'PATCH',
          file ? { folder_id: destination } : { parent_id: destination },
        );
      if (action.type === 'delete' || action.type === 'purge')
        await send(
          `${file ? '/files/' + file.id : '/folders/' + folder!.id}${action.type === 'purge' ? '/permanent' : ''}`,
          'DELETE',
        );
      if (action.type === 'emptyTrash') await send('/trash', 'DELETE');
      if (action.type === 'share' || action.type === 'direct') {
        const result = await send<{ url: string; directUrl: string }>('/shares', 'POST', {
          file_id: file!.id,
          password: action.type === 'direct' ? undefined : password || undefined,
          expires_at: expires ? new Date(expires).getTime() : null,
          allow_download: action.type === 'direct' || download,
        });
        setLink(action.type === 'direct' ? result.directUrl : result.url);
        notify(action.type === 'direct' ? '文件直链已创建' : '分享已创建');
        return;
      }
      onDone(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={titles[action.type]}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={(e) => void submit(e)} className="form-stack">
        {['folder', 'markdown', 'rename'].includes(action.type) && (
          <label>
            名称
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={180}
              required
            />
          </label>
        )}
        {action.type === 'move' && (
          <>
            <div className="move-path">
              <button
                type="button"
                onClick={() => {
                  setDestination(null);
                  setPath([]);
                }}
              >
                根目录
              </button>
              {path.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setDestination(f.id);
                    setPath(path.slice(0, i + 1));
                  }}
                >
                  / {f.name}
                </button>
              ))}
            </div>
            <div className="folder-picker">
              {folders.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  onClick={() => {
                    setDestination(f.id);
                    setPath([...path, f]);
                  }}
                >
                  📁 {f.name} →
                </button>
              ))}
              {foldersLoading ? (
                <p className="muted" role="status">
                  加载中…
                </p>
              ) : !folders.length && !error ? (
                <p className="muted">当前文件夹没有子目录</p>
              ) : null}
            </div>
            <p className="muted">目标：{path.at(-1)?.name ?? '根目录'}</p>
          </>
        )}
        {(action.type === 'share' || action.type === 'direct') && !link && (
          <>
            {action.type === 'share' && (
              <label>
                访问密码（可选）
                <input
                  type="password"
                  value={password}
                  maxLength={128}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}
            <label>
              过期时间（留空永久有效）
              <input
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </label>
            {action.type === 'share' && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={download}
                  onChange={(e) => setDownload(e.target.checked)}
                />
                允许下载
              </label>
            )}
          </>
        )}
        {action.type === 'emptyTrash' && <p>清空回收站？此操作无法恢复。</p>}
        {link && (
          <>
            <label>
              {action.type === 'direct' ? '文件直链' : '公开链接'}
              <input readOnly value={link} onFocus={(e) => e.target.select()} />
            </label>
            <div className="dialog-footer">
              <Button
                type="button"
                onClick={() =>
                  void copy(link)
                    .then(() => notify('链接已复制'))
                    .catch(() => setError('无法访问剪贴板，请手动复制'))
                }
              >
                复制链接
              </Button>
              <Button asChild variant="outline">
                <a href={link} target="_blank" rel="noreferrer">
                  {action.type === 'direct' ? '下载文件' : '打开分享'}
                </a>
              </Button>
            </div>
          </>
        )}
        {(action.type === 'delete' || action.type === 'purge') && (
          <p>
            确定{action.type === 'purge' ? '永久删除' : '移入回收站'}「
            {action.file?.name ?? action.folder?.name}」？
            {action.type === 'purge' ? '此操作无法恢复。' : ''}
          </p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {!link && (
          <div className="dialog-footer">
            <Button variant="outline" type="button" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              variant={
                action.type === 'purge' || action.type === 'emptyTrash' ? 'danger' : 'default'
              }
              disabled={busy}
            >
              {busy
                ? '处理中…'
                : action.type === 'share' || action.type === 'direct'
                  ? '生成链接'
                  : '确认'}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
