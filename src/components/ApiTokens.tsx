import { tr } from '../lib/i18n';
import { useEffect, useId, useState } from 'react';
import { KeyRound, Plus, Copy, ExternalLink } from 'lucide-react';
import { api, send, dateLabel } from '../lib/api';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { Select } from './ui/select';
import { sharexConfig } from '../../shared/sharex';

interface Token {
  id: string;
  name: string;
  prefix: string;
  scope: 'files:upload' | 'images:upload';
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export function ApiTokens({
  notify,
  uploadOrigin,
}: {
  notify: (text: string) => void;
  uploadOrigin: string;
}) {
  const scopeId = useId();
  const daysId = useId();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState('30');
  const [scope, setScope] = useState<'files:upload' | 'images:upload'>('files:upload');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api<Token[]>('/api-tokens', { signal: controller.signal })
      .then(setTokens)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  const close = () => {
    if (!busy) {
      setCreating(false);
      setSecret('');
      setRevoking(null);
    }
  };
  return (
    <section className="settings-card api-token-card">
      <div className="api-token-heading">
        <div>
          <KeyRound />
          <h3>{tr('上传 API', 'Upload API')}</h3>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setName('');
            setDays('30');
            setScope('files:upload');
            setCreating(true);
          }}
        >
          <Plus size={16} />
          {tr('创建 Token', 'Create token')}
        </Button>
      </div>
      <a
        className="api-doc-link"
        href="https://github.com/irinsann/cloudflare-filehub/blob/main/docs/api.md"
        target="_blank"
        rel="noreferrer"
      >
        {tr('API 文档', 'API documentation')}
        <ExternalLink size={14} />
      </a>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p>{tr('加载中…', 'Loading…')}</p>
      ) : !tokens.length ? (
        <p>{tr('暂无 Token', 'No tokens')}</p>
      ) : (
        <div className="api-token-list">
          {tokens.map((t) => {
            const active = !t.revoked_at && t.expires_at > Date.now();
            return (
              <div className="api-token-row" key={t.id}>
                <div>
                  <strong>{t.name}</strong>
                  <code>{t.prefix}…</code>
                  <small>
                    {t.revoked_at
                      ? tr('已撤销', 'Revoked')
                      : !active
                        ? tr('已到期', 'Expired')
                        : tr('{0} · 有效至 {1}', '{0} · Expires {1}', {
                            '0':
                              t.scope === 'images:upload'
                                ? tr('图床上传', 'Image uploads')
                                : tr('文件上传', 'File uploads'),
                            '1': dateLabel(t.expires_at),
                          })}
                  </small>
                  <small>
                    {tr('最近使用：', 'Last used: ')}
                    {t.last_used_at ? dateLabel(t.last_used_at) : tr('未使用', 'Never used')}
                  </small>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!active}
                  onClick={() => setRevoking(t)}
                >
                  {tr('撤销', 'Revoke')}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {creating && (
        <Modal
          title={secret ? tr('保存 Token', 'Save token') : tr('创建 API Token', 'Create API token')}
          onClose={close}
        >
          {secret ? (
            <div className="form-stack">
              <p>
                {tr(
                  'Token 仅显示一次，请保存到安全位置。',
                  'This token is shown once. Store it somewhere safe.',
                )}
              </p>
              {scope === 'images:upload' && (
                <p>
                  {tr(
                    'ShareX 配置包含 Token，请勿公开。',
                    'The ShareX configuration contains your token. Keep it private.',
                  )}
                </p>
              )}
              <label>
                Token
                <input className="api-token-secret" value={secret} readOnly spellCheck={false} />
              </label>
              <div className="dialog-footer">
                {scope === 'images:upload' && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      const blob = new Blob(
                        [JSON.stringify(sharexConfig(uploadOrigin, secret), null, 2)],
                        { type: 'application/json' },
                      );
                      const url = URL.createObjectURL(blob),
                        link = document.createElement('a');
                      link.href = url;
                      link.download = 'RCloud.sxcu';
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                  >
                    {tr('下载 ShareX 配置', 'Download ShareX config')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(secret);
                      notify(tr('已复制 Token', 'Token copied'));
                    } catch {
                      notify(tr('复制失败，请手动复制', 'Could not copy. Copy manually.'));
                    }
                  }}
                >
                  <Copy size={16} />
                  {tr('复制', 'Copy')}
                </Button>
                <Button onClick={close}>{tr('已保存', 'Saved')}</Button>
              </div>
            </div>
          ) : (
            <form
              className="form-stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const result = await send<{ token: string }>('/api-tokens', 'POST', {
                    name,
                    scope,
                    expires_in_days: Number(days),
                  });
                  setSecret(result.token);
                  setError('');
                  setRevision((n) => n + 1);
                } catch (e) {
                  notify(e instanceof Error ? e.message : tr('创建失败', 'Could not create'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                {tr('名称', 'Name')}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  placeholder={tr('例如：备份脚本', 'For example: Backup script')}
                />
              </label>
              <div className="form-field">
                <label htmlFor={scopeId}>{tr('类型', 'Type')}</label>
                <Select
                  id={scopeId}
                  aria-label={tr('类型', 'Type')}
                  value={scope}
                  onValueChange={(value) => setScope(value as typeof scope)}
                  options={[
                    {
                      value: 'files:upload',
                      label: tr('文件上传（私有）', 'File uploads (private)'),
                    },
                    {
                      value: 'images:upload',
                      label: tr('图床上传（公开直链 / ShareX）', 'Image uploads (public / ShareX)'),
                    },
                  ]}
                  disabled={busy}
                />
              </div>
              <div className="form-field">
                <label htmlFor={daysId}>{tr('有效期', 'Expires')}</label>
                <Select
                  id={daysId}
                  aria-label={tr('有效期', 'Expires')}
                  value={days}
                  onValueChange={setDays}
                  options={[
                    { value: '30', label: tr('30 天', '30 days') },
                    { value: '90', label: tr('90 天', '90 days') },
                    { value: '365', label: tr('365 天', '365 days') },
                  ]}
                  disabled={busy}
                />
              </div>
              <p>
                {scope === 'images:upload'
                  ? tr(
                      '图片上传后公开，保存到 Image-hosting。',
                      'Images are public and saved in Image-hosting.',
                    )
                  : tr(
                      '仅可上传文件和查询自己的上传结果。',
                      'Can only upload files and check its own uploads.',
                    )}
              </p>
              <div className="dialog-footer">
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  {tr('取消', 'Cancel')}
                </Button>
                <Button disabled={busy || !name.trim()}>
                  {busy ? tr('创建中…', 'Creating…') : tr('创建', 'Create')}
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {revoking && (
        <Modal title={tr('撤销 Token', 'Revoke token')} onClose={close}>
          <p>
            {tr('撤销「', 'Revoke “')}
            {revoking.name}
            {tr(
              '」后，使用此 Token 的脚本将无法继续上传。',
              '”? Scripts using this token will no longer be able to upload.',
            )}
          </p>
          <div className="dialog-footer">
            <Button variant="ghost" disabled={busy} onClick={close}>
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await send(`/api-tokens/${revoking.id}`, 'DELETE');
                  setRevoking(null);
                  setRevision((n) => n + 1);
                  notify(tr('Token 已撤销', 'Token revoked'));
                } catch (e) {
                  notify(e instanceof Error ? e.message : tr('撤销失败', 'Could not revoke'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {tr('撤销', 'Revoke')}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
