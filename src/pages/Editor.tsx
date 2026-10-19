import { tr } from '../lib/i18n';
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
import { clipboardImages, imageMarkdown, uploadHostedImage } from '../lib/image-upload';
import { clearSavedDraft } from '../lib/editor-draft';
import { Button } from '../components/ui/button';
import { Modal } from '../components/ui/dialog';
import { MarkdownView } from '../components/MarkdownView';
import { LinkOriginSelect, usePublicLinks } from '../components/PublicLinks';
import { LanguageSelect } from '../components/LanguageSelect';
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
  const publicLinks = usePublicLinks();
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
    [draft, setDraft] = useState<string | null>(null),
    [imageUploading, setImageUploading] = useState(false),
    [imageStatus, setImageStatus] = useState('');
  const editor = useRef<ReactCodeMirrorRef>(null),
    imageInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true),
    imageUploadBusy = useRef(false),
    imageUploadRun = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      imageUploadBusy.current = false;
      imageUploadRun.current++;
    };
  }, [id]);
  const dirty = content !== saved;
  const makeLink = (page: PageRecord) =>
    `${settings?.markdownOrigin || location.origin}/p/${page.slug}`;
  useEffect(() => {
    const controller = new AbortController();
    void api<DocumentData>(`/markdown/${id}`, { signal: controller.signal })
      .then((d) => {
        if (controller.signal.aborted) return;
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
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error ? cause.message : tr('读取文档失败', 'Could not load document'),
          );
        }
      });
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty || imageUploadBusy.current) {
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
    if (imageUploadBusy.current) {
      setError(tr('请等待图片上传完成后保存', 'Wait for images to finish uploading before saving'));
      return null;
    }
    if (!data || busy) return null;
    const currentContent = editor.current?.view?.state.doc.toString() ?? content;
    if (currentContent === saved) return version;
    setBusy(true);
    setError('');
    try {
      const result = await send<{ version: number }>(`/markdown/${id}`, 'PUT', {
        content: currentContent,
        version,
      });
      setVersion(result.version);
      setSaved(currentContent);
      try {
        clearSavedDraft(localStorage, id, currentContent);
      } catch {
        /* Nonessential browser storage. */
      }
      notify(tr('文档已保存', 'Document saved'));
      return result.version;
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('保存失败', 'Could not save'));
      return null;
    } finally {
      setBusy(false);
    }
  }, [data, busy, id, content, saved, version, notify]);
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
  async function uploadImages(files: File[]) {
    if (!files.length) return;
    if (!settings || !data) {
      setError(tr('请等待文档加载完成', 'Wait for the document to load'));
      return;
    }
    if (busy || imageUploadBusy.current) {
      setError(
        tr(
          '请等待当前操作完成后再上传图片',
          'Wait for the current action to finish before uploading images',
        ),
      );
      return;
    }
    const run = ++imageUploadRun.current;
    const imageLink = publicLinks.link;
    const active = () => mounted.current && imageUploadRun.current === run;
    imageUploadBusy.current = true;
    setImageUploading(true);
    setError('');
    let completed = 0;
    const errors: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (!active()) break;
        const label = tr('图片 {0} / {1} · {2}', 'Image {0} / {1} · {2}', {
          '0': index + 1,
          '1': files.length,
          '2': file.name,
        });
        setImageStatus(label + tr(' · 上传中', ' · Uploading'));
        try {
          const result = await uploadHostedImage(file, (percent) => {
            if (active()) {
              setImageStatus(
                label +
                  ' · ' +
                  (percent === null ? tr('生成直链', 'Create direct link') : percent + '%'),
              );
            }
          });
          if (!active()) break;
          insert('\n' + imageMarkdown(file.name, imageLink(result.url)) + '\n');
          completed++;
          if (result.cleanupWarning) errors.push(file.name + '：' + result.cleanupWarning);
        } catch (cause) {
          if (!active()) break;
          errors.push(
            file.name +
              '：' +
              (cause instanceof Error ? cause.message : tr('上传失败', 'Upload failed')),
          );
        }
        if (errors.length) setError(errors.join('；'));
      }
    } finally {
      if (active()) {
        imageUploadBusy.current = false;
        setImageUploading(false);
        setImageStatus(
          completed ? tr('已插入 {0} 张图片', 'Inserted {0} images', { '0': completed }) : '',
        );
      }
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
      notify(tr('发布成功，公开页面已更新', 'Published. The public page is up to date.'));
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('发布失败', 'Could not publish'));
    } finally {
      setBusy(false);
    }
  }
  async function unpublish() {
    if (imageUploadBusy.current || busy) return;
    setBusy(true);
    try {
      await send(`/markdown/${id}/unpublish`, 'POST');
      setLink('');
      setData(await api<DocumentData>(`/markdown/${id}`));
      setPublishing(false);
      notify(tr('文章已取消发布', 'Article unpublished'));
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('操作失败', 'Action failed'));
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
          aria-label={tr('返回文件列表', 'Back to files')}
          disabled={imageUploading}
          onClick={() => {
            if (imageUploadBusy.current) return;
            if (
              !dirty ||
              window.confirm(
                tr(
                  '有未保存内容，确定返回吗？本地草稿会保留。',
                  'Leave with unsaved changes? Your local draft will be kept.',
                ),
              )
            )
              onClose();
          }}
        >
          <ArrowLeft size={20} />
        </Button>
        <div className="editor-heading">
          <strong>{data?.file.name ?? tr('加载文档…', 'Loading document…')}</strong>
          <span>
            {imageUploading
              ? tr('正在上传图片…', 'Uploading images…')
              : busy
                ? tr('正在处理…', 'Working…')
                : dirty
                  ? tr('有未保存更改', 'Unsaved changes')
                  : tr('已保存', 'Saved')}{' '}
            · v{version}
            {data?.page?.published
              ? tr(' · 已发布 v{0}', ' · Published v{0}', { '0': data.page.published_version ?? 1 })
              : tr(' · 私人草稿', ' · Private draft')}
          </span>
        </div>
        <LanguageSelect />
        <Button
          variant="outline"
          onClick={() => void save()}
          disabled={busy || imageUploading || !dirty}
        >
          <Save size={16} />
          {tr('保存', 'Save')}
        </Button>
        <Button onClick={() => setPublishing(true)} disabled={busy || imageUploading || !data}>
          <Globe size={16} />
          {data?.page?.published ? tr('更新发布', 'Update publication') : tr('发布', 'Publish')}
        </Button>
      </header>
      {imageStatus && (
        <div className="editor-message" role="status">
          <span style={{ overflowWrap: 'anywhere' }}>{imageStatus}</span>
        </div>
      )}
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
            {tr('下载本地草稿', 'Download local draft')}
          </button>
        </div>
      )}
      {draft !== null && (
        <div className="editor-message">
          {tr('发现未保存的本地草稿。', 'An unsaved local draft is available.')}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setContent(draft);
              setDraft(null);
            }}
          >
            {tr('恢复草稿', 'Restore draft')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(null);
              localStorage.removeItem(`draft:${id}`);
            }}
          >
            {tr('忽略', 'Dismiss')}
          </Button>
        </div>
      )}
      {link && (
        <div className="published-banner">
          <Check size={15} />
          <span>{tr('已发布', 'Published')}</span>
          <LinkOriginSelect compact className="editor-published-origin" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void copy(publicLinks.link(link))
                .then(() => notify(tr('阅读链接已复制', 'Article link copied')))
                .catch(() =>
                  setError(
                    tr('请从发布窗口手动复制链接', 'Copy the link from the publication dialog'),
                  ),
                )
            }
          >
            {tr('复制链接', 'Copy link')}
          </Button>
          <a
            href={publicLinks.link(link)}
            target="_blank"
            rel="noreferrer"
            aria-label={tr('打开文章', 'Open article')}
          >
            <ExternalLink size={15} />
          </a>
        </div>
      )}
      <div className="editor-tools">
        {[
          { icon: Bold, label: tr('加粗', 'Bold'), before: '**', after: '**' },
          { icon: Italic, label: tr('斜体', 'Italic'), before: '*', after: '*' },
          { icon: Link, label: tr('链接', 'Link'), before: '[', after: '](https://)' },
          { icon: List, label: tr('列表', 'List'), before: '\n- ', after: '' },
          {
            icon: Code2,
            label: tr('代码块', 'Code block'),
            before: '\n```typescript\n',
            after: '\n```\n',
          },
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
          title={tr('上传图片', 'Upload images')}
          aria-label={tr('上传图片', 'Upload images')}
          disabled={busy || imageUploading || !settings || !data}
          onClick={() => imageInput.current?.click()}
        >
          <ImagePlus size={17} />
        </Button>
        <input
          ref={imageInput}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => {
            void uploadImages(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        {!link && <LinkOriginSelect compact className="editor-image-origin" />}
        <span className="editor-tools-label">MARKDOWN / GFM</span>
        <Button
          className="mobile-preview-toggle"
          size="sm"
          variant="outline"
          onClick={() => setMobilePreview(!mobilePreview)}
        >
          {mobilePreview ? <PanelLeft size={16} /> : <Eye size={16} />}{' '}
          {mobilePreview ? tr('编辑', 'Edit') : tr('预览', 'Preview')}
        </Button>
      </div>
      <div className={`editor-columns ${mobilePreview ? 'show-preview' : ''}`}>
        <section
          className="editor-source"
          onDragOverCapture={(e) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDropCapture={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              e.stopPropagation();
              void uploadImages(Array.from(e.dataTransfer.files));
            }
          }}
          onPasteCapture={(e) => {
            const files = clipboardImages(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            e.stopPropagation();
            void uploadImages(files);
          }}
        >
          <div className="panel-label">
            {tr('正文编辑', 'Document editor')}
            <span>{tr('Ctrl / ⌘ + S 保存', 'Ctrl / ⌘ + S to save')}</span>
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
          <div className="panel-label">{tr('实时预览', 'Live preview')}</div>
          <div className="editor-preview-content">
            <MarkdownView source={content} fileId={id} />
          </div>
        </section>
      </div>
      <footer className="editor-bottom">
        <span>
          {content.length.toLocaleString()}
          {tr('字符', 'characters')}
        </span>
      </footer>
      {publishing && (
        <Modal
          title={
            data?.page?.published
              ? tr('更新公开文章', 'Update public article')
              : tr('发布 Markdown', 'Publish Markdown')
          }
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
              {tr('文章标题', 'Article title')}
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
              {tr('简介', 'Description')}
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
              {tr('允许下载 Markdown 原文', 'Allow downloading Markdown source')}
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={allowIndex}
                onChange={(e) => setAllowIndex(e.target.checked)}
              />
              {tr('允许搜索引擎索引', 'Allow search engine indexing')}
            </label>
            {link && (
              <div className="editor-published-link">
                <div className="editor-link-heading">
                  <label htmlFor="current-reading-link">
                    {tr('当前阅读链接', 'Current article link')}
                  </label>
                  <LinkOriginSelect compact />
                </div>
                <input
                  id="current-reading-link"
                  value={publicLinks.link(link)}
                  readOnly
                  onFocus={(e) => e.target.select()}
                />
              </div>
            )}
            {error && <p className="error-text">{error}</p>}
            <div className="dialog-footer">
              {data?.page?.published && (
                <Button
                  variant="danger"
                  type="button"
                  disabled={busy || imageUploading}
                  onClick={() => void unpublish()}
                >
                  {tr('取消发布', 'Unpublish')}
                </Button>
              )}
              <Button disabled={busy || imageUploading}>
                {busy ? tr('处理中…', 'Working…') : tr('保存并发布', 'Save and publish')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
