// Native window blur: Windows Mica / Acrylic. macOS keeps opaque chrome
// because transparent WKWebView requires the private macos-private-api
// feature, which stays off for the store train. Linux is a no-op.

import { invoke } from "@tauri-apps/api/core";
import type { NativeCommand } from "./api";

let lastSync: { enabled: boolean; isDark: boolean } | undefined;
let accessibilityListenersInstalled = false;
let reduceTransparencyPoll: number | undefined;
let lastNativeReduceTransparency: boolean | undefined;

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

export async function syncWorkspaceWindowFx(
  enabled = false,
  isDark = false,
): Promise<void> {
  lastSync = { enabled, isDark };
  if (!accessibilityListenersInstalled && typeof window !== "undefined") {
    accessibilityListenersInstalled = true;
    for (const query of [
      "(prefers-reduced-transparency: reduce)",
      "(prefers-contrast: more)",
    ]) {
      const media = window.matchMedia?.(query);
      media?.addEventListener("change", () => {
        if (lastSync)
          void syncWorkspaceWindowFx(lastSync.enabled, lastSync.isDark);
      });
    }
  }
  const supports = await supportsWorkspaceWindowFx();
  const nativeReduce = await nativeReduceTransparency();
  lastNativeReduceTransparency = nativeReduce;
  if (
    supports &&
    reduceTransparencyPoll === undefined &&
    typeof window !== "undefined"
  ) {
    reduceTransparencyPoll = window.setInterval(() => {
      void (async () => {
        if (!lastSync) return;
        const reduce = await nativeReduceTransparency();
        if (reduce === lastNativeReduceTransparency) return;
        lastNativeReduceTransparency = reduce;
        await syncWorkspaceWindowFx(lastSync.enabled, lastSync.isDark);
      })();
    }, 10_000);
  }
  const reducedTransparency =
    nativeReduce ||
    (window.matchMedia?.("(prefers-reduced-transparency: reduce)")?.matches ??
      false);
  const increasedContrast =
    window.matchMedia?.("(prefers-contrast: more)")?.matches ?? false;
  const active =
    supports && enabled && !reducedTransparency && !increasedContrast;
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
