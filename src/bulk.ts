/** Most messages one bulk action may touch. Must match `MAX_BULK_MESSAGES` in Rust. */
export const BULK_LIMIT = 200;

/**
 * Tracks the latest optimistic write per key. A rollback from an older write
 * is dropped when a newer write for the same key has started.
 */
export function createOptimisticGate<K>() {
  const latest = new Map<K, number>();
  return {
    begin(key: K): number {
      const generation = (latest.get(key) ?? 0) + 1;
      latest.set(key, generation);
      return generation;
    },
    isLatest(key: K, generation: number): boolean {
      return latest.get(key) === generation;
    },
  };
}
