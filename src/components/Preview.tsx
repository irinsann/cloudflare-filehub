import { useEffect, useState } from 'react';
import type { FileRecord } from '../../shared/types';
import { Modal } from './ui/dialog';
import { Button } from './ui/button';
import { api, fileUrl, sizeLabel } from '../lib/api';
import { MarkdownView } from './MarkdownView';
export default function Preview({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (file.mime.startsWith('text/') || file.mime === 'application/json')
      void api<{ content: string }>(`/files/${file.id}/content`)
        .then((r) => setText(r.content))
        .catch((e) => setError(String(e.message)));
  }, [file]);
  const url = fileUrl(file.id, true);
  return (
    <Modal
      title={file.name}
      description={`${file.mime} · ${sizeLabel(file.size)}`}
      onClose={onClose}
      wide
    >
      <div className="file-preview">
        {error ? (
          <p className="error-text">{error}</p>
        ) : file.mime.startsWith('image/') ? (
          <img src={url} alt={file.name} />
        ) : file.mime === 'application/pdf' ? (
          <iframe src={url} title={file.name} />
        ) : file.mime.startsWith('video/') ? (
          <video src={url} controls />
        ) : file.mime.startsWith('audio/') ? (
          <audio src={url} controls />
        ) : text !== null ? (
          file.mime === 'text/markdown' ? (
            <MarkdownView source={text} fileId={file.id} />
          ) : (
            <pre>{text}</pre>
          )
        ) : file.mime.startsWith('text/') || file.mime === 'application/json' ? (
          <p>正在读取文本…</p>
        ) : (
          <div className="empty-state">
            <h3>这个文件适合下载后打开</h3>
            <p>暂不支持此格式的在线预览。</p>
          </div>
        )}
      </div>
      <div className="dialog-footer">
        <Button asChild>
          <a href={fileUrl(file.id)}>下载文件</a>
        </Button>
      </div>
    </Modal>
  );
}
