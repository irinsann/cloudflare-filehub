import { tr } from './i18n';
import { api, ApiError, send } from './api';
import { getLocale } from './i18n';
import type { FileRecord } from '../../shared/types';
export interface UploadReceipt {
  fileId?: string;
}

/** Keep the same receipt for every manual retry, including lost completion responses. */
export async function uploadFileWithReceipt(
  file: File,
  folderId: string | null,
  receipt: UploadReceipt,
  onProgress: (percent: number) => void = () => {},
) {
  if (receipt.fileId) {
    let saved: FileRecord | undefined;
    try {
      saved = await api<FileRecord>('/files/' + receipt.fileId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      // Empty uploads can repeat their idempotent POST with the same client ID.
      // Multipart uploads must never allocate a different file after an uncertain commit.
      if (file.size)
        throw new Error(
          tr(
            '上传结果尚未确认，请稍后重试或在文件列表核对。',
            'The upload result is unconfirmed. Try again shortly or check your files.',
          ),
        );
    }
    if (saved) {
      if (saved.id !== receipt.fileId || saved.status !== 'ready')
        throw new Error(
          tr('文件仍在处理中，请稍后重试', 'The file is still being processed. Try again shortly.'),
        );
      if (
        saved.size !== file.size ||
        saved.name !== file.name ||
        saved.folder_id !== folderId ||
        saved.version !== 1
      )
        throw new Error(
          tr('文件已更改，请在文件列表核对。', 'The file has changed. Check it in your files.'),
        );
      onProgress(100);
      return saved;
    }
  }
  const saved = await uploadFile(
    file,
    folderId,
    onProgress,
    (id) => {
      receipt.fileId = id;
    },
    file.size ? undefined : receipt.fileId,
  );
  receipt.fileId = saved.id;
  return saved;
}

// Drive and image hosting use the same multipart transport and cleanup rules.
export async function uploadFile(
  file: File,
  folderId: string | null,
  onProgress: (percent: number) => void = () => {},
  onAllocatedFile: (id: string | undefined) => void = () => {},
  emptyFileId?: string,
) {
  const session = file.size
    ? await send<{ id: string; fileId: string; partSize: number }>('/uploads', 'POST', {
        name: file.name,
        size: file.size,
        folder_id: folderId,
      })
    : null;
  if (session) onAllocatedFile(session.fileId);
  async function part(path: string, body: Blob, offset: number) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(session ? 'PUT' : 'POST', '/api/admin' + path);
      xhr.setRequestHeader('X-Drive-Request', '1');
      xhr.setRequestHeader('Accept-Language', getLocale());
      xhr.setRequestHeader('X-File-Size', String(body.size));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onProgress(
            Math.min(99, Math.round(((offset + e.loaded) / Math.max(1, file.size)) * 100)),
          );
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          let message = tr('上传失败', 'Upload failed');
          try {
            message = JSON.parse(xhr.responseText).error.message;
          } catch {
            /* Non-JSON gateway failure. */
          }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error(tr('网络连接失败', 'Network connection failed')));
      xhr.timeout = 300000;
      xhr.ontimeout = () => reject(new Error(tr('分片上传超时', 'Upload chunk timed out')));
      xhr.onabort = () => reject(new Error(tr('上传已中断', 'Upload interrupted')));
      xhr.send(body);
    });
  }
  try {
    if (!session) {
      const id = emptyFileId ?? crypto.randomUUID();
      onAllocatedFile(id);
      const params = new URLSearchParams({ name: file.name });
      if (folderId) params.set('folder_id', folderId);
      return await api<FileRecord>('/files/upload?' + params, {
        method: 'POST',
        headers: { 'X-File-Size': '0', 'X-Upload-Id': id },
        body: file,
      });
    }
    for (let offset = 0, n = 1; offset < file.size; offset += session.partSize, n++) {
      for (let attempt = 0; ; attempt++) {
        try {
          await part(
            '/uploads/' + session.id + '/parts/' + n,
            file.slice(offset, offset + session.partSize),
            offset,
          );
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
        }
      }
    }
    let result: FileRecord | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await send<FileRecord>('/uploads/' + session.id + '/complete', 'POST');
        break;
      } catch (error) {
        // A lost response may hide a successful commit. Check its allocated file ID
        // before retrying completion; never re-send the already uploaded parts here.
        const uncertain =
          !(error instanceof ApiError) ||
          error.status >= 500 ||
          [408, 410, 423, 429].includes(error.status);
        if (!uncertain) throw error;
        try {
          const saved = await api<FileRecord>('/files/' + session.fileId);
          if (
            saved.id === session.fileId &&
            saved.status === 'ready' &&
            saved.size === file.size &&
            saved.version === 1
          ) {
            result = saved;
            break;
          }
        } catch {
          /* Still pending or temporarily unavailable; retry the same completion. */
        }
        if (attempt >= 2) throw error;
        const delay = error instanceof ApiError && error.status === 423 ? 2000 : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    onProgress(100);
    return result;
  } catch (error) {
    if (session)
      try {
        const cancelled = await send<{ cancelled?: boolean }>('/uploads/' + session.id, 'DELETE');
        // Only the server's confirmed removal of a pending file permits a fresh
        // allocation. A missing session may hide a committed file.
        if (cancelled?.cancelled) onAllocatedFile(undefined);
      } catch {
        /* The scheduled cleanup handles expired sessions. */
      }
    throw error;
  }
}
