import { api, ApiError, send } from './api';
import type { FileRecord } from '../../shared/types';
// Drive and image hosting use the same multipart transport and cleanup rules.
export async function uploadFile(
  file: File,
  folderId: string | null,
  onProgress: (percent: number) => void = () => {},
) {
  const session = file.size
    ? await send<{ id: string; fileId: string; partSize: number }>('/uploads', 'POST', {
        name: file.name,
        size: file.size,
        folder_id: folderId,
      })
    : null;
  async function part(path: string, body: Blob, offset: number) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(session ? 'PUT' : 'POST', '/api/admin' + path);
      xhr.setRequestHeader('X-Drive-Request', '1');
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
          let message = '上传失败';
          try {
            message = JSON.parse(xhr.responseText).error.message;
          } catch {
            /* Non-JSON gateway failure. */
          }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('网络连接失败'));
      xhr.timeout = 300000;
      xhr.ontimeout = () => reject(new Error('分片上传超时'));
      xhr.onabort = () => reject(new Error('上传已中断'));
      xhr.send(body);
    });
  }
  try {
    if (!session) {
      const params = new URLSearchParams({ name: file.name });
      if (folderId) params.set('folder_id', folderId);
      return await api<FileRecord>('/files/upload?' + params, {
        method: 'POST',
        headers: { 'X-File-Size': '0' },
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
        await send('/uploads/' + session.id, 'DELETE');
      } catch {
        /* The scheduled cleanup handles expired sessions. */
      }
    throw error;
  }
}
