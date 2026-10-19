import { RotateCcw, Trash2, FileText, Download, Link2, Pencil, Move, Globe2 } from 'lucide-react';
import { Modal } from '../ui/dialog';
import { fileUrl } from '../../lib/api';
import type { FileRecord, FolderRecord } from '../../../shared/types';
import type { Action } from '../Actions';
export function FileMenu({
  menu,
  view,
  setMenu,
  setAction,
  openFile,
  restore,
}: {
  menu: { file?: FileRecord; folder?: FolderRecord };
  view: string;
  setMenu: (value: null) => void;
  setAction: (action: Action) => void;
  openFile: (f: FileRecord) => void;
  restore: (file?: FileRecord, folder?: FolderRecord) => Promise<void>;
}) {
  return (
    <Modal title={menu.file?.name ?? menu.folder!.name} onClose={() => setMenu(null)}>
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
            {menu.folder && (
              <button
                onClick={() => {
                  setAction({ type: 'site', ...menu });
                  setMenu(null);
                }}
              >
                <Globe2 size={17} />
                发布 HTML 网站
              </button>
            )}
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
  );
}
