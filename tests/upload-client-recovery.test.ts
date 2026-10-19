import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, send } from '../src/lib/api';
import { uploadFile } from '../src/lib/upload';
import type { FileRecord } from '../shared/types';

vi.mock('../src/lib/api', async (original) => ({
  ...(await original<typeof import('../src/lib/api')>()),
  api: vi.fn(),
  send: vi.fn(),
}));
let parts = 0;
class SuccessfulPart {
  status = 200;
  upload = {};
  onload: () => void = () => {};
  open() {}
  setRequestHeader() {}
  send() {
    parts++;
    queueMicrotask(() => this.onload());
  }
}
const saved = { id: 'file-id', status: 'ready', size: 3, version: 1 } as FileRecord;
beforeEach(() => {
  vi.resetAllMocks();
  parts = 0;
  vi.stubGlobal('XMLHttpRequest', SuccessfulPart);
  vi.mocked(send).mockResolvedValueOnce({ id: 'session-id', fileId: saved.id, partSize: 16 });
  vi.mocked(api).mockRejectedValue(new ApiError(404, 'Still pending'));
});
afterEach(() => vi.unstubAllGlobals());

describe('browser upload completion recovery', () => {
  it('waits through a temporary WebDAV write lease without cancelling uploaded parts', async () => {
    vi.mocked(send)
      .mockRejectedValueOnce(new ApiError(423, 'Another operation is in progress'))
      .mockResolvedValueOnce(saved);
    expect(await uploadFile(new File(['abc'], 'file.bin'), null)).toEqual(saved);
    expect(parts).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalledWith('/uploads/session-id', 'DELETE');
  });

  it('does not confirm an equal-size file overwritten after a lost completion response', async () => {
    const unavailable = new ApiError(410, 'Session completed');
    vi.mocked(send).mockRejectedValue(unavailable);
    vi.mocked(api).mockResolvedValue({ ...saved, version: 2 });
    const progress = vi.fn();
    await expect(uploadFile(new File(['abc'], 'file.bin'), null, progress)).rejects.toBe(
      unavailable,
    );
    expect(progress).not.toHaveBeenCalledWith(100);
    expect(parts).toBe(1);
  });
  it('retries only completion after temporary failure without retransmitting or cancelling parts', async () => {
    vi.mocked(send)
      .mockRejectedValueOnce(new ApiError(500, 'D1 unavailable'))
      .mockResolvedValueOnce(saved);
    const progress = vi.fn();
    expect(await uploadFile(new File(['abc'], 'file.bin'), null, progress)).toEqual(saved);
    expect(parts).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).not.toHaveBeenCalledWith('/uploads/session-id', 'DELETE');
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it('recognizes a committed file when the completion response is lost', async () => {
    vi.mocked(send).mockRejectedValueOnce(new TypeError('Network disconnected'));
    vi.mocked(api).mockResolvedValue(saved);
    expect(await uploadFile(new File(['abc'], 'file.bin'), null)).toEqual(saved);
    expect(send).toHaveBeenCalledTimes(2);
    expect(parts).toBe(1);
  });

  it('does not retry a rejected validation request', async () => {
    const invalid = new ApiError(400, 'Invalid file');
    vi.mocked(send).mockRejectedValueOnce(invalid).mockResolvedValueOnce({});
    await expect(uploadFile(new File(['abc'], 'file.bin'), null)).rejects.toBe(invalid);
    expect(api).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith('/uploads/session-id', 'DELETE');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('bounds retries and leaves failed cleanup to the server instead of reporting success', async () => {
    const unavailable = new ApiError(503, 'Offline');
    vi.mocked(send).mockRejectedValue(unavailable);
    await expect(uploadFile(new File(['abc'], 'file.bin'), null)).rejects.toBe(unavailable);
    expect(parts).toBe(1);
    expect(send).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenLastCalledWith('/uploads/session-id', 'DELETE');
  });

  it('does not mistake a pending or mismatched file for an uploaded result', async () => {
    vi.mocked(send)
      .mockRejectedValueOnce(new ApiError(500, 'Retry'))
      .mockRejectedValueOnce(new ApiError(410, 'Session unavailable'))
      .mockResolvedValueOnce(saved);
    vi.mocked(api)
      .mockResolvedValueOnce({ ...saved, status: 'pending' })
      .mockResolvedValueOnce({ ...saved, size: 4 });
    expect(await uploadFile(new File(['abc'], 'file.bin'), null)).toEqual(saved);
    expect(send).toHaveBeenCalledTimes(4);
    expect(parts).toBe(1);
  });
});
