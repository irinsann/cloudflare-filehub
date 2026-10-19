import { GOOGLE_DRIVE_CHUNK_SIZE, type GoogleDriveUpload } from '../../shared/google-drive';
import { api, ApiError } from './api';

const root = '/google-drive/uploads';
export const driveUploadRecoverable = (error: unknown) =>
  !(error instanceof ApiError) || [408, 423, 429].includes(error.status) || error.status >= 500;
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

export async function uploadGoogleDriveFile(options: {
  file: File;
  parentId: string;
  connectionId?: string;
  sessionId?: string;
  signal: AbortSignal;
  onSession: (id: string) => void;
  onProgress: (bytes: number) => void;
}) {
  const { file, parentId, signal, onSession, onProgress } = options;
  let state: GoogleDriveUpload | undefined;
  if (options.sessionId) {
    try {
      state = await api<GoogleDriveUpload>(`${root}/${encodeURIComponent(options.sessionId)}`, {
        signal,
      });
    } catch (error) {
      if (error instanceof ApiError && [404, 410].includes(error.status))
        throw new ApiError(
          error.status,
          '上传会话已失效，请先检查 Google Drive 中的文件，再重新选择上传',
        );
      throw error;
    }
  }
  if (!state) {
    state = await api<GoogleDriveUpload>(root, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        name: file.name,
        parentId,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        connectionId: options.connectionId,
      }),
    });
  }
  onSession(state.id);
  const path = `${root}/${encodeURIComponent(state.id)}`;
  let failures = 0;
  while (!state.complete) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > file.size)
      throw new Error('上传进度无效，请刷新后重试');
    onProgress(state.offset);
    const offset: number = state.offset;
    const chunk = file.slice(offset, Math.min(offset + GOOGLE_DRIVE_CHUNK_SIZE, file.size));
    try {
      const next: GoogleDriveUpload = await api<GoogleDriveUpload>(`${path}?offset=${offset}`, {
        method: 'PUT',
        signal,
        body: chunk,
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Size': String(chunk.size) },
      });
      if (!next.complete && next.offset <= offset) throw new Error('上传进度未更新');
      state = next;
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (!driveUploadRecoverable(error) || ++failures > 3) throw error;
      await pause(
        error instanceof ApiError && error.status === 423 ? 2000 : 500 * failures,
        signal,
      );
      // A lost response may already have committed the chunk. Always ask Google
      // for its confirmed offset before sending any bytes again.
      let confirmed: GoogleDriveUpload | undefined;
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        try {
          confirmed = await api<GoogleDriveUpload>(path, { signal });
        } catch (statusError) {
          signal.throwIfAborted();
          if (!driveUploadRecoverable(statusError) || attempt === 2) throw statusError;
          await pause(1000 * (attempt + 1), signal);
        }
      }
      state = confirmed!;
      if (state.offset > offset) failures = 0;
    }
  }
  onProgress(file.size);
  return state.file;
}
