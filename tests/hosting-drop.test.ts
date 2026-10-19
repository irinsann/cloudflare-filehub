import { describe, expect, it, vi } from 'vitest';
import { createFileDropHandlers } from '../src/lib/file-drop';

function event(files: File[] = [], types = ['Files']) {
  return {
    dataTransfer: { types, files, dropEffect: 'none' },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}
function harness() {
  let disabled = false;
  const onFiles = vi.fn(),
    onActiveChange = vi.fn(),
    onBlocked = vi.fn();
  const handlers = createFileDropHandlers({
    disabled: () => disabled,
    onFiles,
    onActiveChange,
    onBlocked,
  });
  return {
    handlers,
    onFiles,
    onActiveChange,
    onBlocked,
    disable: () => {
      disabled = true;
    },
  };
}

describe('hosting drop routing and interaction', () => {
  it('keeps the highlight across nested children and uploads a multi-file drop once without reaching ordinary uploads', () => {
    const h = harness();
    // Browsers hide the actual files during dragenter, exposing only the Files type.
    h.handlers.onDragEnter(event());
    h.handlers.onDragEnter(event());
    h.handlers.onDragLeave(event());
    expect(h.onActiveChange.mock.calls).toEqual([[true]]);
    const images = [new File(['a'], 'a.png'), new File(['b'], 'b.png')];
    const dropped = event(images);
    const ordinaryUpload = vi.fn();
    h.handlers.onDrop(dropped);
    if (!dropped.stopPropagation.mock.calls.length) ordinaryUpload(images);
    expect(h.onFiles).toHaveBeenCalledExactlyOnceWith(images);
    expect(ordinaryUpload).not.toHaveBeenCalled();
    expect(dropped.preventDefault).toHaveBeenCalledOnce();
    expect(dropped.dataTransfer.dropEffect).toBe('copy');
    expect(h.onActiveChange.mock.calls).toEqual([[true], [false]]);
  });

  it('rejects a drop when the page became busy after dragenter and still prevents browser navigation', () => {
    const h = harness();
    h.handlers.onDragEnter(event());
    h.disable();
    const over = event();
    h.handlers.onDragOver(over);
    expect(over.dataTransfer.dropEffect).toBe('none');
    const dropped = event([new File(['<h1>Page</h1>'], 'page.html')]);
    h.handlers.onDrop(dropped);
    expect(h.onFiles).not.toHaveBeenCalled();
    expect(h.onBlocked).toHaveBeenCalledOnce();
    expect(dropped.preventDefault).toHaveBeenCalledOnce();
    expect(dropped.stopPropagation).toHaveBeenCalledOnce();
    expect(h.onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it('leaves ordinary text/link dragging alone', () => {
    const h = harness();
    const text = event([], ['text/plain', 'text/uri-list']);
    h.handlers.onDragEnter(text);
    h.handlers.onDragOver(text);
    h.handlers.onDrop(text);
    expect(text.preventDefault).not.toHaveBeenCalled();
    expect(text.stopPropagation).not.toHaveBeenCalled();
    expect(h.onFiles).not.toHaveBeenCalled();
    expect(h.onActiveChange).not.toHaveBeenCalled();
  });

  it('clears cancelled drags and does not retain nested depth into the next drag', () => {
    const h = harness();
    h.handlers.onDragEnter(event());
    h.handlers.onDragEnter(event());
    h.handlers.reset();
    h.handlers.onDragEnter(event());
    h.handlers.onDragLeave(event());
    expect(h.onActiveChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    h.handlers.onDrop(event());
    expect(h.onFiles).not.toHaveBeenCalled();
  });
});
