// Native window blur / vibrancy (macOS vibrancy / Windows Mica / Acrylic).
// Everything but the rendered email will have it.
// Linux is intentionally a no-op; stays fully opaque there.

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
    // Native effect unavailable: keep CSS and document state opaque so
    // translucent chrome never claims glass without a working backend.
    document.documentElement.dataset.windowFx = "opaque";
  }
}
