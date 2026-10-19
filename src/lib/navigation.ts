import { tr } from './i18n';
import {
  FolderOpen,
  Clock3,
  FileText,
  Globe2,
  Link2,
  Image,
  Trash2,
  Settings2,
  FileCode2,
} from 'lucide-react';
export const sections = [
  {
    id: 'files',
    get label() {
      return tr('我的文件', 'My files');
    },
    icon: FolderOpen,
  },
  {
    id: 'recent',
    get label() {
      return tr('最近文件', 'Recent files');
    },
    icon: Clock3,
  },
  {
    id: 'markdown',
    get label() {
      return tr('Markdown 文档', 'Markdown');
    },
    icon: FileText,
  },
  {
    id: 'published',
    get label() {
      return tr('已发布文章', 'Published articles');
    },
    icon: Globe2,
  },
  {
    id: 'shares',
    get label() {
      return tr('分享', 'Shares');
    },
    icon: Link2,
  },
  {
    id: 'images',
    get label() {
      return tr('Image 托管', 'Image hosting');
    },
    icon: Image,
  },
  {
    id: 'html',
    get label() {
      return tr('HTML 托管', 'HTML hosting');
    },
    icon: FileCode2,
  },
  {
    id: 'trash',
    get label() {
      return tr('回收站', 'Trash');
    },
    icon: Trash2,
  },
  {
    id: 'settings',
    get label() {
      return tr('设置', 'Settings');
    },
    icon: Settings2,
  },
] as const;
export type View = (typeof sections)[number]['id'];
