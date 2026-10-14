import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/api';
import { loadImageGallery } from '../src/lib/image-gallery';

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: vi.fn(),
}));

const images = (start: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `image-${start + index}`, views: 0 }));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('complete image gallery loading', () => {
  it('reads every page until a short page, deduplicating names and reporting unique progress', async () => {
    const signal = new AbortController().signal;
    const progress = vi.fn();
    vi.mocked(api)
      .mockResolvedValueOnce(images(0, 40))
      .mockResolvedValueOnce(images(20, 40).map((image) => ({ ...image, views: 3 })))
      .mockResolvedValueOnce(images(60, 1));
    const result = await loadImageGallery<{ name: string; views: number }>(signal, progress);
    expect(result).toHaveLength(61);
    expect(result[20]).toEqual({ name: 'image-20', views: 3 });
    expect(result.at(-1)?.name).toBe('image-60');
    expect(progress.mock.calls).toEqual([[40], [60], [61]]);
    expect(vi.mocked(api).mock.calls).toEqual([
      ['/images?page=1', { signal }],
      ['/images?page=2', { signal }],
      ['/images?page=3', { signal }],
    ]);
  });

  it('checks the empty final page when the total is an exact multiple of forty', async () => {
    vi.mocked(api).mockResolvedValueOnce(images(0, 40)).mockResolvedValueOnce([]);
    await expect(loadImageGallery(new AbortController().signal)).resolves.toHaveLength(40);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('waits sixty seconds for 429 then retries the same page without losing earlier pages', async () => {
    vi.useFakeTimers();
    vi.mocked(api)
      .mockResolvedValueOnce(images(0, 40))
      .mockRejectedValueOnce(new ApiError(429, 'Rate limited'))
      .mockResolvedValueOnce(images(40, 1));
    const signal = new AbortController().signal;
    const result = loadImageGallery(signal);
    const completion = expect(result).resolves.toHaveLength(41);
    await vi.advanceTimersByTimeAsync(59999);
    expect(api).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await completion;
    expect(api).toHaveBeenNthCalledWith(2, '/images?page=2', { signal });
    expect(api).toHaveBeenNthCalledWith(3, '/images?page=2', { signal });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after two retries on one rate-limited page with a useful error', async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockRejectedValue(new ApiError(429, 'Rate limited'));
    const completion = expect(loadImageGallery(new AbortController().signal)).rejects.toThrow(
      '请稍后重试',
    );
    await vi.advanceTimersByTimeAsync(120000);
    await completion;
    expect(api).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending cooldown immediately and removes its timer and abort listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const progress = vi.fn();
    vi.mocked(api).mockRejectedValueOnce(new ApiError(429, 'Rate limited'));
    const completion = expect(loadImageGallery(controller.signal, progress)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await completion;
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    await vi.advanceTimersByTimeAsync(120000);
    expect(api).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });

  it('does not request any page after an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadImageGallery(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(api).not.toHaveBeenCalled();
  });

  it('ignores a late response after cancellation without progress or the next page', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    let resolvePage!: (value: { name: string; views: number }[]) => void;
    vi.mocked(api).mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    const completion = expect(loadImageGallery(controller.signal, progress)).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    resolvePage(images(0, 40));
    await completion;
    expect(api).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });

  it('propagates ordinary failures without retrying or returning an incomplete gallery', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(images(0, 40))
      .mockRejectedValueOnce(new ApiError(500, 'Unavailable'));
    await expect(loadImageGallery(new AbortController().signal)).rejects.toThrow('Unavailable');
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('stops a repeated full page instead of continuing forever', async () => {
    vi.mocked(api).mockResolvedValue(images(0, 40));
    await expect(loadImageGallery(new AbortController().signal)).rejects.toThrow(
      '分页重复，请刷新后重试',
    );
    expect(api).toHaveBeenCalledTimes(2);
  });
});
