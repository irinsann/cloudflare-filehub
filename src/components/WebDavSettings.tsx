import { tr } from '../lib/i18n';
import '../styles/webdav.css';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Copy, ExternalLink, HardDrive, Plus } from 'lucide-react';
import { api, copy, dateLabel, send } from '../lib/api';
import { LinkOriginSelect, usePublicLinks } from './PublicLinks';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';
import { Select } from './ui/select';

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
          aria-label={tr('复制', 'Copy') + ' ' + label}
          title={tr('复制', 'Copy') + ' ' + label}
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
  const daysId = useId();
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
          setLoadError(
            error instanceof Error
              ? error.message
              : tr('读取 WebDAV 设置失败', 'Could not load WebDAV settings'),
          );
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
      if (mounted.current)
        setActionError(
          error instanceof Error
            ? error.message
            : tr('创建凭据失败', 'Could not create credentials'),
        );
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
      notify(tr('WebDAV 凭据已撤销', 'WebDAV credentials revoked'));
    } catch (error) {
      if (mounted.current)
        setActionError(
          error instanceof Error
            ? error.message
            : tr('撤销凭据失败', 'Could not revoke credentials'),
        );
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
            .then(() => notify(label + ' · ' + tr('已复制', 'Copied')))
            .catch(() => notify(tr('复制失败，请手动复制', 'Could not copy. Copy manually.')))
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
          {tr('创建凭据', 'Create credentials')}
        </Button>
      </div>
      <a
        className="api-doc-link"
        href="https://github.com/irinsann/cloudflare-filehub/blob/main/docs/webdav.md"
        target="_blank"
        rel="noreferrer"
      >
        {tr('RaiDrive / Windows 配置', 'RaiDrive / Windows setup')}
        <ExternalLink size={14} />
      </a>
      {loading ? (
        <p role="status">{tr('加载中…', 'Loading…')}</p>
      ) : loadError ? (
        <div className="error-banner" role="alert">
          <span>{loadError}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            {tr('重试', 'Retry')}
          </Button>
        </div>
      ) : (
        info && (
          <>
            <div className="webdav-connect-heading">
              <LinkOriginSelect compact />
              <span>
                {tr('单次上传', 'Upload limit')}{' '}
                {new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(
                  info.maxUploadBytes / 1000000,
                )}{' '}
                MB
              </span>
            </div>
            <div className="webdav-connection">
              {copyField(tr('服务器地址', 'Server URL'), endpoint)}
              {copyField(tr('用户名', 'Username'), info.username)}
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
                            ? tr('已撤销', 'Revoked')
                            : !active
                              ? tr('已到期', 'Expired')
                              : tr('有效至 ', 'Expires ') + dateLabel(credential.expires_at)}
                        </small>
                        <small>
                          {tr('最近使用：', 'Last used: ')}
                          {credential.last_used_at
                            ? dateLabel(credential.last_used_at)
                            : tr('未使用', 'Never used')}
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
                        {tr('撤销', 'Revoke')}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p>{tr('暂无凭据', 'No credentials')}</p>
            )}
          </>
        )
      )}
      {creating && (
        <Modal
          title={
            password
              ? tr('保存 WebDAV 密码', 'Save WebDAV password')
              : tr('创建 WebDAV 凭据', 'Create WebDAV credentials')
          }
          onClose={close}
        >
          {password ? (
            <div className="form-stack">
              <p>{tr('密码仅显示一次，请保存。', 'This password is shown once. Save it now.')}</p>
              <LinkOriginSelect compact />
              {copyField(tr('服务器地址', 'Server URL'), endpoint)}
              {copyField(tr('用户名', 'Username'), info?.username ?? 'rcloud')}
              {copyField(tr('密码', 'Password'), password)}
              <div className="dialog-footer">
                <Button type="button" onClick={close}>
                  {tr('已保存', 'Saved')}
                </Button>
              </div>
            </div>
          ) : (
            <form className="form-stack" onSubmit={(event) => void create(event)}>
              <label>
                {tr('名称', 'Name')}
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  placeholder={tr('例如：RaiDrive', 'For example: RaiDrive')}
                  disabled={busy}
                />
              </label>
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
              {actionError && (
                <div className="error-text" role="alert">
                  {actionError}
                </div>
              )}
              <div className="dialog-footer">
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  {tr('取消', 'Cancel')}
                </Button>
                <Button type="submit" disabled={busy || !name.trim()}>
                  {busy ? tr('创建中…', 'Creating…') : tr('创建', 'Create')}
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {revoking && (
        <Modal
          title={tr('撤销 WebDAV 凭据', 'Revoke WebDAV credentials')}
          description={tr(
            '使用此凭据的设备将无法继续连接。',
            'Devices using these credentials will no longer be able to connect.',
          )}
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
              {tr('取消', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => void revoke(revoking)}
            >
              {busy ? tr('撤销中…', 'Revoking…') : tr('撤销', 'Revoke')}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
