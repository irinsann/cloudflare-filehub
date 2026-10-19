import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, send } from '../src/lib/api';
import { uploadFile } from '../src/lib/upload';
import { uploadHostedHtml, type HtmlUploadReceipt } from '../src/lib/html-upload';
import type { FileRecord } from '../shared/types';

vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  api: vi.fn(),
  send: vi.fn(),
}));
vi.mock('../src/lib/upload', () => ({ uploadFile: vi.fn() }));
const file = new File(['<h1>hello</h1>'], 'hello.html', { type: 'text/html' });
const stored = {
  id: 'html-file',
  name: file.name,
  size: file.size,
  version: 1,
  status: 'ready',
} as FileRecord;
const shared = { file_id: stored.id, share_id: 'same-share', enabled: true, version: 0 };
let folder = vi.fn(async () => 'html-folder');
beforeEach(() => {
  vi.resetAllMocks();
  folder = vi.fn(async () => 'html-folder');
  vi.mocked(uploadFile).mockImplementation(async (_file, _folder, progress, allocation) => {
    allocation?.(stored.id);
    progress?.(100);
    return stored;
  });
  vi.mocked(api).mockResolvedValue(stored);
  vi.mocked(send).mockResolvedValue(shared);
});
describe('HTML hosting upload receipt recovery', () => {
  it('uploads once into the resolved folder and publishes the allocated file', async () => {
    const receipt: HtmlUploadReceipt = {},
      progress = vi.fn();
    expect(await uploadHostedHtml(file, receipt, { folder, progress })).toEqual(shared);
    expect(receipt.fileId).toBe(stored.id);
    expect(folder).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledWith(
      file,
      'html-folder',
      expect.any(Function),
      expect.any(Function),
    );
    expect(send).toHaveBeenCalledWith('/html-hosting', 'POST', { file_id: stored.id });
    expect(progress.mock.calls).toEqual([[100], [null]]);
  });
  it('retries a lost publication response with the same file and share identity', async () => {
    const receipt: HtmlUploadReceipt = {},
      options = { folder, progress: vi.fn() };
    vi.mocked(send).mockRejectedValueOnce(new TypeError('Connection lost'));
    await expect(uploadHostedHtml(file, receipt, options)).rejects.toThrow('Connection lost');
    expect(await uploadHostedHtml(file, receipt, options)).toEqual(shared);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(folder).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenNthCalledWith(1, '/html-hosting', 'POST', { file_id: stored.id });
    expect(send).toHaveBeenNthCalledWith(2, '/html-hosting', 'POST', { file_id: stored.id });
  });
  it('recovers a completed upload after a lost upload response without resending bytes', async () => {
    const receipt: HtmlUploadReceipt = {},
      options = { folder, progress: vi.fn() };
    vi.mocked(uploadFile).mockImplementationOnce(async (_file, _folder, _progress, allocation) => {
      allocation?.(stored.id);
      throw new TypeError('Upload result lost');
    });
    await expect(uploadHostedHtml(file, receipt, options)).rejects.toThrow('Upload result lost');
    expect(await uploadHostedHtml(file, receipt, options)).toEqual(shared);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/files/html-file');
  });
  it.each([404, 500, 503])(
    'does not allocate another file after an uncertain lookup (%s)',
    async (status) => {
      const receipt = { fileId: stored.id };
      vi.mocked(api).mockRejectedValue(new ApiError(status, 'Uncertain'));
      await expect(
        uploadHostedHtml(file, receipt, { folder, progress: vi.fn() }),
      ).rejects.toThrow();
      expect(receipt.fileId).toBe(stored.id);
      expect(folder).not.toHaveBeenCalled();
      expect(uploadFile).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: 'pending' },
    { size: file.size + 1 },
    { version: 2 },
    { name: 'changed.html' },
  ])('does not publish pending or changed content (%j)', async (patch) => {
    vi.mocked(api).mockResolvedValue({ ...stored, ...patch });
    await expect(
      uploadHostedHtml(file, { fileId: stored.id }, { folder, progress: vi.fn() }),
    ).rejects.toThrow();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves a revoked share returned by an idempotent retry', async () => {
    vi.mocked(send).mockResolvedValue({ ...shared, enabled: false, version: 1 });
    expect(
      await uploadHostedHtml(file, { fileId: stored.id }, { folder, progress: vi.fn() }),
    ).toMatchObject({ enabled: false, version: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
  });
  it('permits a fresh allocation only when the transport confirms the pending file was cancelled', async () => {
    const receipt: HtmlUploadReceipt = {},
      options = { folder, progress: vi.fn() };
    vi.mocked(uploadFile).mockImplementationOnce(async (_file, _folder, _progress, allocation) => {
      allocation?.(stored.id);
      allocation?.(undefined);
      throw new Error('Cancelled');
    });
    await expect(uploadHostedHtml(file, receipt, options)).rejects.toThrow('Cancelled');
    expect(receipt.fileId).toBeUndefined();
    await uploadHostedHtml(file, receipt, options);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(api).not.toHaveBeenCalled();
  });
  it('rejects invalid selections before creating any folder or file', async () => {
    for (const invalid of [new File([], 'empty.html'), new File(['text'], 'a.txt')])
      await expect(uploadHostedHtml(invalid, {}, { folder, progress: vi.fn() })).rejects.toThrow();
    expect(folder).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
