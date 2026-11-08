// Native window blur: Windows Mica and macOS vibrancy (direct builds).
// Linux is a no-op. Opaque chrome is the fallback everywhere else.

import { invoke } from "@tauri-apps/api/core";
import type { NativeCommand } from "./api";

const ACCESSIBILITY_QUERIES = [
  "(prefers-reduced-transparency: reduce)",
  "(prefers-contrast: more)",
  "(forced-colors: active)",
];
const REDUCE_POLL_MS = 10_000;

let lastSync: { enabled: boolean; isDark: boolean } | undefined;
let accessibilityBound = false;
let reduceTransparencyPoll: number | undefined;
let lastNativeReduceTransparency: boolean | undefined;

// One stable handler bound once: listeners never stack across syncs.
function onAccessibilityChange() {
  if (lastSync) void syncWorkspaceWindowFx(lastSync.enabled, lastSync.isDark);
}

function bindAccessibilityListeners() {
  if (accessibilityBound || typeof window === "undefined") return;
  accessibilityBound = true;
  for (const query of ACCESSIBILITY_QUERIES) {
    const media = window.matchMedia?.(query);
    media?.addEventListener("change", onAccessibilityChange);
  }
}

function nativeInvoke<T>(
  command: NativeCommand,
  args?: Record<string, unknown>,
): Promise<T> {
  return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
}

async function nativeReduceTransparency(): Promise<boolean> {
  try {
    return await nativeInvoke<boolean>("accessibility_reduce_transparency");
  } catch {
    return false;
  }
}

export async function supportsWorkspaceWindowFx(): Promise<boolean> {
  try {
    return await nativeInvoke<boolean>("supports_workspace_window_fx");
  } catch {
    return false;
  }
}

// WKWebView lacks the reduce-transparency media query, so macOS polls Rust.
function stopReduceTransparencyPoll() {
  if (reduceTransparencyPoll === undefined) return;
  window.clearInterval(reduceTransparencyPoll);
  reduceTransparencyPoll = undefined;
}

function startReduceTransparencyPoll() {
  if (reduceTransparencyPoll !== undefined) return;
  reduceTransparencyPoll = window.setInterval(() => {
    void (async () => {
      if (!lastSync) return;
      const reduce = await nativeReduceTransparency();
      if (reduce === lastNativeReduceTransparency) return;
      lastNativeReduceTransparency = reduce;
      await syncWorkspaceWindowFx(lastSync.enabled, lastSync.isDark);
    })();
  }, REDUCE_POLL_MS);
}

export async function syncWorkspaceWindowFx(
  enabled = false,
  isDark = false,
): Promise<void> {
  lastSync = { enabled, isDark };
  bindAccessibilityListeners();
  const supports = await supportsWorkspaceWindowFx();
  const nativeReduce = await nativeReduceTransparency();
  lastNativeReduceTransparency = nativeReduce;
  const macos = document.documentElement.dataset.platform === "macos";
  if (supports && enabled && macos) startReduceTransparencyPoll();
  else stopReduceTransparencyPoll();
  const reducedTransparency =
    nativeReduce ||
    (window.matchMedia?.("(prefers-reduced-transparency: reduce)")?.matches ??
      false);
  const increasedContrast =
    window.matchMedia?.("(prefers-contrast: more)")?.matches ?? false;
  const forcedColors =
    window.matchMedia?.("(forced-colors: active)")?.matches ?? false;
  // WKWebView lacks the media query; CSS reads the native answer here.
  document.documentElement.dataset.reduceTransparency =
    String(reducedTransparency);
  const active =
    supports &&
    enabled &&
    !reducedTransparency &&
    !increasedContrast &&
    !forcedColors;
  document.documentElement.dataset.windowFx = active ? "vibrant" : "opaque";

  try {
    const effective = await nativeInvoke<boolean>("set_workspace_window_fx", {
      enabled: active,
      dark: isDark,
    });
    document.documentElement.dataset.windowFx =
      typeof effective === "boolean"
        ? effective
          ? "vibrant"
          : "opaque"
        : active
          ? "vibrant"
          : "opaque";
  } catch {
    // Native effect unavailable: keep CSS and document state opaque so
    // translucent chrome never claims glass without a working backend.
    document.documentElement.dataset.windowFx = "opaque";
  }
}
