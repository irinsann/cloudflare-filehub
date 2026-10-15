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
            {view === 'files' ? '全部文件' : heading}
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
          {query && <span className="muted"> / 搜索：{query}</span>}
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
              {selected.size === listing.files.length ? '取消全选' : '全选'}
            </Button>
          )}
        </div>
        <div className="file-toolbar-actions">
          {view === 'files' && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="新建文件夹"
              onClick={() => setAction({ type: 'folder' })}
            >
              <FolderPlus size={17} />
              <span>新建文件夹</span>
            </Button>
          )}
          <Select
            aria-label="排序方式"
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
              { value: 'updated_at:desc', label: '最新修改' },
              { value: 'updated_at:asc', label: '最早修改' },
              { value: 'name:asc', label: '名称升序' },
              { value: 'name:desc', label: '名称降序' },
              { value: 'size:desc', label: '从大到小' },
              { value: 'size:asc', label: '从小到大' },
            ]}
          />
          <div className="view-toggle">
            <button
              className={!grid ? 'selected' : ''}
              onClick={() => setGrid(false)}
              aria-label="列表视图"
              aria-pressed={!grid}
            >
              <List size={16} />
            </button>
            <button
              className={grid ? 'selected' : ''}
              onClick={() => setGrid(true)}
              aria-label="网格视图"
              aria-pressed={grid}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="selection-bar">
          <span>已选择 {selected.size} 个文件</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
          {view !== 'trash' && (
            <Button size="sm" variant="danger" onClick={() => setBulkDelete(true)}>
              <Trash2 size={14} />
              批量删除
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
              <span>名称</span>
              <span>大小</span>
              <span>修改时间</span>
              <label className="file-checkbox">
                <input
                  type="checkbox"
                  aria-label="选择本页全部文件"
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
                    <small>文件夹</small>
                  </span>
                </button>
                <span className="file-size muted">—</span>
                <span className="file-date muted">{dateLabel(f.updated_at)}</span>
                {!grid && <span aria-hidden="true" />}
                <Button
                  className="file-more"
                  variant="ghost"
                  size="icon"
                  aria-label={`${f.name} 操作`}
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
                          ? '文件'
                          : f.name.includes('.')
                            ? f.name.split('.').pop()?.toUpperCase()
                            : '文件'}
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
                    aria-label={`选择 ${f.name}`}
                    onChange={() => select(f.id)}
                  />
                </label>
                <Button
                  className="file-more"
                  variant="ghost"
                  size="icon"
                  aria-label={`${f.name} 操作`}
                  onClick={() => setMenu({ file: f })}
                >
                  <MoreHorizontal size={18} />
                </Button>
              </div>
            ))}
          </div>
          {!listing?.files.length && !folders.length && !error && (
            <EmptyState
              label={query ? '没有找到匹配文件' : view === 'trash' ? '回收站为空' : '暂无文件'}
            />
          )}
        </>
      )}
      <div className="file-footer">
        <span>
          {listing?.total ?? 0} 个文件
          {folders.length ? ` · ${folders.length} 个文件夹` : ''}
        </span>
        {(page > 1 || (!!listing && listing.total > listing.limit)) && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </Button>
            <span>{page}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!listing || page * listing.limit >= listing.total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
