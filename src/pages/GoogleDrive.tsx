import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Move,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  GOOGLE_DRIVE_FOLDER,
  type GoogleDriveFile,
  type GoogleDriveListing,
} from '../../shared/google-drive';
import { api, dateLabel, sizeLabel } from '../lib/api';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { Select } from '../components/ui/select';
import { EmptyState } from '../components/EmptyState';
import { GoogleDriveConnection, useGoogleDriveStatus } from '../components/GoogleDriveConnection';
import {
  GoogleDriveActions,
  driveDownloadUrl,
  googleFileLink,
  type DriveAction,
} from '../components/GoogleDriveActions';
import type { useGoogleDriveUploads } from '../hooks/useGoogleDriveUploads';
export function GoogleDrive({
  search,
  clearSearch,
  revision,
  uploads,
  notify,
}: {
  search: string;
  clearSearch: () => void;
  revision: number;
  uploads: ReturnType<typeof useGoogleDriveUploads>;
  notify: (message: string) => void;
}) {
  const connection = useGoogleDriveStatus(revision);
  const [crumbs, setCrumbs] = useState<GoogleDriveFile[]>([]),
    [trash, setTrash] = useState(false),
    [files, setFiles] = useState<GoogleDriveFile[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [menu, setMenu] = useState<GoogleDriveFile | null>(null),
    [action, setAction] = useState<DriveAction | null>(null);
  const [paging, setPaging] = useState({ key: '', tokens: [''], index: 0 }),
    [nextToken, setNextToken] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const menuConnection = useRef('');
  const previousConnection = useRef<string | undefined>(undefined);
  const parent = crumbs.at(-1),
    parentId = parent?.id || 'root';
  const key = JSON.stringify([parentId, search, trash]);
  const page = paging.key === key ? paging.index : 0,
    tokens = paging.key === key ? paging.tokens : [''];
  const token = tokens[page];
  const reload = () => {
    setRefresh((value) => value + 1);
    connection.reload();
  };
  useEffect(() => {
    const url = new URL(location.href),
      result = url.searchParams.get('google_drive');
    if (!result) return;
    notify(result === 'connected' ? 'Google Drive 已连接' : 'Google Drive 授权未完成，请重新连接');
    url.searchParams.delete('google_drive');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, [notify]);
  useEffect(() => {
    if (!connection.status) return;
    const current = connection.status.connectionId;
    if (previousConnection.current && previousConnection.current !== current) {
      uploads.stopForDisconnect();
      setCrumbs([]);
      setTrash(false);
      setFiles([]);
      setMenu(null);
      setAction(null);
      setPaging({ key: '', tokens: [''], index: 0 });
      clearSearch();
    }
    previousConnection.current = current;
  }, [connection.status?.connectionId]);
  useEffect(() => {
    if (!connection.status?.connected || connection.status.needsReconnect) {
      setFiles([]);
      setNextToken(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setFiles([]);
    setNextToken(undefined);
    const params = new URLSearchParams({ parent: parentId });
    if (search) params.set('q', search);
    if (token) params.set('page_token', token);
    if (trash) params.set('trashed', '1');
    void api<GoogleDriveListing>('/google-drive/files?' + params, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setFiles(result.files);
          setNextToken(result.nextPageToken);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '读取文件失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    connection.status?.connected,
    connection.status?.needsReconnect,
    connection.status?.connectionId,
    parentId,
    search,
    token,
    trash,
    revision,
    refresh,
  ]);
  function open(file: GoogleDriveFile) {
    if (file.mimeType === GOOGLE_DRIVE_FOLDER && !trash) {
      setCrumbs([...crumbs, file]);
      clearSearch();
    } else openMenu(file);
  }
  function openMenu(file: GoogleDriveFile) {
    menuConnection.current = connection.status?.connectionId || '';
    setMenu(file);
  }
  function choose(type: DriveAction['type']) {
    setAction({ type, file: menu!, connectionId: menuConnection.current });
    setMenu(null);
  }
  const addAllowed =
    !!connection.status?.connected &&
    !!connection.status.connectionId &&
    !connection.status.needsReconnect &&
    !loading &&
    !error &&
    !trash &&
    (!parent || parent.capabilities?.canAddChildren === true);
  return (
    <div className="google-drive-page">
      <GoogleDriveConnection
        {...connection}
        compact
        notify={notify}
        uploading={uploads.busy}
        onBeforeConnectionChange={uploads.stopForDisconnect}
        onChanged={() => {
          setCrumbs([]);
          setTrash(false);
          setMenu(null);
          setAction(null);
        }}
      />
      {connection.status?.connected && !connection.status.needsReconnect && (
        <section className="files-panel google-files">
          <div className="file-toolbar">
            <nav className="breadcrumbs" aria-label="Google Drive 路径">
              <button
                onClick={() => {
                  setCrumbs([]);
                  clearSearch();
                }}
              >
                <Folder size={17} />
                {trash ? 'Google 回收站' : '我的云端硬盘'}
              </button>
              {!trash &&
                crumbs.map((folder, index) => (
                  <span key={folder.id}>
                    <ChevronRight size={14} />
                    <button
                      onClick={() => {
                        setCrumbs(crumbs.slice(0, index + 1));
                        clearSearch();
                      }}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
            </nav>
            <div className="file-toolbar-actions">
              <Select
                aria-label="Google Drive 文件视图"
                size="sm"
                value={trash ? 'trash' : 'files'}
                onValueChange={(value) => {
                  setTrash(value === 'trash');
                  setCrumbs([]);
                  clearSearch();
                }}
                options={[
                  { value: 'files', label: '我的文件' },
                  { value: 'trash', label: '回收站' },
                ]}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新 Google Drive"
                disabled={loading}
                onClick={reload}
              >
                <RefreshCw size={16} />
              </Button>
            </div>
          </div>
          {!trash && (
            <div className="drive-actions-bar">
              <Button
                variant="outline"
                size="sm"
                disabled={!addAllowed}
                onClick={() =>
                  setAction({ type: 'folder', connectionId: connection.status!.connectionId! })
                }
              >
                <FolderPlus size={16} />
                新建文件夹
              </Button>
              <Button size="sm" disabled={!addAllowed} onClick={() => input.current?.click()}>
                <Upload size={16} />
                上传文件
              </Button>
              <input
                ref={input}
                type="file"
                hidden
                multiple
                onChange={(event) => {
                  uploads.add(
                    Array.from(event.target.files || []),
                    parentId,
                    connection.status!.connectionId!,
                  );
                  event.target.value = '';
                }}
              />
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <Button variant="ghost" size="sm" onClick={reload}>
                重试
              </Button>
            </div>
          )}
          {loading ? (
            <div className="skeleton-list" aria-label="加载 Google Drive 文件">
              {[1, 2, 3].map((value) => (
                <div key={value} className="skeleton" />
              ))}
            </div>
          ) : files.length ? (
            <div className="drive-file-list">
              {files.map((file) => (
                <article className="drive-file-row" key={file.id}>
                  <button className="file-name" onClick={() => open(file)}>
                    <span
                      className={`type-icon ${file.mimeType === GOOGLE_DRIVE_FOLDER ? 'folder-icon' : ''}`}
                    >
                      {file.mimeType === GOOGLE_DRIVE_FOLDER ? (
                        <Folder size={21} />
                      ) : (
                        <FileText size={19} />
                      )}
                    </span>
                    <span>
                      <span className="file-title">{file.name}</span>
                      <small>
                        {file.mimeType === GOOGLE_DRIVE_FOLDER
                          ? '文件夹'
                          : file.mimeType === 'application/vnd.google-apps.shortcut'
                            ? '快捷方式'
                            : file.size !== undefined
                              ? sizeLabel(Number(file.size))
                              : 'Google 文档'}
                      </small>
                    </span>
                  </button>
                  <span className="drive-file-date">
                    {file.modifiedTime && Number.isFinite(Date.parse(file.modifiedTime))
                      ? dateLabel(Date.parse(file.modifiedTime))
                      : '—'}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`操作 ${file.name}`}
                    onClick={() => openMenu(file)}
                  >
                    <MoreHorizontal size={18} />
                  </Button>
                </article>
              ))}
            </div>
          ) : (
            !error && (
              <EmptyState
                label={search ? '没有找到匹配文件' : trash ? 'Google 回收站为空' : '暂无文件'}
              />
            )
          )}
          <div className="file-footer">
            <span>{search ? '搜索结果' : `${files.length} 项`}</span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={loading || page === 0}
                onClick={() => setPaging({ key, tokens, index: page - 1 })}
              >
                上一页
              </Button>
              <span>{page + 1}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={loading || !nextToken}
                onClick={() =>
                  setPaging({
                    key,
                    tokens: [...tokens.slice(0, page + 1), nextToken!],
                    index: page + 1,
                  })
                }
              >
                下一页
              </Button>
            </div>
          </div>
        </section>
      )}
      {menu && (
        <Modal title={menu.name} onClose={() => setMenu(null)}>
          <div className="action-menu">
            {trash ? (
              <>
                <button disabled={!menu.capabilities?.canUntrash} onClick={() => choose('restore')}>
                  <RotateCcw size={17} />
                  恢复
                </button>
                <button
                  className="danger-text"
                  disabled={!menu.capabilities?.canDelete}
                  onClick={() => choose('delete')}
                >
                  <Trash2 size={17} />
                  永久删除
                </button>
              </>
            ) : (
              <>
                {menu.mimeType !== GOOGLE_DRIVE_FOLDER &&
                  (menu.exportFormats?.length ? (
                    <button
                      disabled={!menu.capabilities?.canDownload}
                      onClick={() => choose('export')}
                    >
                      <Download size={17} />
                      导出文件
                    </button>
                  ) : menu.capabilities?.canDownload ? (
                    <a href={driveDownloadUrl(menu)} onClick={() => setMenu(null)}>
                      <Download size={17} />
                      下载文件
                    </a>
                  ) : null)}
                {googleFileLink(menu.webViewLink) && (
                  <a
                    href={googleFileLink(menu.webViewLink)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setMenu(null)}
                  >
                    <ExternalLink size={17} />在 Google Drive 打开
                  </a>
                )}
                <button disabled={!menu.capabilities?.canRename} onClick={() => choose('rename')}>
                  <Pencil size={17} />
                  重命名
                </button>
                <button
                  disabled={!menu.capabilities?.canMoveItemWithinDrive}
                  onClick={() => choose('move')}
                >
                  <Move size={17} />
                  移动
                </button>
                <button
                  className="danger-text"
                  disabled={!menu.capabilities?.canTrash}
                  onClick={() => choose('trash')}
                >
                  <Trash2 size={17} />
                  移入回收站
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
      {action && (
        <GoogleDriveActions
          key={`${action.type}:${action.file?.id || parentId}`}
          action={action}
          parentId={parentId}
          connectionId={action.connectionId}
          onClose={() => setAction(null)}
          onDone={() => {
            reload();
            notify('操作已完成');
          }}
        />
      )}
    </div>
  );
}
