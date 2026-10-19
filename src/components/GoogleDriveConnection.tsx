import { useCallback, useEffect, useState } from 'react';
import { Cloud, ExternalLink, RefreshCw } from 'lucide-react';
import type { GoogleDriveStatus } from '../../shared/google-drive';
import { api, sizeLabel } from '../lib/api';
import { driveWrite } from '../lib/google-drive-api';
import { Button } from './ui/button';
import { Modal } from './ui/dialog';

export function useGoogleDriveStatus(revision = 0) {
  const [status, setStatus] = useState<GoogleDriveStatus | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const reload = useCallback(() => setRetry((value) => value + 1), []);
  const clearConnection = useCallback(
    () =>
      setStatus((current) =>
        current
          ? { configured: current.configured, connected: false, redirectUris: current.redirectUris }
          : null,
      ),
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<GoogleDriveStatus>('/google-drive', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '读取连接状态失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, retry]);
  return { status, error, loading, reload, clearConnection };
}
export function GoogleDriveConnection({
  status,
  loading,
  error,
  reload,
  clearConnection,
  notify,
  onChanged,
  onBeforeConnectionChange,
  uploading = false,
  compact = false,
}: ReturnType<typeof useGoogleDriveStatus> & {
  notify: (message: string) => void;
  onChanged?: () => void;
  onBeforeConnectionChange?: () => void;
  uploading?: boolean;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(''),
    [actionError, setActionError] = useState('');
  async function connect() {
    setBusy(true);
    setActionError('');
    try {
      onBeforeConnectionChange?.();
      const result = status?.connectionId
        ? await driveWrite<{ url: string }>('/connect', 'POST', status.connectionId)
        : await api<{ url: string }>('/google-drive/connect', { method: 'POST' });
      const destination = new URL(result.url);
      if (destination.protocol !== 'https:' || destination.hostname !== 'accounts.google.com')
        throw new Error('授权地址无效');
      location.assign(destination.href);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '无法连接 Google Drive');
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setActionError('');
    try {
      onBeforeConnectionChange?.();
      await driveWrite('/connection', 'DELETE', confirm);
      clearConnection();
      setConfirm('');
      reload();
      onChanged?.();
      notify('已断开 Google Drive');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '断开连接失败');
    } finally {
      setBusy(false);
    }
  }
  const quota = status?.storageQuota;
  return (
    <section
      className={`settings-card google-connection ${compact ? 'google-connection-compact' : ''}`}
    >
      <div className="google-connection-heading">
        <Cloud size={21} />
        <h3>Google Drive</h3>
        <span className={`connection-status ${status?.connected ? 'is-connected' : ''}`}>
          {loading
            ? '读取中'
            : status?.needsReconnect
              ? '需要重新连接'
              : status?.connected
                ? '已连接'
                : status?.configured
                  ? '未连接'
                  : status
                    ? '未配置'
                    : '连接异常'}
        </span>
      </div>
      {status?.connected ? (
        <>
          <p className="account-email">
            {status.account?.emailAddress || status.account?.displayName || 'Google 账号'}
          </p>
          {quota?.usage && (
            <p>
              {sizeLabel(Number(quota.usage))}
              {quota.limit ? ` / ${sizeLabel(Number(quota.limit))}` : ' 已使用'}
            </p>
          )}
        </>
      ) : status && !status.configured ? (
        <p>配置 Google OAuth 后即可连接。</p>
      ) : null}
      {(error || actionError || status?.error) && (
        <p className="error-text" role="alert">
          {actionError || error || status?.error}
        </p>
      )}
      <div className="google-connection-actions">
        {status?.connected && !status.needsReconnect ? (
          <>
            {!compact && (
              <Button variant="outline" asChild>
                <a href="#google-drive">打开文件</a>
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={busy || !status.connectionId}
              onClick={() => setConfirm(status.connectionId!)}
            >
              断开连接
            </Button>
          </>
        ) : (
          <Button
            onClick={() => void connect()}
            disabled={busy || loading || status?.configured === false}
          >
            <ExternalLink size={15} />
            {busy ? '正在连接…' : status?.needsReconnect ? '重新连接' : '连接 Google Drive'}
          </Button>
        )}
        {status?.connected && (status.needsReconnect || error) && (
          <>
            {error && !status.needsReconnect && status.configured && (
              <Button variant="outline" disabled={busy} onClick={() => void connect()}>
                重新连接
              </Button>
            )}
            {status.needsReconnect && (
              <Button
                variant="ghost"
                disabled={busy || !status.connectionId}
                onClick={() => setConfirm(status.connectionId!)}
              >
                断开连接
              </Button>
            )}
          </>
        )}
        {error && (
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            <RefreshCw size={14} />
            重试
          </Button>
        )}
      </div>
      {confirm && (
        <Modal
          title="断开 Google Drive"
          onClose={() => {
            if (!busy) setConfirm('');
          }}
        >
          <p>本地连接将被移除，Google Drive 中的文件会保留。</p>
          {uploading && <p>当前上传队列会停止。</p>}
          {actionError && (
            <p className="error-text" role="alert">
              {actionError}
            </p>
          )}
          <div className="dialog-footer">
            <Button variant="outline" disabled={busy} onClick={() => setConfirm('')}>
              取消
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void disconnect()}>
              {busy ? '处理中…' : '断开连接'}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
export function GoogleDriveSettings({
  notify,
  uploading = false,
  onBeforeConnectionChange,
}: {
  notify: (message: string) => void;
  uploading?: boolean;
  onBeforeConnectionChange?: () => void;
}) {
  const connection = useGoogleDriveStatus();
  return (
    <GoogleDriveConnection
      {...connection}
      notify={notify}
      uploading={uploading}
      onBeforeConnectionChange={onBeforeConnectionChange}
    />
  );
}
