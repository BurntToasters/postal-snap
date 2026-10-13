import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./root.css";

// Set before the first paint so native caption areas never cover controls.
document.documentElement.dataset.platform = /Mac/i.test(navigator.userAgent)
  ? "macos"
  : /Windows/i.test(navigator.userAgent)
    ? "windows"
    : "linux";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary className="crash-recovery startup-recovery">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
