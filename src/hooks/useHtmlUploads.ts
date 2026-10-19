import { tr } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import type { HtmlHostingItem } from '../../shared/html-hosting';
import { send } from '../lib/api';
import { uploadHostedHtml } from '../lib/html-upload';
export interface HtmlUploadItem {
  id: string;
  file: File;
  fileId?: string;
  progress: number;
  state: 'queued' | 'uploading' | 'publishing' | 'success' | 'error';
  error?: string;
  result?: HtmlHostingItem;
  invalid?: boolean;
}
export function useHtmlUploads(onComplete: () => void) {
  const [items, setItems] = useState<HtmlUploadItem[]>([]);
  const records = useRef(new Map<string, HtmlUploadItem>()),
    queue = useRef<string[]>([]),
    working = useRef(false),
    folder = useRef<string | undefined>(undefined);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (working.current || queue.current.length) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const done = useRef(onComplete);
  done.current = onComplete;
  const emit = () => setItems([...records.current.values()].map((item) => ({ ...item })));
  async function run() {
    if (working.current) return;
    working.current = true;
    try {
      while (queue.current.length) {
        const item = records.current.get(queue.current.shift()!)!;
        if (item.state !== 'queued') continue;
        item.state = 'uploading';
        item.error = undefined;
        emit();
        try {
          item.result = await uploadHostedHtml(item.file, item, {
            folder: async () => {
              if (!folder.current)
                folder.current = (await send<{ id: string }>('/html-hosting/folder', 'POST')).id;
              return folder.current;
            },
            progress: (progress) => {
              item.state = progress === null ? 'publishing' : 'uploading';
              item.progress = progress ?? 100;
              emit();
            },
          });
          item.state = 'success';
          emit();
          done.current();
        } catch (cause) {
          item.state = 'error';
          item.error = cause instanceof Error ? cause.message : tr('上传失败', 'Upload failed');
          folder.current = undefined;
          emit();
        }
      }
    } finally {
      working.current = false;
    }
  }
  function add(files: File[]) {
    for (const file of files) {
      const invalid = !/\.html?$/i.test(file.name) || !file.size;
      const item: HtmlUploadItem = {
        id: crypto.randomUUID(),
        file,
        progress: 0,
        state: invalid ? 'error' : 'queued',
        invalid,
        error: invalid ? tr('请选择非空 HTML 文件', 'Choose a non-empty HTML file') : undefined,
      };
      records.current.set(item.id, item);
      if (!invalid) queue.current.push(item.id);
    }
    emit();
    void run();
  }
  function retry(id: string) {
    const item = records.current.get(id);
    if (!item || item.state !== 'error' || item.invalid) return;
    item.state = 'queued';
    queue.current.push(id);
    emit();
    void run();
  }
  return {
    items,
    add,
    retry,
    dismiss: (id: string) => {
      const item = records.current.get(id);
      if (item?.state === 'error' || item?.state === 'success') {
        records.current.delete(id);
        emit();
      }
    },
    busy: items.some((item) => ['queued', 'uploading', 'publishing'].includes(item.state)),
    clear: () => {
      for (const [id, item] of records.current)
        if (item.state === 'success') records.current.delete(id);
      emit();
    },
  };
}
