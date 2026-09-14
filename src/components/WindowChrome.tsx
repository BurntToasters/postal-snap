import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Square, Minus, X } from "lucide-react";
import { inTauri } from "../api";
import { strings } from "../i18n";
import { closesToTrayOnClose } from "../settings";
import { useAppStore } from "../store";

/** Native caption actions stay outside the application's modal/inert layers. */
export function WindowChrome() {
  const [restorable, setRestorable] = useState(false);
  const [snapHovered, setSnapHovered] = useState(false);
  const maximizeButtonRef = useRef<HTMLButtonElement>(null);
  const actions = useRef<{
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
  } | null>(null);
  const setError = useAppStore((state) => state.setError);
  const hideOnClose = useAppStore((state) =>
    closesToTrayOnClose(state.settings),
  );

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

  useEffect(() => {
    if (!inTauri() || document.documentElement.dataset.platform !== "windows")
      return;
    const maximizeButton = maximizeButtonRef.current;
    if (!maximizeButton) return;

    let active = true;
    let frame = 0;
    let stopHover: (() => void) | undefined;
    const reportBounds = () => {
      frame = 0;
      const bounds = maximizeButton.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const visible =
        maximizeButton.offsetParent !== null &&
        bounds.width > 0 &&
        bounds.height > 0;
      void invoke("set_snap_overlay_bounds", {
        x: visible ? Math.round(bounds.left * scale) : 0,
        y: visible ? Math.round(bounds.top * scale) : 0,
        width: visible ? Math.round(bounds.width * scale) : 0,
        height: visible ? Math.round(bounds.height * scale) : 0,
      }).catch(() => undefined);
    };
    const scheduleBounds = () => {
      if (frame) return;
      frame = requestAnimationFrame(reportBounds);
    };

    void listen<boolean>("snap-max-hover", ({ payload }) => {
      if (active) setSnapHovered(payload === true);
    })
      .then((stop) => {
        if (active) stopHover = stop;
        else stop();
      })
      .catch(() => undefined);
    const observer = new ResizeObserver(scheduleBounds);
    observer.observe(maximizeButton);
    if (maximizeButton.parentElement)
      observer.observe(maximizeButton.parentElement);
    window.addEventListener("resize", scheduleBounds);
    scheduleBounds();

    return () => {
      active = false;
      stopHover?.();
      observer.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      if (frame) cancelAnimationFrame(frame);
      void invoke("set_snap_overlay_bounds", {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }).catch(() => undefined);
    };
  }, []);

  if (!inTauri()) return null;
  const run = (action: "minimize" | "maximize" | "close") => {
    void actions.current?.[action]().catch(() =>
      setError(strings.window.actionFailed),
    );
  };
  return (
    <div className="window-chrome" data-context="chrome">
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
          ref={maximizeButtonRef}
          id="maximize-window-button"
          type="button"
          className={snapHovered ? "snap-hover" : undefined}
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
          aria-label={
            hideOnClose ? strings.window.hideToTray : strings.window.close
          }
          title={hideOnClose ? strings.window.hideToTray : strings.window.close}
          onClick={() => run("close")}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
