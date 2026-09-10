import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Square, Minus, X } from "lucide-react";
import { inTauri } from "../api";
import { strings } from "../i18n";
import { useAppStore } from "../store";

/** Native caption actions stay outside the application's modal/inert layers. */
export function WindowChrome() {
  const [restorable, setRestorable] = useState(false);
  const actions = useRef<{
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  } | null>(null);
  const setError = useAppStore((state) => state.setError);

  useEffect(() => {
    if (!inTauri()) return;
    const appWindow = getCurrentWindow();
    let active = true;
    let request = 0;
    let stopResize: (() => void) | undefined;
    const syncState = async () => {
      const current = ++request;
      const [maximized, fullscreen] = await Promise.all([
        appWindow.isMaximized(),
        appWindow.isFullscreen(),
      ]);
      if (active && current === request) {
        setRestorable(maximized || fullscreen);
        document.documentElement.dataset.windowFullscreen = String(fullscreen);
      }
    };
    const reportError = () => {
      if (active) setError(strings.window.actionFailed);
    };
    const resize = () => void syncState().catch(reportError);
    actions.current = {
      minimize: () => appWindow.minimize(),
      maximize: async () => {
        if (await appWindow.isFullscreen())
          await appWindow.setFullscreen(false);
        else await appWindow.toggleMaximize();
        await syncState();
      },
      // CloseRequested owns platform-specific close/hide behavior in Rust.
      close: () => appWindow.close(),
    };
    resize();
    void appWindow
      .onResized(resize)
      .then((stop) => {
        if (active) stopResize = stop;
        else stop();
      })
      .catch(reportError);
    return () => {
      active = false;
      request++;
      stopResize?.();
      actions.current = null;
    };
  }, [setError]);

  if (!inTauri()) return null;
  const run = (action: "minimize" | "maximize" | "close") => {
    void actions.current?.[action]().catch(() =>
      setError(strings.window.actionFailed),
    );
  };
  return (
    <div className="window-chrome">
      <div
        className="window-drag-strip"
        data-tauri-drag-region="deep"
        aria-hidden="true"
      />
      <div
        className="global-window-caption-controls"
        role="group"
        aria-label={strings.window.controls}
        data-tauri-drag-region="false"
      >
        <button
          type="button"
          aria-label={strings.window.minimize}
          title={strings.window.minimize}
          onClick={() => run("minimize")}
        >
          <Minus aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={
            restorable ? strings.window.restore : strings.window.maximize
          }
          title={restorable ? strings.window.restore : strings.window.maximize}
          onClick={() => run("maximize")}
        >
          {restorable ? (
            <Copy aria-hidden="true" />
          ) : (
            <Square aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="window-close-button"
          aria-label={strings.window.close}
          title={strings.window.close}
          onClick={() => run("close")}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
