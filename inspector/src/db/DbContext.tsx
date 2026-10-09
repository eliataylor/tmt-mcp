import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DbMeta, TableCounts } from '../types';
import {
  closeDb,
  getDbMeta,
  isDbOpen,
  openFromFile,
  openFromUrl,
} from './client';
import { getTableCounts } from './queries';
import { refreshSchemaCaps, resetSchemaCaps } from './schema';

const DEFAULT_DB_URL = '/sqlite_data/shared/agent_queue.db';
const DEFAULT_DB_NAME = 'agent_queue.db';

interface DbContextValue {
  meta: DbMeta | null;
  counts: TableCounts | null;
  error: string | null;
  loading: boolean;
  open: boolean;
  loadFile: (file: File) => Promise<void>;
  loadDefault: () => Promise<void>;
  reload: () => Promise<void>;
  clear: () => Promise<void>;
  refreshCounts: () => Promise<void>;
}

const DbContext = createContext<DbContextValue | null>(null);

function errMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function DbProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<DbMeta | null>(getDbMeta());
  const [counts, setCounts] = useState<TableCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastSource, setLastSource] = useState<'file' | 'default' | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);

  const refreshCounts = useCallback(async () => {
    if (!isDbOpen()) {
      setCounts(null);
      return;
    }
    setCounts(await getTableCounts());
  }, []);

  const loadFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const m = await openFromFile(file);
      await refreshSchemaCaps();
      setMeta(m);
      setLastSource('file');
      setLastFile(file);
      setCounts(await getTableCounts());
    } catch (err) {
      setError(errMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDefault = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const m = await openFromUrl(DEFAULT_DB_URL, DEFAULT_DB_NAME);
      await refreshSchemaCaps();
      setMeta(m);
      setLastSource('default');
      setLastFile(null);
      setCounts(await getTableCounts());
    } catch (err) {
      setError(
        `${errMessage(err)} — use Open file if the default path is unavailable (expected ${DEFAULT_DB_URL})`
      );
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    if (lastSource === 'file' && lastFile) await loadFile(lastFile);
    else if (lastSource === 'default') await loadDefault();
  }, [lastSource, lastFile, loadFile, loadDefault]);

  const clear = useCallback(async () => {
    await closeDb();
    resetSchemaCaps();
    setMeta(null);
    setCounts(null);
    setLastSource(null);
    setLastFile(null);
    setError(null);
  }, []);

  const value = useMemo<DbContextValue>(
    () => ({
      meta,
      counts,
      error,
      loading,
      open: meta != null,
      loadFile,
      loadDefault,
      reload,
      clear,
      refreshCounts,
    }),
    [meta, counts, error, loading, loadFile, loadDefault, reload, clear, refreshCounts]
  );

  return <DbContext.Provider value={value}>{children}</DbContext.Provider>;
}

export function useDb(): DbContextValue {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error('useDb must be used within DbProvider');
  return ctx;
}
