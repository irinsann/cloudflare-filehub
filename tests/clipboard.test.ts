import { afterEach, describe, expect, it, vi } from 'vitest';
import { copy } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('copy compatibility with restricted mobile browsers', () => {
  it('rejects missing clipboard APIs asynchronously so callers can display selectable text', async () => {
    vi.stubGlobal('navigator', {});
    let pending!: Promise<void>;
    expect(() => {
      pending = copy('https://s.irin.im/i/image.png');
    }).not.toThrow();
    await expect(pending).rejects.toThrow('当前浏览器无法自动复制');
  });

  it('preserves the complete selected-domain Markdown when the native clipboard succeeds', async () => {
    const text = '![图片](<https://233334.xyz/i/1234567890abcdef.png>)';
    const clipboard = {
      async writeText(this: unknown, received: string) {
        expect(this).toBe(clipboard);
        expect(received).toBe(text);
      },
    };
    vi.stubGlobal('navigator', { clipboard });
    await expect(copy(text)).resolves.toBeUndefined();
  });

  it('propagates permission rejection without reporting successful copying', async () => {
    const error = new DOMException('Clipboard permission denied', 'NotAllowedError');
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(error) },
    });
    await expect(copy('const x = 1;\n  keep indentation')).rejects.toBe(error);
  });

  it('converts an embedded browser synchronous failure into the same rejected promise', async () => {
    const error = new Error('Clipboard blocked by browser host');
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText() {
          throw error;
        },
      },
    });
    let pending!: Promise<void>;
    expect(() => {
      pending = copy('exact link or code');
    }).not.toThrow();
    await expect(pending).rejects.toBe(error);
  });
});
