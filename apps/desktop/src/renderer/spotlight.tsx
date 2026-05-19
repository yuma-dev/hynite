import React from "react";
import ReactDOM from "react-dom/client";
import { SpotlightApp } from "./SpotlightApp";
import { ErrorBoundary, initRendererObservability } from "./observability";
import "./spotlight.css";

initRendererObservability();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SpotlightApp />
    </ErrorBoundary>
  </React.StrictMode>
);
