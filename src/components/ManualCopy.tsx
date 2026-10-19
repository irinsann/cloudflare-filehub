import { tr } from '../lib/i18n';
import { useRef } from 'react';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';

export function ManualCopy({ value, onClose }: { value: string; onClose: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  function selectAll() {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }
  return (
    <Modal title={tr('手动复制', 'Copy manually')} onClose={onClose}>
      <div className="form-stack">
        <textarea
          ref={input}
          className="manual-copy-text"
          aria-label={tr('待复制内容', 'Content to copy')}
          value={value}
          readOnly
          autoFocus
          spellCheck={false}
          rows={6}
          onFocus={(event) => event.currentTarget.select()}
        />
        <p>{tr('长按文本复制', 'Press and hold the text to copy')}</p>
        <div className="dialog-footer">
          <Button type="button" variant="outline" onClick={selectAll}>
            {tr('全选', 'Select all')}
          </Button>
          <Button type="button" onClick={onClose}>
            {tr('关闭', 'Close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
