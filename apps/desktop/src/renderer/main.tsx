import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { profileStartup, startRendererHeartbeat } from "./startupProfile";
import "./styles.css";

startRendererHeartbeat();
profileStartup("renderer:module", "Renderer entry evaluated");
window.addEventListener("error", (event) => {
  profileStartup("renderer:error", event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});
window.addEventListener("unhandledrejection", (event) => {
  profileStartup("renderer:unhandled-rejection", "Unhandled renderer promise rejection", {
    reason: event.reason instanceof Error ? event.reason.message : String(event.reason)
  });
});

profileStartup("react:render:start", "Mounting React root");
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
profileStartup("react:render:queued", "React root render queued");
