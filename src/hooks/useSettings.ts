import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { api } from '../lib/api';
import type { View } from '../lib/navigation';

export function useSettings(refresh: number, view: View) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<Settings>('/settings', { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setSettings(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '读取设置失败');
        }
      });
    return () => controller.abort();
  }, [refresh, view]);

  return { settings, error };
}
