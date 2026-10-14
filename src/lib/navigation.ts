import {
  FolderOpen,
  Clock3,
  FileText,
  Globe2,
  Link2,
  Image,
  Trash2,
  Settings2,
} from 'lucide-react';
export const sections = [
  { id: 'files', label: '我的文件', icon: FolderOpen },
  { id: 'recent', label: '最近文件', icon: Clock3 },
  { id: 'markdown', label: 'Markdown 文档', icon: FileText },
  { id: 'published', label: '已发布文章', icon: Globe2 },
  { id: 'shares', label: '文件分享', icon: Link2 },
  { id: 'images', label: '图床', icon: Image },
  { id: 'trash', label: '回收站', icon: Trash2 },
  { id: 'settings', label: '设置', icon: Settings2 },
] as const;
export type View = (typeof sections)[number]['id'];
