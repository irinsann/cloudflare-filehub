import type { FileRecord } from '../../shared/types';
import type { HtmlHostingItem } from '../../shared/html-hosting';
import { api, ApiError, send } from './api';
import { tr } from './i18n';
import { uploadFile } from './upload';

export interface HtmlUploadReceipt {
  fileId?: string;
}
export interface HtmlUploadOptions {
  folder: () => Promise<string>;
  progress: (value: number | null) => void;
}

/** Keep this receipt for every retry. A missing response is never a fresh upload. */
export async function uploadHostedHtml(
  file: File,
  receipt: HtmlUploadReceipt,
  options: HtmlUploadOptions,
): Promise<HtmlHostingItem> {
  if (!/\.html?$/i.test(file.name) || !file.size)
    throw new Error(tr('请选择非空 HTML 文件', 'Choose a non-empty HTML file'));
  if (receipt.fileId) {
    let saved: FileRecord;
    try {
      saved = await api<FileRecord>('/files/' + receipt.fileId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        throw new Error(
          tr(
            '上传结果尚未确认，请稍后重试或在文件列表核对。',
            'The upload result is unconfirmed. Try again shortly or check your files.',
          ),
        );
      throw error;
    }
    if (saved.id !== receipt.fileId || saved.status !== 'ready')
      throw new Error(
        tr('文件仍在处理中，请稍后重试', 'The file is still being processed. Try again shortly.'),
      );
    if (saved.size !== file.size || saved.name !== file.name || saved.version !== 1)
      throw new Error(
        tr(
          '文件已更改，请在文件列表核对后分享。',
          'The file has changed. Check it in your files before sharing.',
        ),
      );
  } else {
    const stored = await uploadFile(
      file,
      await options.folder(),
      (value) => options.progress(value),
      (id) => {
        receipt.fileId = id;
      },
    );
    receipt.fileId = stored.id;
  }
  options.progress(null);
  // The backend resolves this file to its existing share, including revoked shares.
  return send<HtmlHostingItem>('/html-hosting', 'POST', { file_id: receipt.fileId });
}
