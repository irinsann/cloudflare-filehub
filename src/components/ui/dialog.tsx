import { tr } from '../../lib/i18n';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const descriptionId = useId();
  const previousFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog-content ${wide ? 'dialog-wide' : ''}`}
          aria-describedby={description ? descriptionId : undefined}
          onCloseAutoFocus={(e) => {
            if (previousFocus.current?.isConnected) {
              e.preventDefault();
              previousFocus.current.focus();
            }
          }}
        >
          <header className="dialog-header">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description id={descriptionId}>{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="button button-ghost button-icon"
              aria-label={tr('关闭', 'Close')}
            >
              <X size={18} />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
