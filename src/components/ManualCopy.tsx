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
    <Modal title="手动复制" onClose={onClose}>
      <div className="form-stack">
        <textarea
          ref={input}
          className="manual-copy-text"
          aria-label="待复制内容"
          value={value}
          readOnly
          autoFocus
          spellCheck={false}
          rows={6}
          onFocus={(event) => event.currentTarget.select()}
        />
        <p>长按文本复制</p>
        <div className="dialog-footer">
          <Button type="button" variant="outline" onClick={selectAll}>
            全选
          </Button>
          <Button type="button" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
}
