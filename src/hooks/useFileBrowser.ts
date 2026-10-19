import { useState, useRef, useEffect, useCallback } from 'react';
import type { Listing, FolderRecord } from '../../shared/types';
import { api } from '../lib/api';
import { sections, type View } from '../lib/navigation';
const readView = (): View => sections.find((s) => s.id === location.hash.slice(1))?.id ?? 'files';
export function useFileBrowser() {
  const [view, setView] = useState<View>(readView),
    [listing, setListing] = useState<Listing | null>(null),
    [folder, setFolder] = useState<string | null>(null),
    [crumbs, setCrumbs] = useState<FolderRecord[]>([]),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [grid, setGrid] = useState(() => {
      try {
        return localStorage.getItem('rcloud-view') === 'grid';
      } catch {
        return false;
      }
    }),
    [sort, setSort] = useState('updated_at'),
    [direction, setDirection] = useState('desc'),
    [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const request = useRef(0);
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const reset = useCallback((next: View) => {
    setView(next);
    setFolder(null);
    setCrumbs([]);
    setPage(1);
    setSearch('');
    setError('');
    setSelected(new Set());
  }, []);
  const navigate = useCallback(
    (next: View) => {
      reset(next);
      if (location.hash !== '#' + next) location.hash = next;
    },
    [reset],
  );
  useEffect(() => {
    const changed = () => reset(readView());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [reset]);
  useEffect(() => {
    const timeout = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    setSelected(new Set());
    const controller = new AbortController();
    if (['published', 'shares', 'settings', 'images'].includes(view)) return;
    const serial = ++request.current;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      view,
      search: query,
      sort,
      direction,
      page: String(page),
    });
    if (folder) params.set('folder_id', folder);
    void api<Listing>(`/files?${params}`, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted && serial === request.current) {
          const lastPage = Math.max(
            1,
            Math.ceil(Math.max(data.total, data.folderTotal) / data.limit),
          );
          if (page > lastPage) setPage(lastPage);
          else setListing(data);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted && serial === request.current) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted && serial === request.current) setLoading(false);
      });
    return () => controller.abort();
  }, [view, folder, query, sort, direction, page, refresh]);
  function openFolder(f: FolderRecord) {
    setFolder(f.id);
    setCrumbs([...crumbs, f]);
    setPage(1);
    setSearch('');
  }
  function select(id: string) {
    setSelected((all) => {
      const next = new Set(all);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    try {
      localStorage.setItem('rcloud-view', grid ? 'grid' : 'list');
    } catch {
      /* Optional preference. */
    }
  }, [grid]);
  function searchFiles(value: string) {
    if (['published', 'shares', 'settings', 'images'].includes(view)) {
      setView('files');
      setFolder(null);
      setCrumbs([]);
      history.replaceState(null, '', '#files');
    }
    setSearch(value);
  }
  return {
    searchFiles,
    view,
    crumbs,
    setFolder,
    setCrumbs,
    setPage,
    query,
    sort,
    setSort,
    direction,
    setDirection,
    grid,
    setGrid,
    selected,
    setSelected,
    loading,
    listing,
    openFolder,
    select,
    error,
    page,
    setError,
    folder,
    refresh,
    reload,
    navigate,
    setSearch,
    search,
    setView,
  };
}
