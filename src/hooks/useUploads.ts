import { useState, useRef } from 'react';
import type { Settings } from '../../shared/types';
import { uploadFile } from '../lib/upload';
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
  notify: (message: string) => void,
) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]),
    working = useRef(false),
    retrying = useRef(new Set<string>());
  const update = (id: string, patch: Partial<UploadItem>) =>
    setItems((all) => all.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  async function run() {
    if (working.current) return;
    working.current = true;
    while (queue.current.length) {
      const item = queue.current.shift()!;
      update(item.id, { state: 'uploading' });
      try {
        await uploadFile(item.file, item.folderId, (progress) => update(item.id, { progress }));
        update(item.id, { state: 'success', progress: 100 });
        onComplete();
      } catch (error) {
        update(item.id, {
          state: 'error',
          error: error instanceof Error ? error.message : '上传失败',
        });
      } finally {
        retrying.current.delete(item.id);
      }
    }
    working.current = false;
    notify('上传队列已完成');
  }
  function add(files: File[], folderId: string | null) {
    if (!files.length) return;
    if (!settings) {
      notify('请等待配置加载完成');
      return;
    }
    const accepted = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      folderId,
      progress: 0,
      state: 'queued' as const,
    }));
    setItems((all) => [...all, ...accepted]);
    queue.current.push(...accepted);
    void run();
  }
  function retry(item: UploadItem) {
    if (retrying.current.has(item.id)) return;
    retrying.current.add(item.id);
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
      setItems((all) =>
        all.filter((item) => item.state === 'uploading' || item.state === 'queued'),
      ),
  };
}
