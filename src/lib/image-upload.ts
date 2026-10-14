import { send } from './api';
import { uploadFile } from './upload';

export interface HostedImage {
  name: string;
  file_id: string;
  url: string;
  duplicate: boolean;
  cleanupWarning?: string;
}

const imageName = /\.(png|jpe?g|gif|webp)$/i;
const imageType = /^image\/(png|jpeg|gif|webp)$/i;

export async function uploadHostedImage(
  file: File,
  onProgress: (percent: number | null) => void = () => {},
): Promise<HostedImage> {
  if (!imageName.test(file.name) && !imageType.test(file.type)) {
    throw new Error('仅支持 PNG、JPEG、GIF 和 WebP 图片');
  }
  if (!file.size) throw new Error('图片为空');

  const folder = await send<{ id: string }>('/images/folder', 'POST');
  const uploaded = await uploadFile(file, folder.id, onProgress);
  onProgress(null);
  const result = await send<HostedImage>('/images', 'POST', { file_id: uploaded.id });
  if (result.duplicate && result.file_id !== uploaded.id) {
    try {
      await send('/files/' + uploaded.id, 'DELETE');
      await send('/files/' + uploaded.id + '/permanent', 'DELETE');
    } catch {
      // A valid image URL must remain usable even if removal of its redundant source fails.
      return { ...result, cleanupWarning: '重复源文件清理失败，请在云盘中检查' };
    }
  }
  return result;
}

export function imageMarkdown(name: string, url: string) {
  const alt = name.replace(/[\r\n]+/g, ' ').replace(/[\\[\]`*_<>!&]/g, '\\$&');
  const destination = url.replace(/[<>\s\\]/g, (character) => encodeURIComponent(character));
  return `![${alt}](<${destination}>)`;
}

export function clipboardImages(data: Pick<DataTransfer, 'getData' | 'items' | 'files'>): File[] {
  if (data.getData('text/plain')) return [];
  const images = Array.from(data.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return images.length
    ? images
    : Array.from(data.files).filter((file) => file.type.startsWith('image/'));
}
