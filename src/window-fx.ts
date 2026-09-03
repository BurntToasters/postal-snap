// FUTURE IMPLEMENTATION: Native window blur / vibrancy (macOS vibrancy / Windows Mica·Acrylic).
// Everything but the rendered email will have it.
// Linux is intentionally a no-op; stays fully opaque there.
// Mirrored from Zinnia (parent directory).

import { invoke } from "@tauri-apps/api/core";

export async function supportsWorkspaceWindowFx(): Promise<boolean> {
  try {
    return await invoke<boolean>("supports_workspace_window_fx");
  } catch {
    return false;
  }
}

export async function syncWorkspaceWindowFx(
  enabled = false,
  isDark = false,
): Promise<void> {
  const supports = await supportsWorkspaceWindowFx();
  const active = supports && enabled;
  document.documentElement.dataset.windowFx = active ? "vibrant" : "opaque";

  try {
    await invoke("set_workspace_window_fx", { enabled: active, dark: isDark });
  } catch {
    // Graceful fallback: CSS continues to look crisp and accessible if OS effect is unavailable.
  }
}
