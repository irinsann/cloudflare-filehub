import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderOpen,
  Clock3,
  FileText,
  Globe2,
  Link2,
  Trash2,
  Settings2,
  Search,
  Upload,
  FolderPlus,
  Plus,
  Sun,
  Moon,
  List,
  LayoutGrid,
  ChevronRight,
  MoreHorizontal,
  Folder,
  File,
  Image,
  Film,
  Music,
  Download,
  Pencil,
  Move,
  RotateCcw,
  Menu,
  X,
  ArrowUpDown,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { FileRecord, FolderRecord, Listing, Settings } from '../shared/types';
import { api, send, fileUrl, sizeLabel, dateLabel } from './lib/api';
import { Button } from './components/ui/button';
import { Modal } from './components/ui/dialog';
import { Actions, type Action } from './components/Actions';
import { useUploads } from './hooks/useUploads';
import { brandMark } from '../shared/brand';
import { Management, Empty } from './pages/Management';
import { ImageHosting } from './pages/ImageHosting';
const Editor = lazy(() => import('./pages/Editor')),
  Preview = lazy(() => import('./components/Preview'));
const sections = [
  { id: 'files', label: '我的文件', icon: FolderOpen },
  { id: 'recent', label: '最近文件', icon: Clock3 },
  { id: 'markdown', label: 'Markdown 文档', icon: FileText },
  { id: 'published', label: '已发布文章', icon: Globe2 },
  { id: 'shares', label: '文件分享', icon: Link2 },
  { id: 'images', label: '图床', icon: Image },
  { id: 'trash', label: '回收站', icon: Trash2 },
  { id: 'settings', label: '设置', icon: Settings2 },
] as const;
type View = (typeof sections)[number]['id'];
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
export default function App() {
  const [view, setView] = useState<View>('files'),
    [settings, setSettings] = useState<Settings | null>(null),
    [listing, setListing] = useState<Listing | null>(null),
    [folder, setFolder] = useState<string | null>(null),
    [crumbs, setCrumbs] = useState<FolderRecord[]>([]),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [grid, setGrid] = useState(false),
    [sort, setSort] = useState('updated_at'),
    [direction, setDirection] = useState('desc'),
    [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [action, setAction] = useState<Action | null>(null),
    [menu, setMenu] = useState<{ file?: FileRecord; folder?: FolderRecord } | null>(null),
    [preview, setPreview] = useState<FileRecord | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [sidebar, setSidebar] = useState(false),
    [dropping, setDropping] = useState(false),
    [toast, setToast] = useState(''),
    [bulkDelete, setBulkDelete] = useState(false),
    [bulkBusy, setBulkBusy] = useState(false);
  const [theme, setTheme] = useState(() => {
    try {
      return (
        localStorage.getItem('theme') ??
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      );
    } catch {
      return 'light';
    }
  });
  const fileInput = useRef<HTMLInputElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    request = useRef(0);
  const notify = useCallback((message: string) => setToast(message), []),
    reload = useCallback(() => setRefresh((n) => n + 1), []);
  const uploads = useUploads(settings, reload, notify);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* Theme remains in memory. */
    }
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    void api<Settings>('/settings')
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, [refresh, view]);
  useEffect(() => {
    const timeout = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    setSelected(new Set());
    if (['published', 'shares', 'settings', 'images'].includes(view)) return;
    const serial = ++request.current;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      view,
      search: query,
      sort,
      direction,
      page: String(page),
    });
    if (folder) params.set('folder_id', folder);
    void api<Listing>(`/files?${params}`)
      .then((data) => {
        if (serial === request.current) setListing(data);
      })
      .catch((e) => {
        if (serial === request.current) setError(e.message);
      })
      .finally(() => {
        if (serial === request.current) setLoading(false);
      });
  }, [view, folder, query, sort, direction, page, refresh]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.current?.focus();
      }
      if (e.key === 'Escape') {
        setMenu(null);
        setSelected(new Set());
        setSidebar(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  function navigate(next: View) {
    setView(next);
    setFolder(null);
    setCrumbs([]);
    setPage(1);
    setSearch('');
    setSidebar(false);
  }
  function openFolder(f: FolderRecord) {
    setFolder(f.id);
    setCrumbs([...crumbs, f]);
    setPage(1);
    setSearch('');
  }
  function openFile(f: FileRecord) {
    if (/\.(md|markdown)$/i.test(f.name)) setEditing(f.id);
    else setPreview(f);
  }
  function select(id: string) {
    setSelected((all) => {
      const next = new Set(all);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function restore(file?: FileRecord, f?: FolderRecord) {
    try {
      await send(file ? `/files/${file.id}/restore` : `/folders/${f!.id}/restore`, 'POST');
      reload();
      notify('已恢复，公开访问保持关闭');
    } catch (e) {
      notify(e instanceof Error ? e.message : '恢复失败');
    }
  }
  async function batchDelete() {
    setBulkBusy(true);
    let completed = 0;
    for (const id of selected) {
      try {
        await send(`/files/${id}`, 'DELETE');
        completed++;
      } catch (e) {
        notify(e instanceof Error ? e.message : '删除失败');
        break;
      }
    }
    setBulkBusy(false);
    setBulkDelete(false);
    reload();
    notify(`已将 ${completed} 个文件移入回收站`);
  }
  const heading = sections.find((s) => s.id === view)!.label;
  const management =
    view === 'published' || view === 'shares' || view === 'settings' || view === 'images';
  if (editing)
    return (
      <Suspense
        fallback={
          <div className="full-loading">
            <Loader2 className="spin" />
            加载编辑器…
          </div>
        }
      >
        <Editor
          id={editing}
          theme={theme}
          settings={settings}
          notify={notify}
          onClose={() => {
            setEditing(null);
            reload();
          }}
        />
        {toast && (
          <div className="toast" role="status">
            <CheckCircle2 size={17} />
            {toast}
          </div>
        )}
      </Suspense>
    );
  return (
    <div className="app-shell">
      {sidebar && (
        <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebar(false)} />
      )}
      <aside className={`sidebar ${sidebar ? 'is-open' : ''}`}>
        <div className="logo">
          <span className="logo-mark">
            <span className="rcloud-mark" dangerouslySetInnerHTML={{ __html: brandMark }} />
          </span>
          <strong>RCloud</strong>
          <Button
            className="mobile-close"
            variant="ghost"
            size="icon"
            onClick={() => setSidebar(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </Button>
        </div>
        <div className="workspace-label">
          个人工作空间 <span>PRIVATE</span>
        </div>
        <nav>
          {sections.map((s) => (
            <button
              key={s.id}
              className={`nav-item ${view === s.id ? 'active' : ''} ${s.id === 'settings' ? 'nav-settings' : ''}`}
              onClick={() => navigate(s.id)}
            >
              <s.icon size={18} strokeWidth={1.7} />
              <span>{s.label}</span>
              {s.id === 'markdown' && <span className="nav-badge">MD</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="status-dot" />
          <span>私有存储 · 安全访问</span>
          <p>
            文件、文档与分享
            <br />
            统一管理。
          </p>
        </div>
        <div className="profile">
          <div className="avatar">I</div>
          <div>
            <strong>{settings?.environment === 'local' ? '本地工作空间' : '管理员'}</strong>
            <span>{settings?.email ?? '正在验证身份'}</span>
          </div>
          <ShieldMark />
        </div>
      </aside>
      <main
        className="main"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files') && !management && view !== 'trash') {
            e.preventDefault();
            setDropping(true);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          if (!management && view !== 'trash')
            uploads.add(Array.from(e.dataTransfer.files), folder);
        }}
      >
        <header className="topbar">
          <Button
            className="mobile-nav"
            variant="ghost"
            size="icon"
            onClick={() => setSidebar(true)}
            aria-label="打开导航"
          >
            <Menu size={20} />
          </Button>
          <div className="search-box">
            <Search size={17} />
            <input
              ref={searchInput}
              placeholder="搜索你的文件…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (management) setView('files');
              }}
              aria-label="搜索文件"
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="topbar-right">
            <span className="private-label">
              <span className="status-dot" /> 仅自己可见
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="切换主题"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            <div className="avatar small">I</div>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <h1>
                {heading}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {view === 'files'
                  ? '上传、分类和管理文件。'
                  : view === 'images'
                    ? '上传图片并获取直链。'
                    : view === 'markdown'
                      ? '创建、编辑和发布 Markdown 文档。'
                      : view === 'trash'
                        ? '恢复误删的文件，或永久释放存储空间。'
                        : view === 'published'
                          ? '管理已发布的文章。'
                          : view === 'shares'
                            ? '管理公开链接，随时收回访问权限。'
                            : view === 'recent'
                              ? '最近更新的文件都在这里。'
                              : '你的身份、存储限制与公开地址。'}
              </p>
            </div>
            <div className="heading-actions">
              {view === 'trash' && (
                <Button variant="danger" onClick={() => setAction({ type: 'emptyTrash' })}>
                  <Trash2 size={16} />
                  清空回收站
                </Button>
              )}
              {!management && view !== 'trash' && (
                <>
                  {view === 'markdown' && (
                    <Button variant="outline" onClick={() => setAction({ type: 'markdown' })}>
                      <Plus size={16} />
                      新建文档
                    </Button>
                  )}
                  <Button onClick={() => fileInput.current?.click()} disabled={!settings}>
                    <Upload size={16} />
                    上传文件
                  </Button>
                </>
              )}
            </div>
          </div>
          <input
            type="file"
            ref={fileInput}
            hidden
            multiple
            onChange={(e) => {
              uploads.add(Array.from(e.target.files ?? []), folder);
              e.target.value = '';
            }}
          />
          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  reload();
                  void api<Settings>('/settings')
                    .then(setSettings)
                    .catch((e) => setError(e.message));
                }}
              >
                重试
              </Button>
            </div>
          )}
          {view === 'images' ? (
            <ImageHosting settings={settings} notify={notify} />
          ) : management ? (
            <Management
              view={view}
              refresh={refresh}
              settings={settings}
              onEdit={setEditing}
              notify={notify}
            />
          ) : (
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
                        {f.name}
                      </button>
                    </span>
                  ))}
                  {query && <span className="muted"> / 搜索：{query}</span>}
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
                  <select
                    aria-label="排序方式"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="updated_at">修改时间</option>
                    <option value="name">名称</option>
                    <option value="size">大小</option>
                  </select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="切换排序方向"
                    onClick={() => setDirection(direction === 'desc' ? 'asc' : 'desc')}
                  >
                    <ArrowUpDown size={15} />
                  </Button>
                  <div className="view-toggle">
                    <button
                      className={!grid ? 'selected' : ''}
                      onClick={() => setGrid(false)}
                      aria-label="列表视图"
                    >
                      <List size={16} />
                    </button>
                    <button
                      className={grid ? 'selected' : ''}
                      onClick={() => setGrid(true)}
                      aria-label="网格视图"
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
                  {!grid && (
                    <div className="file-row table-head">
                      <span>
                        <input
                          type="checkbox"
                          aria-label="选择本页全部文件"
                          checked={
                            !!listing?.files.length && selected.size === listing.files.length
                          }
                          onChange={() =>
                            setSelected(
                              selected.size === listing?.files.length
                                ? new Set()
                                : new Set(listing?.files.map((f) => f.id)),
                            )
                          }
                        />
                      </span>
                      <span>名称</span>
                      <span>大小</span>
                      <span>修改时间</span>
                      <span />
                    </div>
                  )}
                  <div className={grid ? 'file-grid' : 'file-list'}>
                    {listing?.folders.map((f) => (
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
                        {!grid && <span />}
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
                            {f.name}
                            <small>文件夹</small>
                          </span>
                        </button>
                        <span className="file-size muted">—</span>
                        <span className="file-date muted">{dateLabel(f.updated_at)}</span>
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
                        <span className="file-checkbox">
                          <input
                            type="checkbox"
                            checked={selected.has(f.id)}
                            aria-label={`选择 ${f.name}`}
                            onChange={() => select(f.id)}
                          />
                        </span>
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
                            {f.name}
                            <small>
                              {f.mime === 'text/markdown'
                                ? 'Markdown 文档'
                                : f.mime === 'application/octet-stream'
                                  ? '文件'
                                  : f.mime}
                            </small>
                          </span>
                        </button>
                        <span className="file-size muted">{sizeLabel(f.size)}</span>
                        <span className="file-date muted">{dateLabel(f.updated_at)}</span>
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
                  {!listing?.files.length && !listing?.folders.length && !error && (
                    <Empty
                      label={
                        query
                          ? '没有找到匹配文件'
                          : view === 'trash'
                            ? '回收站很干净'
                            : '这里还有很多可能'
                      }
                      note={
                        query
                          ? '试试更短的关键词。'
                          : '上传第一个文件，或新建一篇 Markdown 开始记录。'
                      }
                    />
                  )}
                </>
              )}
              <div className="file-footer">
                <span>
                  {listing?.total ?? 0} 个文件
                  {settings
                    ? ` · 已用 ${sizeLabel(settings.storageUsedBytes)} / ${sizeLabel(settings.storageLimitBytes)}`
                    : ''}
                </span>
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
              </div>
            </section>
          )}
          <div className="content-footer">
            <span>RCloud</span>
            <span></span>
          </div>
        </div>
        {dropping && (
          <div className="drop-zone" onDragLeave={() => setDropping(false)}>
            <Upload size={48} />
            <h2>松开即可上传</h2>
            <p>文件将存入当前目录</p>
          </div>
        )}
      </main>
      {uploads.items.length > 0 && (
        <aside className="upload-panel">
          <header>
            <strong>上传任务</strong>
            <Button variant="ghost" size="icon" onClick={uploads.clear} aria-label="清除已完成任务">
              <X size={16} />
            </Button>
          </header>
          {uploads.items.map((item) => (
            <div key={item.id} className="upload-item">
              <div>
                <span>{item.file.name}</span>
                {item.state === 'success' ? (
                  <CheckCircle2 size={16} />
                ) : item.state === 'error' ? (
                  <Button variant="ghost" size="sm" onClick={() => uploads.retry(item)}>
                    <RefreshCw size={13} />
                    重试
                  </Button>
                ) : (
                  <span>{item.progress}%</span>
                )}
              </div>
              <progress max={100} value={item.progress} />
              <small className={item.state === 'error' ? 'error-text' : 'muted'}>
                {item.error ??
                  (item.state === 'success'
                    ? '已完成'
                    : item.state === 'queued'
                      ? '等待上传'
                      : '正在上传')}{' '}
                · {sizeLabel(item.file.size)}
              </small>
            </div>
          ))}
        </aside>
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {action && (
        <Actions
          key={`${action.type}${action.file?.id ?? action.folder?.id ?? ''}`}
          action={action}
          settings={settings}
          currentFolder={folder}
          onClose={() => setAction(null)}
          onDone={(id) => {
            reload();
            notify('操作已完成');
            if (id) setEditing(id);
          }}
          notify={notify}
        />
      )}
      {preview && (
        <Suspense fallback={<div className="full-loading">加载预览…</div>}>
          <Preview file={preview} onClose={() => setPreview(null)} />
        </Suspense>
      )}
      {menu && (
        <Modal
          title={menu.file?.name ?? menu.folder!.name}
          description="文件操作"
          onClose={() => setMenu(null)}
        >
          <div className="action-menu">
            {view === 'trash' ? (
              <>
                <button
                  onClick={() => {
                    void restore(menu.file, menu.folder);
                    setMenu(null);
                  }}
                >
                  <RotateCcw size={17} />
                  恢复
                </button>
                <button
                  className="danger-text"
                  onClick={() => {
                    setAction({ type: 'purge', ...menu });
                    setMenu(null);
                  }}
                >
                  <Trash2 size={17} />
                  永久删除
                </button>
              </>
            ) : (
              <>
                {menu.file && (
                  <>
                    <button
                      onClick={() => {
                        openFile(menu.file!);
                        setMenu(null);
                      }}
                    >
                      <FileText size={17} />
                      打开 / 预览
                    </button>
                    <a href={fileUrl(menu.file.id)} onClick={() => setMenu(null)}>
                      <Download size={17} />
                      下载文件
                    </a>
                    <button
                      onClick={() => {
                        setAction({ type: 'share', ...menu });
                        setMenu(null);
                      }}
                    >
                      <Link2 size={17} />
                      创建分享
                    </button>
                    <button
                      onClick={() => {
                        setAction({ type: 'direct', ...menu });
                        setMenu(null);
                      }}
                    >
                      <Link2 size={17} />
                      生成文件直链
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    setAction({ type: 'rename', ...menu });
                    setMenu(null);
                  }}
                >
                  <Pencil size={17} />
                  重命名
                </button>
                <button
                  onClick={() => {
                    setAction({ type: 'move', ...menu });
                    setMenu(null);
                  }}
                >
                  <Move size={17} />
                  移动
                </button>
                <button
                  className="danger-text"
                  onClick={() => {
                    setAction({ type: 'delete', ...menu });
                    setMenu(null);
                  }}
                >
                  <Trash2 size={17} />
                  移入回收站
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
      {bulkDelete && (
        <Modal
          title="批量移入回收站"
          onClose={() => {
            if (!bulkBusy) setBulkDelete(false);
          }}
        >
          <p>确定删除所选的 {selected.size} 个文件？关联分享和文章会立即失效。</p>
          <div className="dialog-footer">
            <Button variant="outline" onClick={() => setBulkDelete(false)} disabled={bulkBusy}>
              取消
            </Button>
            <Button variant="danger" disabled={bulkBusy} onClick={() => void batchDelete()}>
              {bulkBusy ? '处理中…' : '确认删除'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function ShieldMark() {
  return (
    <span className="shield-mark" title="Access 保护">
      <CheckCircle2 size={15} />
    </span>
  );
}
