import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Search, Sun, Moon, Menu, X, Upload, HardDrive, ArrowUpRight } from 'lucide-react';
import { sections, type View } from '../../lib/navigation';
import { brandMark } from '../../../shared/brand';
import type { Settings } from '../../../shared/types';
import { sizeLabel } from '../../lib/api';
import { Button } from '../ui/button';
export function StorageMeter({ settings }: { settings: Settings | null }) {
  const used = settings?.storageUsedBytes ?? 0,
    total = settings?.storageLimitBytes ?? 50 * 1024 ** 3;
  return (
    <div className="storage-meter">
      <div>
        <span>
          <HardDrive size={15} />
          存储空间
        </span>
        <span>{Math.min(100, (used / total) * 100).toFixed(used / total < 0.01 ? 1 : 0)}%</span>
      </div>
      <progress value={used} max={total} aria-label="已用存储空间" />
      <small>
        {sizeLabel(used)}
        <span>/ {sizeLabel(total)}</span>
      </small>
    </div>
  );
}
export function WorkspaceShell({
  view,
  navigate,
  settings,
  theme,
  toggleTheme,
  search,
  onSearch,
  searchInput,
  allowDrop,
  onFiles,
  children,
}: {
  view: View;
  navigate: (view: View) => void;
  settings: Settings | null;
  theme: string;
  toggleTheme: () => void;
  search: string;
  onSearch: (text: string) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  allowDrop: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0),
    mainRef = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = matchMedia('(min-width: 901px)');
    const changed = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const go = (next: View) => {
    navigate(next);
    setOpen(false);
  };
  const logo = (
    <div className="logo">
      <span className="rcloud-mark" dangerouslySetInnerHTML={{ __html: brandMark }} />
      <strong>RCloud</strong>
    </div>
  );
  const links = (
    <nav className="workspace-nav" aria-label="工作空间">
      {sections.map((s, i) => (
        <button
          key={s.id}
          className={
            'nav-item ' + (view === s.id ? 'active' : '') + (i === 6 ? ' nav-divider' : '')
          }
          aria-current={view === s.id ? 'page' : undefined}
          onClick={() => go(s.id)}
        >
          <s.icon size={19} strokeWidth={1.7} />
          <span>{s.label}</span>
        </button>
      ))}
    </nav>
  );
  const account = (
    <div className="profile">
      <div className="avatar">{settings?.email?.charAt(0).toUpperCase() || 'R'}</div>
      <div>
        <strong>个人账号</strong>
        <span title={settings?.email}>{settings?.email ?? '加载中…'}</span>
      </div>
      <button aria-label="账号设置" onClick={() => go('settings')}>
        <ArrowUpRight size={17} />
      </button>
    </div>
  );
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        跳到内容
      </a>
      <aside className="sidebar">
        {logo}
        <div className="workspace-label">工作空间</div>
        {links}
        <div className="sidebar-bottom">
          <StorageMeter settings={settings} />
          {account}
        </div>
      </aside>
      <main
        ref={mainRef}
        tabIndex={-1}
        className="main"
        id="main-content"
        onDragEnter={(e) => {
          if (allowDrop && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }
        }}
        onDragOver={(e) => {
          if (allowDrop && e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(e) => {
          dragDepth.current = 0;
          setDragging(false);
          if (allowDrop && e.dataTransfer.files.length) {
            e.preventDefault();
            onFiles(Array.from(e.dataTransfer.files));
          }
        }}
      >
        <header className="topbar">
          <span
            className="mobile-brand"
            aria-label="RCloud"
            dangerouslySetInnerHTML={{ __html: brandMark }}
          />
          <div className="search-box">
            <Search size={18} />
            <input
              ref={searchInput}
              type="search"
              placeholder="搜索文件"
              aria-label="搜索文件"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
            />
            {search && (
              <button aria-label="清空搜索" onClick={() => onSearch('')}>
                <X size={16} />
              </button>
            )}
            <kbd>Ctrl / ⌘ K</kbd>
          </div>
          <div className="topbar-right">
            <Button variant="ghost" size="icon" aria-label="切换主题" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </Button>
          </div>
        </header>
        {children}
        {dragging && allowDrop && (
          <div className="drop-zone">
            <Upload size={40} />
            <h2>松开即可上传</h2>
          </div>
        )}
      </main>
      <nav className="mobile-tabs" aria-label="快捷导航">
        {['files', 'images', 'markdown'].map((id) => {
          const s = sections.find((s) => s.id === id)!;
          return (
            <button
              key={id}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => go(s.id)}
            >
              <s.icon size={21} />
              <span>{id === 'markdown' ? '文档' : id === 'files' ? '文件' : '图床'}</span>
            </button>
          );
        })}
        <button
          ref={closeButton}
          aria-label="更多导航"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className={!['files', 'images', 'markdown'].includes(view) ? 'active' : ''}
        >
          <Menu size={21} />
          <span>更多</span>
        </button>
      </nav>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="navigation-drawer"
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              closeButton.current?.focus();
            }}
          >
            <Dialog.Title className="sr-only">导航</Dialog.Title>
            <div className="drawer-header">
              {logo}
              <Dialog.Close className="button button-ghost button-icon" aria-label="关闭导航">
                <X size={20} />
              </Dialog.Close>
            </div>
            {links}
            <StorageMeter settings={settings} />
            {account}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
