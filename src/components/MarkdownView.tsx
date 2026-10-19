import { useEffect, useRef, useState } from 'react';
import { renderMarkdown, type Heading } from '../../shared/markdown';
import { copy } from '../lib/api';
import { ManualCopy } from './ManualCopy';
export function MarkdownView({ source, fileId }: { source: string; fileId?: string }) {
  const [html, setHtml] = useState(''),
    [headings, setHeadings] = useState<Heading[]>([]),
    [manualCopy, setManualCopy] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    void renderMarkdown(source, (id) =>
      fileId ? `/api/admin/markdown/${fileId}/attachments/${id}` : null,
    ).then((result) => {
      if (active) {
        setHtml(result.html);
        setHeadings(result.headings);
      }
    });
    return () => {
      active = false;
    };
  }, [source, fileId]);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    root.querySelectorAll('pre').forEach((pre) => {
      const button = document.createElement('button');
      button.className = 'code-copy';
      button.textContent = '复制';
      button.onclick = () => {
        const value = pre.querySelector('code')?.textContent ?? '';
        void copy(value).then(
          () => {
            button.textContent = '已复制';
          },
          () => {
            button.textContent = '手动复制';
            setManualCopy(value);
          },
        );
      };
      pre.appendChild(button);
    });
  }, [html]);
  return (
    <>
      <details className="preview-toc">
        <summary>文档目录 · {headings.length}</summary>
        {headings.map((h) => (
          <a key={h.id} href={`#${h.id}`}>
            {h.text}
          </a>
        ))}
      </details>
      <div ref={container} className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      {manualCopy !== null && <ManualCopy value={manualCopy} onClose={() => setManualCopy(null)} />}
    </>
  );
}
