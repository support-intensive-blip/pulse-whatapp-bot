import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { dataApi } from '../api/client';

const BACKGROUND_PARAMS = { status: 'pending' };

let state = {
  items: [],
  counts: { pending: 0, done: 0, cancelled: 0, total: 0 },
  loading: true,
  refreshing: false,
  lastParams: BACKGROUND_PARAMS,
  error: null,
};

let listeners = new Set();
let pollTimer = null;
let subscriberCount = 0;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function countsToMap(rows) {
  const map = { pending: 0, done: 0, cancelled: 0, total: 0 };
  for (const row of rows || []) {
    if (row.status in map) {
      map[row.status] = row.count;
    }
    map.total += row.count;
  }
  return map;
}

export async function fetchActionItemsFeed(params = state.lastParams, { silent = false } = {}) {
  if (!silent) {
    state = {
      ...state,
      loading: state.items.length === 0,
      refreshing: state.items.length > 0,
    };
  } else {
    state = { ...state, refreshing: true };
  }
  emit();

  try {
    const data = await dataApi.actionItems(params);
    state = {
      ...state,
      items: data.items || [],
      counts: countsToMap(data.counts),
      loading: false,
      refreshing: false,
      lastParams: params,
      error: null,
    };
  } catch (error) {
    state = {
      ...state,
      loading: false,
      refreshing: false,
      error: error?.message || 'Failed to load action items',
    };
  }
  emit();
  return state;
}

function getPollInterval() {
  return document.visibilityState === 'visible' ? 10000 : 30000;
}

function schedulePoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    fetchActionItemsFeed(state.lastParams, { silent: true });
  }, getPollInterval());
}

function onVisibilityChange() {
  schedulePoll();
  if (document.visibilityState === 'visible') {
    fetchActionItemsFeed(state.lastParams, { silent: true });
  }
}

function subscribe(listener) {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) {
    fetchActionItemsFeed(BACKGROUND_PARAMS);
    schedulePoll();
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}

function getSnapshot() {
  return state;
}

export function useActionItemsFeed(queryParams = null) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!queryParams) return undefined;
    fetchActionItemsFeed(queryParams);
    return () => {
      fetchActionItemsFeed(BACKGROUND_PARAMS, { silent: true });
    };
  }, [JSON.stringify(queryParams)]);

  const refresh = useCallback(
    (params, opts) => fetchActionItemsFeed(params ?? state.lastParams, opts),
    []
  );

  const markDone = useCallback(async (id) => {
    const previousItems = state.items;
    state = {
      ...state,
      items: previousItems.map((item) =>
        item.id === id ? { ...item, status: 'done' } : item
      ),
      counts: {
        ...state.counts,
        pending: Math.max(0, state.counts.pending - 1),
        done: state.counts.done + 1,
      },
    };
    emit();

    try {
      await dataApi.updateActionItem(id, 'done');
      await fetchActionItemsFeed(state.lastParams, { silent: true });
    } catch {
      state = { ...state, items: previousItems };
      emit();
    }
  }, []);

  return {
    items: snapshot.items,
    counts: snapshot.counts,
    loading: snapshot.loading,
    refreshing: snapshot.refreshing,
    error: snapshot.error,
    pendingCount: snapshot.counts.pending,
    refresh,
    markDone,
  };
}
