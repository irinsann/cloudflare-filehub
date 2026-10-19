import { useEffect, useRef, useState } from 'react';
import type { GoogleDriveUpload } from '../../shared/google-drive';
import { api, send, ApiError } from '../lib/api';
import { uploadGoogleDriveFile } from '../lib/google-drive-upload';
export interface DriveUploadItem {
  id: string;
  file: File;
  parentId: string;
  connectionId: string;
  sessionId?: string;
  started?: boolean;
  detached?: boolean;
  progress: number;
  state: 'queued' | 'uploading' | 'cancelling' | 'uncertain' | 'success' | 'error' | 'cancelled';
  error?: string;
}
const pendingStates = ['queued', 'uploading', 'cancelling'];
export function useGoogleDriveUploads(onComplete: () => void) {
  const [items, setItems] = useState<DriveUploadItem[]>([]);
  const records = useRef(new Map<string, DriveUploadItem>()),
    queue = useRef<string[]>([]),
    working = useRef(false);
  const active = useRef<{ id: string; controller: AbortController } | null>(null);
  const complete = useRef(onComplete);
  useEffect(() => {
    complete.current = onComplete;
  }, [onComplete]);
  const emit = () => setItems([...records.current.values()].map((item) => ({ ...item })));
  const patch = (item: DriveUploadItem, change: Partial<DriveUploadItem>) => {
    Object.assign(item, change);
    emit();
  };
  function success(item: DriveUploadItem) {
    if (item.detached) return;
    patch(item, { state: 'success', progress: 100, error: undefined });
    complete.current();
  }
  async function removeSession(item: DriveUploadItem) {
    if (item.detached) return;
    if (!item.sessionId) {
      patch(
        item,
        item.started
          ? { state: 'uncertain', error: '已停止发送，上传创建结果待确认，请检查 Google Drive' }
          : { state: 'cancelled', error: undefined },
      );
      return;
    }
    patch(item, { state: 'cancelling', error: undefined });
    try {
      const path = '/google-drive/uploads/' + encodeURIComponent(item.sessionId);
      const state = await api<GoogleDriveUpload>(path);
      if (item.detached) return;
      if (state.complete) {
        success(item);
        return;
      }
      const result = await send<{ cancelled: boolean; complete?: boolean }>(path, 'DELETE');
      if (item.detached) return;
      if (result.complete) {
        success(item);
        return;
      }
      if (!result.cancelled) throw new Error('取消结果无法确认');
      patch(item, { state: 'cancelled', sessionId: undefined, started: false, error: undefined });
    } catch {
      if (!item.detached) patch(item, { state: 'uncertain', error: '已停止发送，取消结果待确认' });
    }
  }
  async function inspect(id: string) {
    const item = records.current.get(id);
    if (!item?.sessionId || item.detached || item.state !== 'uncertain') return;
    patch(item, { state: 'cancelling' });
    try {
      const state = await api<GoogleDriveUpload>(
        '/google-drive/uploads/' + encodeURIComponent(item.sessionId),
      );
      if (item.detached) return;
      if (state.complete) success(item);
      else
        patch(item, {
          state: 'error',
          progress: item.file.size ? Math.round((state.offset / item.file.size) * 100) : 0,
          error: '上传已停止，可以继续上传或取消',
        });
    } catch (cause) {
      if (!item.detached)
        patch(item, {
          state: 'uncertain',
          error: cause instanceof Error ? cause.message : '上传结果待确认',
        });
    }
  }
  async function run() {
    if (working.current) return;
    working.current = true;
    try {
      while (queue.current.length) {
        const item = records.current.get(queue.current.shift()!);
        if (!item || item.state !== 'queued' || item.detached) continue;
        const controller = new AbortController();
        active.current = { id: item.id, controller };
        patch(item, { state: 'uploading', error: undefined, started: true });
        try {
          await uploadGoogleDriveFile({
            file: item.file,
            parentId: item.parentId,
            connectionId: item.connectionId,
            sessionId: item.sessionId,
            signal: controller.signal,
            onSession: (id) => {
              item.sessionId = id;
            },
            onProgress: (bytes) => {
              if (!item.detached)
                patch(item, {
                  progress: item.file.size ? Math.round((bytes / item.file.size) * 100) : 0,
                });
            },
          });
          success(item);
        } catch (error) {
          if (!item.detached) {
            if (controller.signal.aborted) await removeSession(item);
            else
              patch(item, {
                state: 'error',
                error:
                  !item.sessionId && !(error instanceof ApiError && error.status < 500)
                    ? '上传未确认创建，请先检查 Google Drive，再重新选择文件'
                    : error instanceof Error
                      ? error.message
                      : '上传失败',
              });
          }
        } finally {
          active.current = null;
        }
      }
    } finally {
      working.current = false;
    }
  }
  function add(files: File[], parentId: string, connectionId: string) {
    if (!connectionId) return;
    for (const file of files) {
      const item: DriveUploadItem = {
        id: crypto.randomUUID(),
        file,
        parentId,
        connectionId,
        progress: 0,
        state: 'queued',
      };
      records.current.set(item.id, item);
      queue.current.push(item.id);
    }
    emit();
    void run();
  }
  function cancel(id: string) {
    const item = records.current.get(id);
    if (
      !item ||
      item.detached ||
      !['queued', 'uploading', 'error', 'uncertain'].includes(item.state)
    )
      return;
    if (active.current?.id === id) {
      patch(item, { state: 'cancelling' });
      active.current.controller.abort();
    } else void removeSession(item);
  }
  function retry(id: string) {
    const item = records.current.get(id);
    if (
      !item ||
      item.detached ||
      !['error', 'cancelled'].includes(item.state) ||
      (!item.sessionId && item.started)
    )
      return;
    patch(item, { state: 'queued', error: undefined });
    queue.current.push(id);
    void run();
  }
  function stopForDisconnect() {
    queue.current = [];
    for (const item of records.current.values())
      if (item.state !== 'success')
        Object.assign(item, {
          detached: true,
          state: 'error',
          error: '任务已停止，请先检查 Google Drive 后重新选择文件',
        });
    active.current?.controller.abort();
    emit();
  }
  const busy = items.some((item) => pendingStates.includes(item.state));
  useEffect(() => {
    if (!busy) return;
    const leaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, [busy]);
  return {
    items,
    add,
    cancel,
    retry,
    inspect,
    stopForDisconnect,
    busy,
    clear: () => {
      for (const [id, item] of records.current)
        if (!pendingStates.includes(item.state)) records.current.delete(id);
      emit();
    },
  };
}
