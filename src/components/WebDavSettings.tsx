import '../styles/webdav.css';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Copy, ExternalLink, HardDrive, Plus } from 'lucide-react';
import { api, copy, dateLabel, send } from '../lib/api';
import { LinkOriginSelect, usePublicLinks } from './PublicLinks';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';

interface Credential {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
interface WebDavInfo {
  credentials: Credential[];
  username: string;
  path: string;
  maxUploadBytes: number;
}

function ConnectionField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  const id = useId();
  return (
    <div className="webdav-field">
      <label htmlFor={id}>{label}</label>
      <div className="webdav-copy-field">
        <input
          id={id}
          value={value}
          readOnly
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => event.target.select()}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={'复制' + label}
          title={'复制' + label}
          disabled={!value}
          onClick={onCopy}
        >
          <Copy size={15} />
        </Button>
      </div>
    </div>
  );
}

export function WebDavSettings({ notify }: { notify: (message: string) => void }) {
  const { link } = usePublicLinks();
  const [info, setInfo] = useState<WebDavInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<Credential | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [password, setPassword] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const endpoint = info ? link(new URL(info.path, location.origin).href) : '';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void api<WebDavInfo>('/webdav', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setInfo(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(error instanceof Error ? error.message : '读取 WebDAV 设置失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);

  function close() {
    if (locked.current) return;
    setCreating(false);
    setRevoking(null);
    setPassword('');
    setActionError('');
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (locked.current || !name.trim()) return;
    locked.current = true;
    setBusy(true);
    setActionError('');
    try {
      const result = await send<{ credential: Credential; password: string }>('/webdav', 'POST', {
        name: name.trim(),
        expires_in_days: Number(days),
      });
      if (!mounted.current) return;
      setPassword(result.password);
      setInfo((current) =>
        current
          ? { ...current, credentials: [result.credential, ...current.credentials] }
          : current,
      );
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : '创建凭据失败');
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function revoke(credential: Credential) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setActionError('');
    try {
      await send('/webdav/' + encodeURIComponent(credential.id), 'DELETE');
      if (!mounted.current) return;
      setInfo((current) =>
        current
          ? {
              ...current,
              credentials: current.credentials.map((row) =>
                row.id === credential.id ? { ...row, revoked_at: Date.now() } : row,
              ),
            }
          : current,
      );
      setRevoking(null);
      notify('WebDAV 凭据已撤销');
    } catch (error) {
      if (mounted.current) setActionError(error instanceof Error ? error.message : '撤销凭据失败');
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function copyField(label: string, value: string) {
    return (
      <ConnectionField
        label={label}
        value={value}
        onCopy={() =>
          void copy(value)
            .then(() => notify(label + '已复制'))
            .catch(() => notify('复制失败，请手动复制'))
        }
      />
    );
  }
  return (
    <section className="settings-card webdav-card">
      <div className="api-token-heading">
        <div>
          <HardDrive />
          <h3>WebDAV</h3>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={loading || !info || busy || !!loadError}
          onClick={() => {
            setName('');
            setDays('90');
            setPassword('');
            setActionError('');
            setCreating(true);
          }}
        >
          <Plus size={16} />
          创建凭据
        </Button>
      </div>
      <a
        className="api-doc-link"
        href="https://github.com/irinsann/cloudflare-filehub/blob/main/docs/webdav.md"
        target="_blank"
        rel="noreferrer"
      >
        RaiDrive / Windows 配置
        <ExternalLink size={14} />
      </a>
      {loading ? (
        <p role="status">加载中…</p>
      ) : loadError ? (
        <div className="error-banner" role="alert">
          <span>{loadError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      ) : (
        info && (
          <>
            <div className="webdav-connect-heading">
              <LinkOriginSelect compact />
              <span>
                单次上传{' '}
                {new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(
                  info.maxUploadBytes / 1000000,
                )}{' '}
                MB
              </span>
            </div>
            <div className="webdav-connection">
              {copyField('服务器地址', endpoint)}
              {copyField('用户名', info.username)}
            </div>
            {info.credentials.length ? (
              <div className="webdav-credentials">
                {info.credentials.map((credential) => {
                  const active = !credential.revoked_at && credential.expires_at > Date.now();
                  return (
                    <div className="api-token-row" key={credential.id}>
                      <div>
                        <strong>{credential.name}</strong>
                        <code>{credential.prefix}…</code>
                        <small>
                          {credential.revoked_at
                            ? '已撤销'
                            : !active
                              ? '已到期'
                              : '有效至 ' + dateLabel(credential.expires_at)}
                        </small>
                        <small>
                          最近使用：
                          {credential.last_used_at ? dateLabel(credential.last_used_at) : '未使用'}
                        </small>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!active || busy}
                        onClick={() => {
                          setActionError('');
                          setRevoking(credential);
                        }}
                      >
                        撤销
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p>暂无凭据</p>
            )}
          </>
        )
      )}
      {creating && (
        <Modal title={password ? '保存 WebDAV 密码' : '创建 WebDAV 凭据'} onClose={close}>
          {password ? (
            <div className="form-stack">
              <p>密码仅显示一次，请保存。</p>
              <LinkOriginSelect compact />
              {copyField('服务器地址', endpoint)}
              {copyField('用户名', info?.username ?? 'rcloud')}
              {copyField('密码', password)}
              <div className="dialog-footer">
                <Button type="button" onClick={close}>
                  已保存
                </Button>
              </div>
            </div>
          ) : (
            <form className="form-stack" onSubmit={(event) => void create(event)}>
              <label>
                名称
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  placeholder="例如：RaiDrive"
                  disabled={busy}
                />
              </label>
              <label>
                有效期
                <select
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                  disabled={busy}
                >
                  <option value="30">30 天</option>
                  <option value="90">90 天</option>
                  <option value="365">365 天</option>
                </select>
              </label>
              {actionError && (
                <div className="error-text" role="alert">
                  {actionError}
                </div>
              )}
              <div className="dialog-footer">
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  取消
                </Button>
                <Button type="submit" disabled={busy || !name.trim()}>
                  {busy ? '创建中…' : '创建'}
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {revoking && (
        <Modal
          title="撤销 WebDAV 凭据"
          description="使用此凭据的设备将无法继续连接。"
          onClose={close}
        >
          <p>{revoking.name}</p>
          {actionError && (
            <div className="error-text" role="alert">
              {actionError}
            </div>
          )}
          <div className="dialog-footer">
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => void revoke(revoking)}
            >
              {busy ? '撤销中…' : '撤销'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
