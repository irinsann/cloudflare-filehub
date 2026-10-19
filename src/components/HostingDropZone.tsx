import { ImagePlus, FileCode2, Upload } from 'lucide-react';
import { tr } from '../lib/i18n';
import { Button } from './ui/button';

export function HostingDropZone({
  kind,
  active,
  busy,
  disabled,
  onChoose,
  detail,
}: {
  kind: 'image' | 'html';
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
  detail?: string;
}) {
  const image = kind === 'image',
    Icon = image ? ImagePlus : FileCode2;
  return (
    <div className={`hosting-drop hosting-drop-${kind}`}>
      <span className="hosting-emblem" aria-hidden="true">
        <Icon size={27} strokeWidth={1.7} />
      </span>
      <div className="hosting-drop-copy">
        <h2>
          {active
            ? tr('松开即可上传', 'Drop to upload')
            : image
              ? tr('上传图片', 'Upload images')
              : tr('上传 HTML', 'Upload HTML')}
        </h2>
        <p>
          {image
            ? tr('拖拽图片到此处', 'Drag images here')
            : tr('拖拽 HTML 文件到此处', 'Drag HTML files here')}
        </p>
        <small>
          {image ? 'PNG · JPEG · GIF · WebP' : 'HTML · HTM'}
          {detail ? ` · ${detail}` : ''}
        </small>
      </div>
      <Button disabled={disabled} onClick={onChoose}>
        <Upload size={16} />
        {busy
          ? tr('上传中…', 'Uploading…')
          : image
            ? tr('选择图片', 'Choose images')
            : tr('选择 HTML', 'Choose HTML')}
      </Button>
    </div>
  );
}
