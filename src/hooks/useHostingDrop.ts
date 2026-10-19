import { useEffect, useRef, useState } from 'react';
import { createFileDropHandlers } from '../lib/file-drop';

export function useHostingDrop(options: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  onBlocked: () => void;
}) {
  const current = useRef(options);
  current.current = options;
  const [active, setActive] = useState(false);
  const [controller] = useState(() =>
    createFileDropHandlers({
      disabled: () => current.current.disabled,
      onFiles: (files) => current.current.onFiles(files),
      onBlocked: () => current.current.onBlocked(),
      onActiveChange: setActive,
    }),
  );
  useEffect(() => {
    if (options.disabled) controller.reset();
  }, [options.disabled, controller]);
  useEffect(() => {
    window.addEventListener('blur', controller.reset);
    window.addEventListener('dragend', controller.reset);
    window.addEventListener('drop', controller.reset);
    return () => {
      window.removeEventListener('blur', controller.reset);
      window.removeEventListener('dragend', controller.reset);
      window.removeEventListener('drop', controller.reset);
    };
  }, [controller]);
  const { onDragEnter, onDragOver, onDragLeave, onDrop } = controller;
  return { active, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
