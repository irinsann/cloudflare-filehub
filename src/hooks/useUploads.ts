import { useState, useRef } from 'react';
import type { Settings } from '../../shared/types';
import { sizeLabel } from '../lib/api';
export interface UploadItem {
  id: string;
  file: File;
  folderId: string | null;
  progress: number;
  state: 'queued' | 'uploading' | 'success' | 'error';
  error?: string;
}
export function useUploads(
  settings: Settings | null,
  onComplete: () => void,
  notify: (s: string) => void,
) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]),
    working = useRef(false);
  const update = (id: string, patch: Partial<UploadItem>) =>
    setItems((all) => all.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  async function run() {
    if (working.current) return;
    working.current = true;
    while (queue.current.length) {
      const item = queue.current.shift()!;
      update(item.id, { state: 'uploading' });
      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const params = new URLSearchParams({ name: item.file.name });
          if (item.folderId) params.set('folder_id', item.folderId);
          xhr.open('POST', `/api/admin/files/upload?${params}`);
          xhr.setRequestHeader('X-Drive-Request', '1');
          xhr.setRequestHeader('X-File-Size', String(item.file.size));
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable)
              update(item.id, { progress: Math.round((e.loaded / e.total) * 100) });
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else {
              let message = '上传失败';
              try {
                message = JSON.parse(xhr.responseText).error.message;
              } catch {
                /* Network or HTML authentication response. */
              }
              reject(new Error(message));
            }
          };
          xhr.onerror = () => reject(new Error('网络连接失败'));
          xhr.onabort = () => reject(new Error('上传已中断'));
          xhr.timeout = 120000;
          xhr.ontimeout = () => reject(new Error('上传超时'));
          xhr.send(item.file);
        });
        update(item.id, { state: 'success', progress: 100 });
        onComplete();
      } catch (e) {
        update(item.id, { state: 'error', error: e instanceof Error ? e.message : '上传失败' });
      }
    }
    working.current = false;
    notify('上传队列已完成');
  }
  function add(files: File[], folderId: string | null) {
    if (!settings) {
      notify('请等待配置加载完成');
      return;
    }
    const accepted: UploadItem[] = [];
    for (const file of files) {
      if (file.size > settings.maxUploadBytes) {
        notify(`${file.name} 超过 ${sizeLabel(settings.maxUploadBytes)} 上限`);
        continue;
      }
      accepted.push({ id: crypto.randomUUID(), file, folderId, progress: 0, state: 'queued' });
    }
    setItems((all) => [...all, ...accepted]);
    queue.current.push(...accepted);
    void run();
  }
  function retry(item: UploadItem) {
    const next = { ...item, progress: 0, state: 'queued' as const, error: undefined };
    update(item.id, next);
    queue.current.push(next);
    void run();
  }
  return {
    items,
    add,
    retry,
    clear: () =>
      setItems((all) => all.filter((i) => i.state === 'uploading' || i.state === 'queued')),
  };
}
