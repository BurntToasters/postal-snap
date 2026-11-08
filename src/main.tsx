import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { errorText } from "./errors";
import { applyResolvedTheme, cachedThemeSetting } from "./settings";
import { useAppStore } from "./store";
import "./root.css";

// Set before the first paint so native caption areas never cover controls.
document.documentElement.dataset.platform = /Mac/i.test(navigator.userAgent)
  ? "macos"
  : /Windows/i.test(navigator.userAgent)
    ? "windows"
    : "linux";

// Resolve the theme before first paint; applySettings corrects it once loaded.
applyResolvedTheme(cachedThemeSetting());

// Uncaught failures show as the error notice; the page keeps running.
function surfaceUncaught(cause: unknown) {
  useAppStore.getState().setError(errorText(cause));
}

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  surfaceUncaught(event.reason);
});

window.addEventListener("error", (event) => {
  event.preventDefault();
  surfaceUncaught(event.error ?? event.message);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary className="crash-recovery startup-recovery">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
