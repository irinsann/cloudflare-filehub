import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import { visit } from 'unist-util-visit';
import type { Root as MdRoot, Image } from 'mdast';
import type { Root, Element } from 'hast';
export interface Heading {
  id: string;
  text: string;
  depth: number;
}
export function attachmentIds(source: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
  const ids = new Set<string>();
  visit(tree, 'image', (node: Image) => {
    const m = /^attachment:([0-9a-f-]{36})$/.exec(node.url);
    if (m) ids.add(m[1]);
  });
  return [...ids];
}
export async function renderMarkdown(
  source: string,
  resolveAttachment?: (id: string) => string | null,
) {
  const headings: Heading[] = [];
  const rewrite = () => (tree: MdRoot) => {
    visit(tree, 'image', (node: Image) => {
      const m = /^attachment:([0-9a-f-]{36})$/.exec(node.url);
      if (m) node.url = resolveAttachment?.(m[1]) ?? '';
      else if (!/^https:\/\//i.test(node.url)) node.url = '';
    });
  };
  const collect = () => (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (/^h[1-6]$/.test(node.tagName)) {
        const parts: string[] = [];
        visit(node, 'text', (t) => {
          parts.push(t.value);
        });
        headings.push({
          id: String(node.properties.id ?? ''),
          text: parts.join(''),
          depth: Number(node.tagName[1]),
        });
      }
      if (node.tagName === 'a') {
        node.properties.rel = ['noopener', 'noreferrer'];
      }
      if (node.tagName === 'img') {
        node.properties.loading = 'lazy';
        node.properties.referrerPolicy = 'no-referrer';
      }
    });
  };
  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(rewrite)
    .use(remarkRehype)
    .use(rehypeSanitize, {
      ...defaultSchema,
      attributes: {
        ...defaultSchema.attributes,
        code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-/]],
      },
    })
    .use(rehypeSlug)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(collect)
    .use(rehypeStringify)
    .process(source);
  return { html: String(result), headings };
}
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
