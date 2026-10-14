import { api, ApiError } from './api';

const pageSize = 40;
const maxPage = 100000;
const retryDelay = 60000;

function waitForRetry(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, retryDelay);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function readPage<T>(page: number, signal: AbortSignal) {
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    try {
      return await api<T[]>('/images?page=' + page, { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ApiError) || error.status !== 429) throw error;
      if (retry >= 2) throw new Error('图片列表请求过于频繁，请稍后重试');
      await waitForRetry(signal);
    }
  }
}

export async function loadImageGallery<T extends { name: string }>(
  signal: AbortSignal,
  onProgress?: (count: number) => void,
): Promise<T[]> {
  const images = new Map<string, T>();
  for (let page = 1; page <= maxPage; page++) {
    const next = await readPage<T>(page, signal);
    signal.throwIfAborted();
    const previousCount = images.size;
    for (const image of next) images.set(image.name, image);
    if (next.length >= pageSize && images.size === previousCount)
      throw new Error('图片列表分页重复，请刷新后重试');
    onProgress?.(images.size);
    signal.throwIfAborted();
    if (next.length < pageSize) return [...images.values()];
  }
  throw new Error('图片列表超过分页范围，请刷新后重试');
}
