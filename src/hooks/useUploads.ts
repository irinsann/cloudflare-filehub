import { useState, useRef } from 'react';
import type { Settings } from '../../shared/types';
import { send } from '../lib/api';
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
        const session =
          item.file.size > 0
            ? await send<{ id: string; partSize: number }>('/uploads', 'POST', {
                name: item.file.name,
                size: item.file.size,
                folder_id: item.folderId,
              })
            : null;
        async function uploadPart(path: string, blob: Blob, offset: number) {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(session ? 'PUT' : 'POST', '/api/admin' + path);
            xhr.setRequestHeader('X-Drive-Request', '1');
            xhr.setRequestHeader('X-File-Size', String(blob.size));
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable)
                update(item.id, {
                  progress: Math.min(
                    99,
                    Math.round(((offset + e.loaded) / Math.max(1, item.file.size)) * 100),
                  ),
                });
            };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else {
                let message = '上传失败，请重新登录后重试';
                try {
                  message = JSON.parse(xhr.responseText).error.message;
                } catch {
                  /* Access may return HTML. */
                }
                reject(new Error(message));
              }
            };
            xhr.onerror = () => reject(new Error('网络连接失败'));
            xhr.timeout = 300000;
            xhr.ontimeout = () => reject(new Error('分片上传超时'));
            xhr.onabort = () => reject(new Error('上传已中断'));
            xhr.send(blob);
          });
        }
        try {
          if (session) {
            for (
              let offset = 0, part = 1;
              offset < item.file.size;
              offset += session.partSize, part++
            ) {
              const blob = item.file.slice(offset, offset + session.partSize);
              for (let attempt = 0; ; attempt++) {
                try {
                  await uploadPart('/uploads/' + session.id + '/parts/' + part, blob, offset);
                  break;
                } catch (e) {
                  if (attempt >= 2) throw e;
                }
              }
            }
            await send('/uploads/' + session.id + '/complete', 'POST');
          } else {
            const params = new URLSearchParams({ name: item.file.name });
            if (item.folderId) params.set('folder_id', item.folderId);
            await uploadPart('/files/upload?' + params, item.file, 0);
          }
        } catch (e) {
          if (session)
            try {
              await send('/uploads/' + session.id, 'DELETE');
            } catch {
              /* Stale sessions expire automatically. */
            }
          throw e;
        }
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
