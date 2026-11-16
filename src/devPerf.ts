import { rememberedSessionKeys } from "./accountSessions";

// DEV-only probe for e2e: render counts and remembered session keys.
interface PerfProbe {
  renders: Record<string, number>;
  /** Per-key counts, e.g. one entry per message row. */
  rowRenders: Record<string, Record<string, number>>;
  sessionKeys: () => Record<string, string[]>;
}

const probe: PerfProbe = {
  renders: {},
  rowRenders: {},
  sessionKeys: rememberedSessionKeys,
};

if (import.meta.env.DEV) {
  (
    window as unknown as { __POSTAL_SNAP_PERF__: PerfProbe }
  ).__POSTAL_SNAP_PERF__ = probe;
}

export function recordRender(name: string, key?: string): void {
  if (!import.meta.env.DEV) return;
  probe.renders[name] = (probe.renders[name] ?? 0) + 1;
  if (key === undefined) return;
  const rows = (probe.rowRenders[name] ??= {});
  rows[key] = (rows[key] ?? 0) + 1;
}
