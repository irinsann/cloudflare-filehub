import { tr } from './lib/i18n';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import type { FileRecord, FolderRecord } from '../shared/types';
import { send } from './lib/api';
import { Button } from './components/ui/button';
import { Modal } from './components/ui/dialog';
import { Actions, type Action } from './components/Actions';
import { useUploads } from './hooks/useUploads';
import { useFileBrowser } from './hooks/useFileBrowser';
import { useTheme } from './hooks/useTheme';
import { useSettings } from './hooks/useSettings';
import { sections } from './lib/navigation';
import { WorkspaceShell } from './components/workspace/WorkspaceShell';
import { FilesPanel } from './components/workspace/FilesPanel';
import { FileMenu } from './components/workspace/FileMenu';
import { UploadQueue } from './components/workspace/UploadQueue';
import { Management } from './pages/Management';
import { ImageHosting } from './pages/ImageHosting';
import { PublicLinksProvider } from './components/PublicLinks';
import { useLocale } from './lib/i18n';
import { HtmlHosting } from './pages/HtmlHosting';
import { useHtmlUploads } from './hooks/useHtmlUploads';
const Editor = lazy(() => import('./pages/Editor')),
  Preview = lazy(() => import('./components/Preview'));
export default function App() {
  useLocale();
  const browser = useFileBrowser();
  const { view, folder, refresh, reload, navigate, search, searchFiles, selected, setSelected } =
    browser;
  const { settings, error: settingsError } = useSettings(refresh, view);
  const { theme, toggleTheme } = useTheme();
  const error = browser.error || settingsError;
  const [action, setAction] = useState<Action | null>(null),
    [menu, setMenu] = useState<{ file?: FileRecord; folder?: FolderRecord } | null>(null),
    [preview, setPreview] = useState<FileRecord | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [toast, setToast] = useState(''),
    [bulkDelete, setBulkDelete] = useState(false),
    [bulkBusy, setBulkBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    searchInput = useRef<HTMLInputElement>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  const uploads = useUploads(settings, reload, notify);
  const htmlUploads = useHtmlUploads(reload);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchInput.current?.focus();
      }
      if (e.key === 'Escape') {
        setMenu(null);
        setSelected(new Set());
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [setSelected]);
  function openFile(f: FileRecord) {
    if (/\.(md|markdown)$/i.test(f.name)) setEditing(f.id);
    else setPreview(f);
  }
  async function restore(file?: FileRecord, f?: FolderRecord) {
    try {
      await send(file ? `/files/${file.id}/restore` : `/folders/${f!.id}/restore`, 'POST');
      reload();
      notify(tr('已恢复，公开访问保持关闭', 'Restored. Public access remains off.'));
    } catch (e) {
      notify(e instanceof Error ? e.message : tr('恢复失败', 'Could not restore'));
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
        notify(e instanceof Error ? e.message : tr('删除失败', 'Could not delete'));
        break;
      }
    }
    setBulkBusy(false);
    setBulkDelete(false);
    reload();
    notify(tr('已将 {0} 个文件移入回收站', 'Moved {0} files to trash', { '0': completed }));
  }
  const section = sections.find((s) => s.id === view)!;
  const heading = section.label;
  const management =
    view === 'published' ||
    view === 'shares' ||
    view === 'settings' ||
    view === 'images' ||
    view === 'html';
  if (editing)
    return (
      <PublicLinksProvider settings={settings}>
        <Suspense
          fallback={
            <div className="full-loading">
              <Loader2 className="spin" />
              {tr('加载编辑器…', 'Loading editor…')}
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
      </PublicLinksProvider>
    );
  return (
    <PublicLinksProvider settings={settings}>
      <WorkspaceShell
        view={view}
        navigate={navigate}
        settings={settings}
        theme={theme}
        toggleTheme={toggleTheme}
        search={search}
        onSearch={searchFiles}
        searchInput={searchInput}
        allowDrop={!management && view !== 'trash'}
        onFiles={(files) => uploads.add(files, folder)}
      >
        <div className="content" data-view={view}>
          <div className="page-heading">
            <div>
              <span className="page-heading-icon" aria-hidden="true">
                <section.icon size={23} strokeWidth={1.7} />
              </span>
              <h1>{heading}</h1>
            </div>
            <div className="heading-actions">
              {view === 'trash' && (
                <Button variant="danger" onClick={() => setAction({ type: 'emptyTrash' })}>
                  <Trash2 size={16} />
                  {tr('清空回收站', 'Empty trash')}
                </Button>
              )}
              {!management && view !== 'trash' && (
                <>
                  {view === 'markdown' && (
                    <Button variant="outline" onClick={() => setAction({ type: 'markdown' })}>
                      <Plus size={16} />
                      {tr('新建文档', 'New document')}
                    </Button>
                  )}
                  <Button onClick={() => fileInput.current?.click()} disabled={!settings}>
                    <Upload size={16} />
                    {tr('上传文件', 'Upload files')}
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
              <Button variant="ghost" size="sm" onClick={reload}>
                {tr('重试', 'Retry')}
              </Button>
            </div>
          )}
          {view === 'images' ? (
            <ImageHosting settings={settings} notify={notify} onComplete={reload} />
          ) : view === 'html' ? (
            <HtmlHosting uploads={htmlUploads} revision={refresh} notify={notify} />
          ) : management ? (
            <Management
              view={view}
              refresh={refresh}
              settings={settings}
              onEdit={setEditing}
              notify={notify}
            />
          ) : (
            <FilesPanel
              browser={browser}
              setAction={setAction}
              setMenu={setMenu}
              openFile={openFile}
              setBulkDelete={setBulkDelete}
            />
          )}
        </div>

        <UploadQueue uploads={uploads} />
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
            currentFolder={folder}
            onClose={() => setAction(null)}
            onDone={(id) => {
              reload();
              notify(tr('操作已完成', 'Done'));
              if (id) setEditing(id);
            }}
            notify={notify}
          />
        )}
        {preview && (
          <Suspense
            fallback={<div className="full-loading">{tr('加载预览…', 'Loading preview…')}</div>}
          >
            <Preview file={preview} onClose={() => setPreview(null)} />
          </Suspense>
        )}
        {menu && (
          <FileMenu
            menu={menu}
            view={view}
            setMenu={setMenu}
            setAction={setAction}
            openFile={openFile}
            restore={restore}
          />
        )}
        {bulkDelete && (
          <Modal
            title={tr('批量移入回收站', 'Move selected files to trash')}
            onClose={() => {
              if (!bulkBusy) setBulkDelete(false);
            }}
          >
            <p>
              {tr('确定删除所选的', 'Delete the selected ')}
              {selected.size}
              {tr(
                '个文件？关联分享和文章会立即失效。',
                ' files? Their shares and published articles will become unavailable.',
              )}
            </p>
            <div className="dialog-footer">
              <Button variant="outline" onClick={() => setBulkDelete(false)} disabled={bulkBusy}>
                {tr('取消', 'Cancel')}
              </Button>
              <Button variant="danger" disabled={bulkBusy} onClick={() => void batchDelete()}>
                {bulkBusy ? tr('处理中…', 'Working…') : tr('确认删除', 'Delete')}
              </Button>
            </div>
          </Modal>
        )}
      </WorkspaceShell>
    </PublicLinksProvider>
  );
}
