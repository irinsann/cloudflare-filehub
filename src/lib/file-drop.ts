interface FileDropEvent {
  dataTransfer: {
    types: readonly string[];
    files: ArrayLike<File>;
    dropEffect: string;
  };
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function createFileDropHandlers(options: {
  disabled: () => boolean;
  onFiles: (files: File[]) => void;
  onActiveChange: (active: boolean) => void;
  onBlocked: () => void;
}) {
  let depth = 0,
    active = false;
  const setActive = (next: boolean) => {
    if (next !== active) options.onActiveChange(next);
    active = next;
  };
  const reset = () => {
    depth = 0;
    setActive(false);
  };
  const isFiles = (event: FileDropEvent) =>
    event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0;
  const consume = (event: FileDropEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = options.disabled() ? 'none' : 'copy';
  };
  return {
    reset,
    onDragEnter(event: FileDropEvent) {
      if (!isFiles(event)) return;
      consume(event);
      depth++;
      setActive(!options.disabled());
    },
    onDragOver(event: FileDropEvent) {
      if (!isFiles(event)) return;
      consume(event);
    },
    onDragLeave(event: FileDropEvent) {
      if (!depth) return;
      consume(event);
      depth = Math.max(0, depth - 1);
      if (!depth) setActive(false);
    },
    onDrop(event: FileDropEvent) {
      if (!isFiles(event)) return;
      consume(event);
      reset();
      if (!event.dataTransfer.files.length) return;
      if (options.disabled()) options.onBlocked();
      else options.onFiles(Array.from(event.dataTransfer.files));
    },
  };
}
