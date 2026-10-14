import { useCallback, useEffect, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  ArrowLeft,
  Save,
  Globe,
  ImagePlus,
  Bold,
  Italic,
  Link,
  List,
  Code2,
  Check,
  ExternalLink,
  Eye,
  PanelLeft,
} from 'lucide-react';
import type { FileRecord, PageRecord, Settings } from '../../shared/types';
import { api, copy, send } from '../lib/api';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { MarkdownView } from '../components/MarkdownView';
type DocumentData = { file: FileRecord; content: string; page: PageRecord | null };
export default function Editor({
  id,
  theme,
  settings,
  onClose,
  notify,
}: {
  id: string;
  theme: string;
  settings: Settings | null;
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const [data, setData] = useState<DocumentData | null>(null),
    [content, setContent] = useState(''),
    [saved, setSaved] = useState(''),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false),
    [title, setTitle] = useState(''),
    [slug, setSlug] = useState(''),
    [description, setDescription] = useState(''),
    [allowSource, setAllowSource] = useState(false),
    [allowIndex, setAllowIndex] = useState(false),
    [link, setLink] = useState(''),
    [mobilePreview, setMobilePreview] = useState(false),
    [draft, setDraft] = useState<string | null>(null);
  const editor = useRef<ReactCodeMirrorRef>(null),
    imageInput = useRef<HTMLInputElement>(null);
  const dirty = content !== saved;
  const makeLink = (page: PageRecord) =>
    `${settings?.markdownOrigin || location.origin}/p/${page.slug}`;
  useEffect(() => {
    let live = true;
    void api<DocumentData>(`/markdown/${id}`)
      .then((d) => {
        if (!live) return;
        setData(d);
        setContent(d.content);
        setSaved(d.content);
        setVersion(d.file.version);
        setTitle(d.page?.title ?? d.file.name.replace(/\.md$/i, ''));
        setSlug(d.page?.slug ?? `note-${d.file.id.slice(0, 8)}`);
        setDescription(d.page?.description ?? '');
        setAllowSource(!!d.page?.allow_source);
        setAllowIndex(!!d.page?.allow_index);
        if (d.page?.published) setLink(makeLink(d.page));
        try {
          const value = localStorage.getItem(`draft:${id}`);
          if (value) {
            const parsed = JSON.parse(value) as { content: string };
            if (parsed.content !== d.content) setDraft(parsed.content);
          }
        } catch {
          /* Cloud document remains available if local draft storage is unavailable. */
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    if (dirty) {
      try {
        localStorage.setItem(`draft:${id}`, JSON.stringify({ content, version }));
      } catch {
        /* Visible editor retains unsaved text. */
      }
    }
    return () => window.removeEventListener('beforeunload', handler);
  }, [content, dirty, id, version]);
  const save = useCallback(async () => {
    if (!data || busy) return null;
    if (!dirty) return version;
    setBusy(true);
    setError('');
    try {
      const result = await send<{ version: number }>(`/markdown/${id}`, 'PUT', {
        content,
        version,
      });
      setVersion(result.version);
      setSaved(content);
      try {
        localStorage.removeItem(`draft:${id}`);
      } catch {
        /* Nonessential browser storage. */
      }
      notify('文档已保存');
      return result.version;
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      return null;
    } finally {
      setBusy(false);
    }
  }, [data, busy, dirty, id, content, version, notify]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [save]);
  function insert(before: string, after = '') {
    const view = editor.current?.view;
    if (view) {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      view.dispatch({
        changes: { from, to, insert: before + selected + after },
        selection: { anchor: from + before.length, head: from + before.length + selected.length },
      });
      view.focus();
    } else setContent((value) => value + before + after);
  }
  async function uploadImage(file: File) {
    if (!settings) return;
    try {
      const params = new URLSearchParams({ name: file.name });
      const result = await api<{ reference: string }>(`/markdown/${id}/attachments?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Size': String(file.size) },
        body: file,
      });
      insert(`\n![${file.name.replace(/[\[\]\\]/g, '')}](${result.reference})\n`);
      notify('图片已上传并插入');
    } catch (e) {
      setError(e instanceof Error ? e.message : '图片上传失败');
    }
  }
  async function publish() {
    const savedVersion = await save();
    if (savedVersion === null) return;
    setBusy(true);
    setError('');
    try {
      const result = await send<{ url: string }>(`/markdown/${id}/publish`, 'POST', {
        title,
        slug,
        description,
        allow_source: allowSource,
        allow_index: allowIndex,
        version: savedVersion,
      });
      setLink(result.url);
      const fresh = await api<DocumentData>(`/markdown/${id}`);
      setData(fresh);
      setPublishing(false);
      notify('发布成功，公开页面已更新');
    } catch (e) {
      setError(e instanceof Error ? e.message : '发布失败');
    } finally {
      setBusy(false);
    }
  }
  async function unpublish() {
    setBusy(true);
    try {
      await send(`/markdown/${id}/unpublish`, 'POST');
      setLink('');
      setData(await api<DocumentData>(`/markdown/${id}`));
      setPublishing(false);
      notify('已取消发布，文章和公开附件立即失效');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="editor-page">
      <header className="editor-top">
        <Button
          variant="ghost"
          size="icon"
          aria-label="返回文件列表"
          onClick={() => {
            if (!dirty || window.confirm('有未保存内容，确定返回吗？本地草稿会保留。')) onClose();
          }}
        >
          <ArrowLeft size={20} />
        </Button>
        <div className="editor-heading">
          <strong>{data?.file.name ?? '加载文档…'}</strong>
          <span>
            {busy ? '正在处理…' : dirty ? '有未保存更改' : '已保存'} · v{version}
            {data?.page?.published ? ` · 已发布 v${data.page.published_version}` : ' · 私人草稿'}
          </span>
        </div>
        <Button variant="outline" onClick={() => void save()} disabled={busy || !dirty}>
          <Save size={16} />
          保存
        </Button>
        <Button onClick={() => setPublishing(true)} disabled={busy || !data}>
          <Globe size={16} />
          {data?.page?.published ? '更新发布' : '发布'}
        </Button>
      </header>
      {error && (
        <div className="editor-message error-text" role="alert">
          {error}{' '}
          <button
            onClick={() => {
              const blob = new Blob([content], { type: 'text/markdown' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = data?.file.name ?? 'draft.md';
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            下载本地草稿
          </button>
        </div>
      )}
      {draft !== null && (
        <div className="editor-message">
          发现未保存的本地草稿。
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setContent(draft);
              setDraft(null);
            }}
          >
            恢复草稿
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(null);
              localStorage.removeItem(`draft:${id}`);
            }}
          >
            忽略
          </Button>
        </div>
      )}
      {link && (
        <div className="published-banner">
          <Check size={15} />
          <span>已发布</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void copy(link)
                .then(() => notify('阅读链接已复制'))
                .catch(() => setError('请从发布窗口手动复制链接'))
            }
          >
            复制链接
          </Button>
          <a href={link} target="_blank" rel="noreferrer" aria-label="打开文章">
            <ExternalLink size={15} />
          </a>
        </div>
      )}
      <div className="editor-tools">
        {[
          { icon: Bold, label: '加粗', before: '**', after: '**' },
          { icon: Italic, label: '斜体', before: '*', after: '*' },
          { icon: Link, label: '链接', before: '[', after: '](https://)' },
          { icon: List, label: '列表', before: '\n- ', after: '' },
          { icon: Code2, label: '代码块', before: '\n```typescript\n', after: '\n```\n' },
        ].map((t) => (
          <Button
            key={t.label}
            variant="ghost"
            size="icon"
            title={t.label}
            aria-label={t.label}
            onClick={() => insert(t.before, t.after)}
          >
            <t.icon size={17} />
          </Button>
        ))}
        <Button
          variant="ghost"
          size="icon"
          title="上传图片"
          aria-label="上传图片"
          onClick={() => imageInput.current?.click()}
        >
          <ImagePlus size={17} />
        </Button>
        <input
          ref={imageInput}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadImage(f);
            e.target.value = '';
          }}
        />
        <span className="editor-tools-label">MARKDOWN / GFM</span>
        <Button
          className="mobile-preview-toggle"
          size="sm"
          variant="outline"
          onClick={() => setMobilePreview(!mobilePreview)}
        >
          {mobilePreview ? <PanelLeft size={16} /> : <Eye size={16} />}{' '}
          {mobilePreview ? '编辑' : '预览'}
        </Button>
      </div>
      <div className={`editor-columns ${mobilePreview ? 'show-preview' : ''}`}>
        <section
          className="editor-source"
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void uploadImage(f);
            }
          }}
        >
          <div className="panel-label">
            正文编辑 <span>Ctrl / ⌘ + S 保存</span>
          </div>
          <CodeMirror
            ref={editor}
            value={content}
            height="100%"
            theme={theme === 'dark' ? 'dark' : 'light'}
            extensions={[markdown({ codeLanguages: languages })]}
            onChange={setContent}
            basicSetup={{ lineNumbers: true, foldGutter: true }}
          />
        </section>
        <section className="editor-preview">
          <div className="panel-label">
            实时预览 <span>安全渲染</span>
          </div>
          <div className="editor-preview-content">
            <MarkdownView source={content} fileId={id} />
          </div>
        </section>
      </div>
      <footer className="editor-bottom">
        <span>{content.length.toLocaleString()} 字符</span>
      </footer>
      {publishing && (
        <Modal
          title={data?.page?.published ? '更新公开文章' : '发布 Markdown'}
          onClose={() => {
            if (!busy) setPublishing(false);
          }}
        >
          <form
            className="form-stack"
            onSubmit={(e) => {
              e.preventDefault();
              void publish();
            }}
          >
            <label>
              文章标题
              <input
                value={title}
                required
                maxLength={180}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              URL Slug
              <input
                value={slug}
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxLength={100}
                onChange={(e) => setSlug(e.target.value)}
              />
            </label>
            <label>
              简介
              <textarea
                value={description}
                maxLength={500}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={allowSource}
                onChange={(e) => setAllowSource(e.target.checked)}
              />
              允许下载 Markdown 原文
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={allowIndex}
                onChange={(e) => setAllowIndex(e.target.checked)}
              />
              允许搜索引擎索引
            </label>
            {link && (
              <label>
                当前阅读链接
                <input value={link} readOnly onFocus={(e) => e.target.select()} />
              </label>
            )}
            {error && <p className="error-text">{error}</p>}
            <div className="dialog-footer">
              {data?.page?.published && (
                <Button
                  variant="danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void unpublish()}
                >
                  取消发布
                </Button>
              )}
              <Button disabled={busy}>{busy ? '处理中…' : '保存并发布'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
