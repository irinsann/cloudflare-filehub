import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/api';
import { uploadGoogleDriveFile } from '../src/lib/google-drive-upload';
import type { GoogleDriveUpload } from '../shared/google-drive';

vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  api: vi.fn(),
}));

const session = (offset = 0, complete = false): GoogleDriveUpload => ({
  id: 'test-session',
  offset,
  chunkSize: 16 * 1024 * 1024,
  complete,
  ...(complete ? { file: { id: 'google-file', name: 'note.txt', mimeType: 'text/plain' } } : {}),
});
const options = () => ({
  file: new File(['abc'], 'note.txt', { type: 'text/plain' }),
  parentId: 'root',
  signal: new AbortController().signal,
  onSession: vi.fn(),
  onProgress: vi.fn(),
});
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('Google resumable client recovery', () => {
  it('recognizes a lost final response without uploading the bytes twice', async () => {
    vi.useFakeTimers();
    vi.mocked(api)
      .mockResolvedValueOnce(session())
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(session(3, true));
    const input = options();
    const done = expect(uploadGoogleDriveFile(input)).resolves.toMatchObject({ id: 'google-file' });
    await vi.runAllTimersAsync();
    await done;
    expect(vi.mocked(api).mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
      ['/google-drive/uploads', 'POST'],
      ['/google-drive/uploads/test-session?offset=0', 'PUT'],
      ['/google-drive/uploads/test-session', 'GET'],
    ]);
    expect(input.onProgress).toHaveBeenLastCalledWith(3);
  });

  it('resumes at the confirmed remote offset after partial acceptance', async () => {
    vi.useFakeTimers();
    vi.mocked(api)
      .mockResolvedValueOnce(session())
      .mockRejectedValueOnce(new ApiError(502, 'upstream disconnected'))
      .mockResolvedValueOnce(session(2))
      .mockResolvedValueOnce(session(3, true));
    const done = expect(uploadGoogleDriveFile(options())).resolves.toMatchObject({
      id: 'google-file',
    });
    await vi.runAllTimersAsync();
    await done;
    const [path, init] = vi.mocked(api).mock.calls[3];
    expect(path).toBe('/google-drive/uploads/test-session?offset=2');
    expect(await (init!.body as Blob).text()).toBe('c');
  });

  it('does not retry a write refused by Google permissions', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(session())
      .mockRejectedValueOnce(new ApiError(403, 'file is read only'));
    await expect(uploadGoogleDriveFile(options())).rejects.toMatchObject({ status: 403 });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('does not silently recreate an expired session that might have finished remotely', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(410, 'upload result must be checked'));
    await expect(
      uploadGoogleDriveFile({ ...options(), sessionId: 'old-session' }),
    ).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls[0][0]).toBe('/google-drive/uploads/old-session');
  });

  it('stops before any recovery request when cancelled during retry backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.mocked(api)
      .mockResolvedValueOnce(session())
      .mockRejectedValueOnce(new ApiError(429, 'rate limit'));
    const done = expect(
      uploadGoogleDriveFile({ ...options(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await done;
    await vi.runAllTimersAsync();
    expect(api).toHaveBeenCalledTimes(2);
  });
});
