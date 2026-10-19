import { tr } from '../../lib/i18n';
import {
  FolderOpen,
  ChevronRight,
  FolderPlus,
  List,
  LayoutGrid,
  Trash2,
  Folder,
  MoreHorizontal,
  File,
  FileText,
  Image,
  Film,
  Music,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Select } from '../ui/select';
import { EmptyState } from '../EmptyState';
import type { FileRecord, FolderRecord } from '../../../shared/types';
import type { Action } from '../Actions';
import type { useFileBrowser } from '../../hooks/useFileBrowser';
import { fileUrl, sizeLabel, dateLabel } from '../../lib/api';
import { sections } from '../../lib/navigation';
function FileIcon({ file }: { file: FileRecord }) {
  const Icon = file.mime.startsWith('image/')
    ? Image
    : file.mime.startsWith('video/')
      ? Film
      : file.mime.startsWith('audio/')
        ? Music
        : file.mime.startsWith('text/')
          ? FileText
          : File;
  return <Icon size={21} strokeWidth={1.6} />;
}

export function FilesPanel({
  browser,
  setAction,
  setMenu,
  openFile,
  setBulkDelete,
}: {
  browser: ReturnType<typeof useFileBrowser>;
  setAction: (action: Action) => void;
  setMenu: (menu: { file?: FileRecord; folder?: FolderRecord }) => void;
  openFile: (file: FileRecord) => void;
  setBulkDelete: (open: boolean) => void;
}) {
  const {
    view,
    crumbs,
    setFolder,
    setCrumbs,
    setPage,
    query,
    sort,
    setSort,
    direction,
    setDirection,
    grid,
    setGrid,
    selected,
    setSelected,
    loading,
    listing,
    openFolder,
    select,
    error,
    page,
  } = browser;
  const heading = sections.find((s) => s.id === view)!.label;
  const folders = query ? [] : (listing?.folders ?? []);
  const folderTotal = query ? 0 : (listing?.folderTotal ?? 0);
  const itemTotal = Math.max(listing?.total ?? 0, folderTotal);
  return (
    <section className="files-panel">
      <div className="file-toolbar">
        <div className="breadcrumbs">
          <button
            onClick={() => {
              setFolder(null);
              setCrumbs([]);
              setPage(1);
            }}
          >
            <FolderOpen size={16} />
            {view === 'files' ? tr('全部文件', 'All files') : heading}
          </button>
          {crumbs.map((f, i) => (
            <span key={f.id}>
              <ChevronRight size={14} />
              <button
                onClick={() => {
                  setFolder(f.id);
                  setCrumbs(crumbs.slice(0, i + 1));
                  setPage(1);
                }}
              >
                <span className="file-title">{f.name}</span>
              </button>
            </span>
          ))}
          {query && (
            <span className="muted">
              {tr('/ 搜索：', '/ Search: ')}
              {query}
            </span>
          )}
          {!!listing?.files.length && (
            <Button
              className="mobile-select-all"
              variant="ghost"
              size="sm"
              onClick={() =>
                setSelected(
                  selected.size === listing.files.length
                    ? new Set()
                    : new Set(listing.files.map((f) => f.id)),
                )
              }
            >
              {selected.size === listing.files.length
                ? tr('取消全选', 'Deselect all')
                : tr('全选', 'Select all')}
            </Button>
          )}
        </div>
        <div className="file-toolbar-actions">
          {view === 'files' && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={tr('新建文件夹', 'New folder')}
              onClick={() => setAction({ type: 'folder' })}
            >
              <FolderPlus size={17} />
              <span>{tr('新建文件夹', 'New folder')}</span>
            </Button>
          )}
          <Select
            aria-label={tr('排序方式', 'Sort by')}
            className="file-sort"
            size="sm"
            value={sort + ':' + direction}
            onValueChange={(value) => {
              const [key, order] = value.split(':');
              setSort(key);
              setDirection(order);
              setPage(1);
            }}
            options={[
              { value: 'updated_at:desc', label: tr('最新修改', 'Newest first') },
              { value: 'updated_at:asc', label: tr('最早修改', 'Oldest first') },
              { value: 'name:asc', label: tr('名称升序', 'Name A–Z') },
              { value: 'name:desc', label: tr('名称降序', 'Name Z–A') },
              { value: 'size:desc', label: tr('从大到小', 'Largest first') },
              { value: 'size:asc', label: tr('从小到大', 'Smallest first') },
            ]}
          />
          <div className="view-toggle">
            <button
              className={!grid ? 'selected' : ''}
              onClick={() => setGrid(false)}
              aria-label={tr('列表视图', 'List view')}
              aria-pressed={!grid}
            >
              <List size={16} />
            </button>
            <button
              className={grid ? 'selected' : ''}
              onClick={() => setGrid(true)}
              aria-label={tr('网格视图', 'Grid view')}
              aria-pressed={grid}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="selection-bar">
          <span>
            {tr('已选择', 'Selected ')}
            {selected.size}
            {tr('个文件', ' files')}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {tr('取消选择', 'Deselect')}
          </Button>
          {view !== 'trash' && (
            <Button size="sm" variant="danger" onClick={() => setBulkDelete(true)}>
              <Trash2 size={14} />
              {tr('批量删除', 'Delete selected')}
            </Button>
          )}
        </div>
      )}
      {loading ? (
        <div className="skeleton-list">
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="skeleton" />
          ))}
        </div>
      ) : (
        <>
          {!grid && (!!listing?.files.length || !!folders.length) && (
            <div className="file-row table-head">
              <span>{tr('名称', 'Name')}</span>
              <span>{tr('大小', 'Size')}</span>
              <span>{tr('修改时间', 'Modified')}</span>
              <label className="file-checkbox">
                <input
                  type="checkbox"
                  aria-label={tr('选择本页全部文件', 'Select all files on this page')}
                  disabled={!listing?.files.length}
                  checked={!!listing?.files.length && selected.size === listing.files.length}
                  onChange={() =>
                    setSelected(
                      selected.size === listing?.files.length
                        ? new Set()
                        : new Set(listing?.files.map((f) => f.id)),
                    )
                  }
                />
              </label>
              <span />
            </div>
          )}
          <div className={grid ? 'file-grid' : 'file-list'}>
            {folders.map((f) => (
              <div
                key={f.id}
                className={grid ? 'file-tile folder-tile' : 'file-row'}
                onDoubleClick={() => {
                  if (view !== 'trash') openFolder(f);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ folder: f });
                }}
              >
                <button
                  className="file-name folder-name"
                  onClick={() => {
                    if (view !== 'trash') openFolder(f);
                  }}
                >
                  <span className="type-icon folder-icon">
                    <Folder size={grid ? 36 : 21} strokeWidth={1.6} />
                  </span>
                  <span>
                    <span className="file-title">{f.name}</span>
                    <small>{tr('文件夹', 'Folder')}</small>
                  </span>
                </button>
                <span className="file-size muted">—</span>
                <span className="file-date muted">{dateLabel(f.updated_at)}</span>
                {!grid && <span aria-hidden="true" />}
                <Button
                  className="file-more"
                  variant="ghost"
                  size="icon"
                  aria-label={tr('{0} 操作', 'Actions for {0}', { '0': f.name })}
                  onClick={() => setMenu({ folder: f })}
                >
                  <MoreHorizontal size={18} />
                </Button>
              </div>
            ))}
            {listing?.files.map((f) => (
              <div
                key={f.id}
                className={`${grid ? 'file-tile' : 'file-row'} ${selected.has(f.id) ? 'is-selected' : ''}`}
                onDoubleClick={() => {
                  if (view !== 'trash') openFile(f);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ file: f });
                }}
              >
                <button
                  className="file-name"
                  onClick={() => {
                    if (view !== 'trash') openFile(f);
                  }}
                >
                  <span
                    className={`type-icon ${f.mime.startsWith('image/') ? 'image-icon' : f.mime === 'text/markdown' ? 'markdown-icon' : ''}`}
                  >
                    {grid && f.mime.startsWith('image/') && view !== 'trash' ? (
                      <img loading="lazy" src={fileUrl(f.id, true)} alt="" />
                    ) : (
                      <FileIcon file={f} />
                    )}
                  </span>
                  <span>
                    <span className="file-title">{f.name}</span>
                    <small>
                      {f.mime === 'text/markdown'
                        ? 'Markdown'
                        : f.mime === 'application/octet-stream'
                          ? tr('文件', 'File')
                          : f.name.includes('.')
                            ? f.name.split('.').pop()?.toUpperCase()
                            : tr('文件', 'File')}
                      {' · ' + sizeLabel(f.size)}
                    </small>
                  </span>
                </button>
                <span className="file-size muted">{sizeLabel(f.size)}</span>
                <span className="file-date muted">{dateLabel(f.updated_at)}</span>
                <label className="file-checkbox" onDoubleClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    aria-label={tr('选择 {0}', 'Select {0}', { '0': f.name })}
                    onChange={() => select(f.id)}
                  />
                </label>
                <Button
                  className="file-more"
                  variant="ghost"
                  size="icon"
                  aria-label={tr('{0} 操作', 'Actions for {0}', { '0': f.name })}
                  onClick={() => setMenu({ file: f })}
                >
                  <MoreHorizontal size={18} />
                </Button>
              </div>
            ))}
          </div>
          {!listing?.files.length && !folders.length && !error && (
            <EmptyState
              label={
                query
                  ? tr('没有找到匹配文件', 'No matching files')
                  : view === 'trash'
                    ? tr('回收站为空', 'Trash is empty')
                    : tr('暂无文件', 'No files yet')
              }
            />
          )}
        </>
      )}
      <div className="file-footer">
        <span>
          {listing?.total ?? 0}
          {tr('个文件', ' files')}
          {folderTotal ? tr(' · {0} 个文件夹', ' · {0} folders', { '0': folderTotal }) : ''}
        </span>
        {(page > 1 || (!!listing && itemTotal > listing.limit)) && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {tr('上一页', 'Previous')}
            </Button>
            <span>{page}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || !listing || page * listing.limit >= itemTotal}
              onClick={() => setPage(page + 1)}
            >
              {tr('下一页', 'Next')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
