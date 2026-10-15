import type { FileRecord, FolderRecord, PageRecord } from '../shared/types';

const timestamp = Date.UTC(2026, 9, 10, 9);
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const folders: FolderRecord[] = ['Markdown', 'Image-hosting', '设计资料', '旅行记录'].map(
  (name, index) => ({
    id: id(index + 1),
    name,
    parent_id: null,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
  }),
);
const file = (
  number: number,
  name: string,
  mime: string,
  size: number,
  folder_id: string | null = null,
): FileRecord => ({
  id: id(number),
  name,
  mime,
  size,
  folder_id,
  object_key: `preview/${number}`,
  etag: `demo-${number}`,
  version: 1,
  status: 'ready',
  created_at: timestamp,
  updated_at: timestamp + number * 60000,
  deleted_at: null,
});
export const images = Array.from({ length: 10 }, (_, index) =>
  file(
    100 + index,
    (index + 1).toString(16).padStart(32, '0') + '.svg',
    'image/svg+xml',
    1024 + index * 123,
    folders[1].id,
  ),
);
export const files: FileRecord[] = [
  file(20, '项目手记.md', 'text/markdown', 2348, folders[0].id),
  file(21, '周末散步.md', 'text/markdown', 1596, folders[0].id),
  file(22, '配色与字体.txt', 'text/plain', 468, folders[2].id),
  file(23, '城市行程.json', 'application/json', 721, folders[3].id),
  file(24, '欢迎使用 RCloud.txt', 'text/plain', 394),
  file(25, '工作清单.csv', 'text/csv', 238),
  file(26, '海岸线.svg', 'image/svg+xml', 1388),
  { ...file(27, '旧版草稿.txt', 'text/plain', 684), deleted_at: timestamp + 3600000 },
  ...images,
];
export const pages: PageRecord[] = files.slice(0, 2).map((entry, index) => ({
  id: id(200 + index),
  file_id: entry.id,
  title: entry.name.slice(0, -3),
  slug: index === 0 ? 'studio-notes' : 'weekend-walk',
  description: '一段用于浏览界面排版的虚构内容。',
  published: 1,
  published_at: timestamp,
  updated_at: entry.updated_at,
  snapshot_key: null,
  published_version: 1,
  allow_source: 1,
  allow_index: 0,
  views: 128 + index * 73,
}));
export const markdown = `# 项目手记

留下一点空白，让重要的内容更容易被找到。

## 本周安排

- [x] 整理参考资料
- [x] 记录设计方向
- [ ] 完成下一篇文章

![几何构成](/preview/images/0.svg)

## 一张简单的表格

| 项目 | 状态 |
| --- | --- |
| 文档 | 已整理 |
| 图片 | 已归档 |

> 这是界面演示中的示例文字，不包含真实文件。

\`\`\`javascript
const workspace = { name: 'RCloud', mode: 'preview' };
\`\`\`
`;
export function documentText(entry: FileRecord) {
  if (entry.mime === 'text/markdown') return markdown;
  if (entry.mime === 'application/json')
    return JSON.stringify({ city: '示例城市', days: 3, stops: ['公园', '书店', '海边'] }, null, 2);
  if (entry.mime === 'text/csv') return '事项,状态\n整理资料,完成\n记录灵感,进行中\n';
  return 'RCloud 界面演示\n\n这里的文件、图片和统计数字都是虚构示例。\n可以浏览、切换视图、预览文件和编辑本地文字。保存、上传、删除等写入操作不会执行。\n';
}
export function imageSvg(index: number) {
  const palettes = [
    ['#ece9df', '#254f47', '#e5a96e'],
    ['#e7edf5', '#61799a', '#c8d7d5'],
    ['#f1ded0', '#b96249', '#f3bd7b'],
    ['#e8e2ee', '#735e88', '#c6b0d5'],
    ['#dce8df', '#477465', '#acd0ae'],
  ];
  const [background, ink, accent] = palettes[index % palettes.length];
  const shape =
    index % 2 === 0
      ? `<circle cx="${210 + index * 14}" cy="210" r="138" fill="${accent}"/><path d="M0 420 250 170 440 390 640 220V480H0Z" fill="${ink}"/>`
      : `<rect x="120" y="75" width="210" height="330" rx="105" fill="${ink}"/><circle cx="420" cy="280" r="130" fill="${accent}"/><path d="M60 390H580" stroke="${background}" stroke-width="16"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><title>示例几何构成 ${index + 1}</title><rect width="640" height="480" fill="${background}"/>${shape}<text x="30" y="450" fill="${background}" font-family="sans-serif" font-size="14" letter-spacing="4">RCLOUD · ${String(index + 1).padStart(2, '0')}</text></svg>`;
}
