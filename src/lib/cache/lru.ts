/**
 * Tiny in-memory LRU with TTL. Zero deps.
 *
 * Used by the reference-data proxy routes
 * (`src/app/api/refdata/*`) to avoid hammering 8vance for every
 * autocomplete keystroke.
 *
 * Implementation notes:
 *   - Uses a `Map` for insertion-ordered iteration so we can evict the
 *     oldest entry in O(1) once `max` is reached.
 *   - On every `get`, the entry is removed and re-inserted to bump its
 *     recency (Map preserves insertion order).
 *   - Each entry carries its own `expiresAt`. Expired entries are evicted
 *     lazily on access (no background timer).
 */
export interface LruOptions {
  /** Maximum number of entries to retain. Must be >= 1. */
  max: number;
  /** Per-entry TTL in milliseconds. Must be > 0. */
  ttlMs: number;
}

export interface Lru<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createLru<T>(opts: LruOptions): Lru<T> {
  if (!Number.isFinite(opts.max) || opts.max < 1) {
    throw new Error("createLru: max must be a positive integer");
  }
  if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
    throw new Error("createLru: ttlMs must be a positive number");
  }
  const { max, ttlMs } = opts;
  const store = new Map<string, Entry<T>>();

  function get(key: string): T | undefined {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    // Bump recency: re-insert at the tail.
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  }

  function set(key: string, value: T): void {
    if (store.has(key)) store.delete(key);
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Evict oldest until under cap.
    while (store.size > max) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  function del(key: string): boolean {
    return store.delete(key);
  }

  function clear(): void {
    store.clear();
  }

  return {
    get,
    set,
    delete: del,
    clear,
    get size(): number {
      return store.size;
    },
  };
}
