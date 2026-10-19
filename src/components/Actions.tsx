import { tr } from '../lib/i18n';
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
    action.file?.name ??
      action.folder?.name ??
      (action.type === 'markdown' ? tr('未命名.md', 'Untitled.md') : ''),
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
          setError(
            cause instanceof Error ? cause.message : tr('读取文件夹失败', 'Could not load folders'),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFoldersLoading(false);
      });
    return () => controller.abort();
  }, [action.type, destination, folderPage]);
  const titles = {
    folder: tr('新建文件夹', 'New folder'),
    markdown: tr('新建 Markdown', 'New Markdown'),
    rename: tr('重命名', 'Rename'),
    move: tr('移动到文件夹', 'Move to folder'),
    share: tr('创建公开分享', 'Create public share'),
    delete: tr('移入回收站', 'Move to trash'),
    purge: tr('永久删除', 'Delete permanently'),
    emptyTrash: tr('清空回收站', 'Empty trash'),
    direct: tr('生成文件直链', 'Create direct link'),
    site: tr('发布 HTML 网站', 'Publish HTML website'),
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
        notify(tr('网站已发布', 'Website published'));
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
        notify(
          action.type === 'direct'
            ? tr('文件直链已创建', 'Direct link created')
            : tr('分享已创建', 'Share created'),
        );
        return;
      }
      onDone(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('操作失败', 'Action failed'));
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
            {tr('名称', 'Name')}
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
                {tr('根目录', 'Root')}
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
                  {tr('加载中…', 'Loading…')}
                </p>
              ) : !folders.length && !error ? (
                <p className="muted">{tr('当前文件夹没有子目录', 'No subfolders')}</p>
              ) : null}
            </div>
            {(folderPage > 1 || folderTotal > 40) && (
              <div className="dialog-footer" aria-label={tr('文件夹分页', 'Folder pages')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={foldersLoading || folderPage <= 1}
                  onClick={() => setFolderPage(folderPage - 1)}
                >
                  {tr('上一页', 'Previous')}
                </Button>
                <span>{folderPage}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={foldersLoading || folderPage * 40 >= folderTotal}
                  onClick={() => setFolderPage(folderPage + 1)}
                >
                  {tr('下一页', 'Next')}
                </Button>
              </div>
            )}
            <p className="muted">
              {tr('目标：', 'Destination: ')}
              {path.at(-1)?.name ?? tr('根目录', 'Root')}
            </p>
          </>
        )}
        {(action.type === 'share' || action.type === 'direct' || action.type === 'site') &&
          !link && (
            <>
              {action.type === 'site' && (
                <p>
                  {tr(
                    '以 index.html 为入口，资源使用相对路径。',
                    'Use index.html as the entry point and relative paths for assets.',
                  )}
                </p>
              )}
              {(action.type === 'share' || action.type === 'site') && (
                <label>
                  {tr('访问密码（可选）', 'Password (optional)')}
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
                  {tr('有效期', 'Expires')}
                  <Select
                    aria-label={tr('网站有效期', 'Website expiry')}
                    value={siteDays}
                    onValueChange={setSiteDays}
                    options={[
                      { value: '0', label: tr('永久有效', 'Never') },
                      { value: '1', label: tr('1 天', '1 day') },
                      { value: '7', label: tr('7 天', '7 days') },
                      { value: '30', label: tr('30 天', '30 days') },
                      { value: '365', label: tr('1 年', '1 year') },
                    ]}
                  />
                </label>
              ) : (
                <label>
                  {tr('过期时间（留空永久有效）', 'Expiry date (leave blank for no expiry)')}
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
                  {tr('允许下载', 'Allow downloads')}
                </label>
              )}
            </>
          )}
        {action.type === 'emptyTrash' && (
          <p>{tr('清空回收站？此操作无法恢复。', 'Empty the trash? This cannot be undone.')}</p>
        )}
        {link && (
          <>
            <LinkOriginSelect />
            <label>
              {action.type === 'direct'
                ? tr('文件直链', 'Direct link')
                : tr('公开链接', 'Public link')}
              <input readOnly value={selectedLink} onFocus={(e) => e.target.select()} />
            </label>
            <div className="dialog-footer">
              <Button
                type="button"
                onClick={() =>
                  void copy(selectedLink)
                    .then(() => notify(tr('链接已复制', 'Link copied')))
                    .catch(() =>
                      setError(
                        tr(
                          '无法访问剪贴板，请手动复制',
                          'Clipboard unavailable. Copy the link manually.',
                        ),
                      ),
                    )
                }
              >
                {tr('复制链接', 'Copy link')}
              </Button>
              <Button asChild variant="outline">
                <a href={selectedLink} target="_blank" rel="noreferrer">
                  {action.type === 'direct'
                    ? tr('下载文件', 'Download file')
                    : tr('打开分享', 'Open share')}
                </a>
              </Button>
            </div>
          </>
        )}
        {(action.type === 'delete' || action.type === 'purge') && (
          <p>
            {tr('确定', 'OK')}
            {action.type === 'purge'
              ? tr('永久删除', 'Delete permanently')
              : tr('移入回收站', 'Move to trash')}
            「{action.file?.name ?? action.folder?.name}」？
            {action.type === 'purge' ? tr('此操作无法恢复。', 'This cannot be undone.') : ''}
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
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant={
                action.type === 'purge' || action.type === 'emptyTrash' ? 'danger' : 'default'
              }
              disabled={busy}
            >
              {busy
                ? tr('处理中…', 'Working…')
                : action.type === 'share' || action.type === 'direct' || action.type === 'site'
                  ? tr('生成链接', 'Create link')
                  : tr('确认', 'Confirm')}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
