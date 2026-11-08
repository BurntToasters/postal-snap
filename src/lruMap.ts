/** Session maps stop growing past this many entries. */
export const SESSION_LIMIT = 500;

/** Map capped at `limit`; reads and writes refresh recency, oldest evicted. */
export class LruMap<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of [...this.entries.keys()]) {
      if (predicate(key)) this.entries.delete(key);
    }
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }
}
