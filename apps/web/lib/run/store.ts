/**
 * Key-value store over localStorage that never throws and keeps working when storage is unavailable
 * (private mode, blocked cookies, quota, SSR). Every access is try/caught. Writes go through an
 * in-memory map, so within one page session reads always see the latest value even if the browser
 * refused to persist it (the run still resumes after a re-render, just not after a reload).
 *
 * Ownership: main thread only (workers have no access to the run's storage). O(1) per call.
 */

export interface KeyValueStore {
  get(key: string): string | null;
  /** false when the browser refused the write (value is still readable this session). */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  /** true while the last write reached real storage (false once storage failed or is unavailable). */
  readonly persistent: boolean;
}

/** Memory-only store (SSR, tests, fallback). */
export function createMemoryStore(): KeyValueStore {
  return createStore(() => {
    throw new Error("memory store: no backing storage");
  });
}

/** localStorage when present, memory fallback otherwise. */
export function createBrowserStore(): KeyValueStore {
  return createStore(() => window.localStorage);
}

/**
 * Store over whatever `getStorage` returns. `getStorage` itself may throw (the localStorage getter
 * does in some browsers), as may every Storage method.
 */
export function createStore(getStorage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">): KeyValueStore {
  // null = removed this session (tombstone), so a failed removeItem cannot resurrect the old value.
  const mem = new Map<string, string | null>();
  let persistent = true;
  const storage = (): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null => {
    try {
      return getStorage();
    } catch {
      return null;
    }
  };
  return {
    get persistent() {
      return persistent;
    },
    get(key) {
      if (mem.has(key)) return mem.get(key) ?? null;
      const s = storage();
      if (s === null) return null;
      try {
        return s.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      mem.set(key, value);
      const s = storage();
      if (s === null) {
        persistent = false;
        return false;
      }
      try {
        s.setItem(key, value);
        persistent = true;
        return true;
      } catch {
        persistent = false;
        return false;
      }
    },
    remove(key) {
      mem.set(key, null);
      const s = storage();
      if (s === null) return;
      try {
        s.removeItem(key);
      } catch {
        persistent = false;
      }
    },
  };
}
