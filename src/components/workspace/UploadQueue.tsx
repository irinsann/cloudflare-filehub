import { useState } from 'react';
import { X, CheckCircle2, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../ui/button';
import { sizeLabel } from '../../lib/api';
import type { useUploads } from '../../hooks/useUploads';
export function UploadQueue({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!uploads.items.length) return null;
  return (
    <aside className="upload-panel">
      <header>
        <button
          className="upload-collapse"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
        >
          上传任务 · {uploads.items.filter((i) => i.state === 'success').length}/
          {uploads.items.length}
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <Button variant="ghost" size="icon" onClick={uploads.clear} aria-label="清除已完成任务">
          <X size={16} />
        </Button>
      </header>
      {!collapsed &&
        uploads.items.map((item) => (
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
  );
}
