import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardImages, imageMarkdown, uploadHostedImage } from '../src/lib/image-upload';
import { send } from '../src/lib/api';
import { uploadFile } from '../src/lib/upload';
import type { FileRecord } from '../shared/types';
import { renderMarkdown } from '../shared/markdown';

vi.mock('../src/lib/api', () => ({ send: vi.fn() }));
vi.mock('../src/lib/upload', () => ({ uploadFile: vi.fn() }));

const image = () => new File(['image-bytes'], 'screenshot.png', { type: 'image/png' });
const published = {
  name: '39dd1aed58e76c360216335fda25d0cf.png',
  file_id: 'uploaded-file',
  url: 'https://s.irin.im/i/39dd1aed58e76c360216335fda25d0cf.png',
  duplicate: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(uploadFile).mockResolvedValue({ id: 'uploaded-file' } as FileRecord);
});

describe('shared browser image uploads', () => {
  it('uses the normal multipart uploader and publishes its returned file in Image-hosting', async () => {
    vi.mocked(send).mockResolvedValueOnce({ id: 'image-folder' }).mockResolvedValueOnce(published);
    const file = image();
    const progress = vi.fn();
    expect(await uploadHostedImage(file, progress)).toEqual(published);
    expect(send).toHaveBeenNthCalledWith(1, '/images/folder', 'POST');
    expect(uploadFile).toHaveBeenCalledWith(file, 'image-folder', progress);
    expect(send).toHaveBeenNthCalledWith(2, '/images', 'POST', { file_id: 'uploaded-file' });
    expect(progress).toHaveBeenCalledWith(null);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('accepts clipboard images without extensions and rejects empty or unsupported files early', async () => {
    await expect(uploadHostedImage(new File([], 'empty.png'))).rejects.toThrow('图片为空');
    await expect(
      uploadHostedImage(new File(['svg'], 'unsafe.svg', { type: 'image/svg+xml' })),
    ).rejects.toThrow('仅支持');
    expect(send).not.toHaveBeenCalled();
    vi.mocked(send).mockResolvedValueOnce({ id: 'image-folder' }).mockResolvedValueOnce(published);
    await expect(
      uploadHostedImage(new File(['png'], 'clipboard', { type: 'image/png' })),
    ).resolves.toEqual(published);
  });

  it('removes only the redundant source when the server reuses an existing image', async () => {
    vi.mocked(send)
      .mockResolvedValueOnce({ id: 'image-folder' })
      .mockResolvedValueOnce({ ...published, file_id: 'existing-image', duplicate: true })
      .mockResolvedValue({ ok: true });
    const result = await uploadHostedImage(image());
    expect(result.file_id).toBe('existing-image');
    expect(send).toHaveBeenNthCalledWith(3, '/files/uploaded-file', 'DELETE');
    expect(send).toHaveBeenNthCalledWith(4, '/files/uploaded-file/permanent', 'DELETE');
    expect(send).not.toHaveBeenCalledWith('/files/existing-image', 'DELETE');
  });

  it('retains the valid link and reports cleanup failure instead of losing a successful upload', async () => {
    vi.mocked(send)
      .mockResolvedValueOnce({ id: 'image-folder' })
      .mockResolvedValueOnce({ ...published, file_id: 'existing-image', duplicate: true })
      .mockRejectedValueOnce(new Error('Network offline'));
    const result = await uploadHostedImage(image());
    expect(result.url).toBe(published.url);
    expect(result.cleanupWarning).toContain('清理失败');
  });

  it('does not delete an upload when the publish response is lost or its state is uncertain', async () => {
    vi.mocked(send)
      .mockResolvedValueOnce({ id: 'image-folder' })
      .mockRejectedValueOnce(new Error('Publish response lost'));
    await expect(uploadHostedImage(image())).rejects.toThrow('Publish response lost');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('Markdown image insertion', () => {
  it('escapes filenames without creating nested image, link or HTML syntax', async () => {
    const name = '截图[1]\\\n![other](https://bad.test) <img> &copy; *.png';
    const source = imageMarkdown(name, published.url);
    const rendered = await renderMarkdown(source, () => null);
    expect(rendered.html.match(/<img\s+src="/g), rendered.html).toHaveLength(1);
    expect(rendered.html).toContain(`src="${published.url}"`);
    expect(rendered.html).toContain('截图[1]\\ ![other](https://bad.test)');
    expect(rendered.html).toContain('&#x26;copy;');
    expect(rendered.html).not.toContain('<a ');
    expect(source).not.toContain('\n');
  });

  it('encodes whitespace and angle brackets in the Markdown destination', () => {
    expect(imageMarkdown('image', 'https://s.irin.im/i/a b<1>.png')).toBe(
      '![image](<https://s.irin.im/i/a%20b%3C1%3E.png>)',
    );
  });

  it('leaves ordinary text paste untouched even if the clipboard also carries an image', () => {
    const data = {
      getData: () => 'ordinary text',
      get items(): DataTransferItemList {
        throw new Error('Image items must not be inspected');
      },
      files: [] as unknown as FileList,
    };
    expect(clipboardImages(data)).toEqual([]);
  });

  it('collects clipboard image items once, ignoring string and other file items', () => {
    const first = image();
    const second = new File(['gif'], 'animated.gif', { type: 'image/gif' });
    const data = {
      getData: () => '',
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => first },
        { kind: 'string', type: 'text/html', getAsFile: () => null },
        { kind: 'file', type: 'application/pdf', getAsFile: () => new File(['pdf'], 'file.pdf') },
        { kind: 'file', type: 'image/gif', getAsFile: () => second },
      ] as unknown as DataTransferItemList,
      files: [first, second] as unknown as FileList,
    };
    expect(clipboardImages(data)).toEqual([first, second]);
  });
});
