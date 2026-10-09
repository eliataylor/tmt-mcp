import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DateRangeFilter } from '../types';
import {
  defaultDateRange,
  isAllTime,
  readDateRangeFromSearch,
  writeDateRangeToSearch,
} from '../lib/dateRange';

/**
 * Shared start/end filter backed by URL search params.
 * Seeds default last-7-days when neither from nor to is present.
 */
export function useDateRange(): {
  range: DateRangeFilter;
  setRange: (next: DateRangeFilter) => void;
  setAllTime: () => void;
  resetDefault: () => void;
  allTime: boolean;
} {
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (!params.has('from') && !params.has('to')) {
      const def = defaultDateRange();
      setParams(writeDateRangeToSearch(params, def), { replace: true });
    }
    // Intentionally once on mount / when both missing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const range = useMemo(() => readDateRangeFromSearch(params), [params]);

  const setRange = useCallback(
    (next: DateRangeFilter) => {
      setParams(writeDateRangeToSearch(params, next), { replace: true });
    },
    [params, setParams]
  );

  const setAllTime = useCallback(() => {
    setRange({ from: null, to: null });
  }, [setRange]);

  const resetDefault = useCallback(() => {
    setRange(defaultDateRange());
  }, [setRange]);

  return {
    range,
    setRange,
    setAllTime,
    resetDefault,
    allTime: isAllTime(range),
  };
}
