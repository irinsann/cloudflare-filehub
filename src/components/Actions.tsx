import { useEffect, useState, type FormEvent } from 'react';
import type { FileRecord, FolderRecord } from '../../shared/types';
import { Modal } from './ui/dialog';
import { Button } from './ui/button';
import { apiPage, copy, send } from '../lib/api';
import { LinkOriginSelect, usePublicLinks } from './PublicLinks';
import { Select } from './ui/select';
import type { SiteShareListItem } from '../../shared/site-shares';
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
    | 'direct'
    | 'site';
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
  const { link: publicLink } = usePublicLinks();
  const [name, setName] = useState(
    action.file?.name ?? action.folder?.name ?? (action.type === 'markdown' ? '未命名.md' : ''),
  );
  const [password, setPassword] = useState(''),
    [siteDays, setSiteDays] = useState('0'),
    [expires, setExpires] = useState(''),
    [download, setDownload] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [link, setLink] = useState('');
  const [destination, setDestination] = useState<string | null>(null),
    [folders, setFolders] = useState<FolderRecord[]>([]),
    [folderPage, setFolderPage] = useState(1),
    [folderTotal, setFolderTotal] = useState(0),
    [foldersLoading, setFoldersLoading] = useState(action.type === 'move'),
    [path, setPath] = useState<FolderRecord[]>([]);
  const selectedLink = publicLink(link);
  useEffect(() => {
    if (action.type !== 'move') return;
    const controller = new AbortController();
    setFolders([]);
    setFoldersLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(folderPage), limit: '40' });
    if (destination) params.set('parent_id', destination);
    void apiPage<FolderRecord>(`/folders?${params}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) {
          const lastPage = Math.max(1, Math.ceil(next.total / next.limit));
          if (folderPage > lastPage) setFolderPage(lastPage);
          else {
            setFolders(next.data);
            setFolderTotal(next.total);
          }
        }
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
  }, [action.type, destination, folderPage]);
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
    site: '发布 HTML 网站',
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
      if (action.type === 'site') {
        const result = await send<SiteShareListItem>('/site-shares', 'POST', {
          folder_id: folder!.id,
          password: password || undefined,
          expires_in_days: Number(siteDays) || null,
        });
        setLink(result.url);
        onDone();
        notify('网站已发布');
        return;
      }
      if (action.type === 'share' || action.type === 'direct') {
        const result = await send<{ url: string; directUrl: string }>('/shares', 'POST', {
          file_id: file!.id,
          password: action.type === 'direct' ? undefined : password || undefined,
          expires_at: expires ? new Date(expires).getTime() : null,
          allow_download: action.type === 'direct' || download,
        });
        setLink(action.type === 'direct' ? result.directUrl : result.url);
        onDone();
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
                  setFolderPage(1);
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
                    setFolderPage(1);
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
                    setFolderPage(1);
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
            {(folderPage > 1 || folderTotal > 40) && (
              <div className="dialog-footer" aria-label="文件夹分页">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={foldersLoading || folderPage <= 1}
                  onClick={() => setFolderPage(folderPage - 1)}
                >
                  上一页
                </Button>
                <span>{folderPage}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={foldersLoading || folderPage * 40 >= folderTotal}
                  onClick={() => setFolderPage(folderPage + 1)}
                >
                  下一页
                </Button>
              </div>
            )}
            <p className="muted">目标：{path.at(-1)?.name ?? '根目录'}</p>
          </>
        )}
        {(action.type === 'share' || action.type === 'direct' || action.type === 'site') &&
          !link && (
            <>
              {action.type === 'site' && <p>以 index.html 为入口，资源使用相对路径。</p>}
              {(action.type === 'share' || action.type === 'site') && (
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
              {action.type === 'site' ? (
                <label>
                  有效期
                  <Select
                    aria-label="网站有效期"
                    value={siteDays}
                    onValueChange={setSiteDays}
                    options={[
                      { value: '0', label: '永久有效' },
                      { value: '1', label: '1 天' },
                      { value: '7', label: '7 天' },
                      { value: '30', label: '30 天' },
                      { value: '365', label: '1 年' },
                    ]}
                  />
                </label>
              ) : (
                <label>
                  过期时间（留空永久有效）
                  <input
                    type="datetime-local"
                    value={expires}
                    onChange={(e) => setExpires(e.target.value)}
                  />
                </label>
              )}
              {action.type === 'site' && <LinkOriginSelect />}
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
            <LinkOriginSelect />
            <label>
              {action.type === 'direct' ? '文件直链' : '公开链接'}
              <input readOnly value={selectedLink} onFocus={(e) => e.target.select()} />
            </label>
            <div className="dialog-footer">
              <Button
                type="button"
                onClick={() =>
                  void copy(selectedLink)
                    .then(() => notify('链接已复制'))
                    .catch(() => setError('无法访问剪贴板，请手动复制'))
                }
              >
                复制链接
              </Button>
              <Button asChild variant="outline">
                <a href={selectedLink} target="_blank" rel="noreferrer">
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
                : action.type === 'share' || action.type === 'direct' || action.type === 'site'
                  ? '生成链接'
                  : '确认'}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
