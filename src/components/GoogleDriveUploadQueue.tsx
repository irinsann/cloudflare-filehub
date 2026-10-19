import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, X, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { sizeLabel } from '../lib/api';
import type { useGoogleDriveUploads } from '../hooks/useGoogleDriveUploads';
export function GoogleDriveUploadQueue({
  uploads,
}: {
  uploads: ReturnType<typeof useGoogleDriveUploads>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (!uploads.items.length) return null;
  return (
    <aside className="upload-panel" aria-label="Google Drive 上传任务">
      <header>
        <button
          className="upload-collapse"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
        >
          Google Drive · {uploads.items.filter((item) => item.state === 'success').length}/
          {uploads.items.length}
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <Button
          variant="ghost"
          size="icon"
          onClick={uploads.clear}
          aria-label="清除已结束的 Google Drive 上传"
        >
          <X size={16} />
        </Button>
      </header>
      {!collapsed &&
        uploads.items.map((item) => (
          <div className="upload-item" key={item.id}>
            <div>
              <span>{item.file.name}</span>
              {item.state === 'success' ? (
                <CheckCircle2 size={16} />
              ) : item.detached ? null : item.state === 'cancelling' ? (
                <span>确认中…</span>
              ) : item.state === 'uncertain' ? (
                item.sessionId && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => void uploads.inspect(item.id)}>
                      检查状态
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => uploads.cancel(item.id)}>
                      取消
                    </Button>
                  </>
                )
              ) : ['error', 'cancelled'].includes(item.state) ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!item.sessionId && !!item.started}
                    onClick={() => uploads.retry(item.id)}
                  >
                    <RotateCcw size={13} />
                    重试
                  </Button>
                  {item.state === 'error' && item.sessionId && (
                    <Button variant="ghost" size="sm" onClick={() => uploads.cancel(item.id)}>
                      取消
                    </Button>
                  )}
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => uploads.cancel(item.id)}>
                  取消
                </Button>
              )}
            </div>
            <progress max={100} value={item.progress} aria-label={`${item.file.name} 上传进度`} />
            <small className={item.state === 'error' ? 'error-text' : 'muted'}>
              {item.error ||
                {
                  queued: '等待上传',
                  uploading: `${item.progress}%`,
                  success: '已完成',
                  cancelled: '已取消',
                  error: '上传失败',
                  cancelling: '确认中…',
                  uncertain: '结果待确认',
                }[item.state]}{' '}
              · {sizeLabel(item.file.size)}
            </small>
          </div>
        ))}
    </aside>
  );
}
