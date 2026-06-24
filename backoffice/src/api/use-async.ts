import { useEffect, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Run an abortable loader on mount (and when `key` changes); expose
 *  data/error/loading. Aborts on unmount so a late resolution can't setState. */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, key: unknown = null): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    loader(ac.signal)
      .then((data) => {
        if (!ac.signal.aborted) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) {
          setState({ data: null, error: e instanceof Error ? e.message : 'failed to load', loading: false });
        }
      });
    return () => ac.abort();
    // Re-run only when `key` changes; `loader` is captured intentionally.
  }, [key]);

  return state;
}
