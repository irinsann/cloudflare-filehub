import { useEffect, useState } from 'react';
import { KeyRound, Plus, Copy, ExternalLink } from 'lucide-react';
import { api, send, dateLabel } from '../lib/api';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';

interface Token {
  id: string;
  name: string;
  prefix: string;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export function ApiTokens({ notify }: { notify: (text: string) => void }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState('30');
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
          <h3>上传 API</h3>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setName('');
            setDays('30');
            setCreating(true);
          }}
        >
          <Plus size={16} />
          创建 Token
        </Button>
      </div>
      <a
        className="api-doc-link"
        href="https://github.com/irinsann/cloudflare-filehub/blob/main/docs/api.md"
        target="_blank"
        rel="noreferrer"
      >
        API 文档
        <ExternalLink size={14} />
      </a>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p>加载中…</p>
      ) : !tokens.length ? (
        <p>暂无 Token</p>
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
                      ? '已撤销'
                      : !active
                        ? '已到期'
                        : `仅上传 · 有效至 ${dateLabel(t.expires_at)}`}
                  </small>
                  <small>最近使用：{t.last_used_at ? dateLabel(t.last_used_at) : '未使用'}</small>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!active}
                  onClick={() => setRevoking(t)}
                >
                  撤销
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {creating && (
        <Modal title={secret ? '保存 Token' : '创建上传 Token'} onClose={close}>
          {secret ? (
            <div className="form-stack">
              <p>Token 仅显示一次，请保存到安全位置。</p>
              <label>
                Token
                <input className="api-token-secret" value={secret} readOnly spellCheck={false} />
              </label>
              <div className="dialog-footer">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(secret);
                      notify('已复制 Token');
                    } catch {
                      notify('复制失败，请手动复制');
                    }
                  }}
                >
                  <Copy size={16} />
                  复制
                </Button>
                <Button onClick={close}>已保存</Button>
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
                    expires_in_days: Number(days),
                  });
                  setSecret(result.token);
                  setError('');
                  setRevision((n) => n + 1);
                } catch (e) {
                  notify(e instanceof Error ? e.message : '创建失败');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                名称
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="例如：备份脚本"
                />
              </label>
              <label>
                有效期
                <select value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="30">30 天</option>
                  <option value="90">90 天</option>
                  <option value="365">365 天</option>
                </select>
              </label>
              <p>仅可上传文件和查询自己的上传结果。</p>
              <div className="dialog-footer">
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  取消
                </Button>
                <Button disabled={busy || !name.trim()}>{busy ? '创建中…' : '创建'}</Button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {revoking && (
        <Modal title="撤销 Token" onClose={close}>
          <p>撤销「{revoking.name}」后，使用此 Token 的脚本将无法继续上传。</p>
          <div className="dialog-footer">
            <Button variant="ghost" disabled={busy} onClick={close}>
              取消
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
                  notify('Token 已撤销');
                } catch (e) {
                  notify(e instanceof Error ? e.message : '撤销失败');
                } finally {
                  setBusy(false);
                }
              }}
            >
              撤销
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
