import React from "react";
import * as Sentry from "@sentry/electron/renderer";
import type { LaunchOutcome } from "../preload";

// Renderer events are forwarded to the main process, which owns the DSN,
// release, environment and scrubbing. So renderer init is intentionally
// minimal — no DSN/secrets live in renderer code. Performance tracing is
// deliberately not enabled; the built-in profiler (npm run dev:profile) is
// the optimization tool.
let initialized = false;

export function initRendererObservability(): void {
  if (initialized) return;
  initialized = true;
  Sentry.init({});
  installTestCrashHelper();
}

type LaunchFailureOutcome = Extract<LaunchOutcome, { kind: "launch-failed" }>;

export function reportLaunchFailure(failure: LaunchFailureOutcome): string {
  return Sentry.captureException(
    new Error(`Game launch failed: ${failure.gameTitle ?? failure.gameId}: ${failure.technicalMessage}`),
    {
      tags: {
        feature: "game-launch",
        gameId: failure.gameId,
        errorCode: failure.code ?? "unknown"
      },
      contexts: {
        launch: {
          gameId: failure.gameId,
          gameTitle: failure.gameTitle,
          message: failure.message,
          technicalMessage: failure.technicalMessage,
          code: failure.code,
          errno: failure.errno,
          syscall: failure.syscall,
          path: failure.path,
          command: failure.command,
          stack: failure.stack
        }
      }
    }
  );
}

/**
 * TEMPORARY — remove before the next release.
 * Verifies the GlitchTip pipeline end to end. In DevTools console run:
 *   __hyniteTestCrash()          → captured error (returns event id)
 *   __hyniteTestCrash("throw")   → uncaught error (exercises ErrorBoundary)
 */
function installTestCrashHelper(): void {
  window.__hyniteTestCrash = (mode = "captured") => {
    const stamp = new Date().toISOString();
    if (mode === "throw") {
      setTimeout(() => {
        throw new Error(`Hynite test crash (renderer uncaught) ${stamp}`);
      }, 0);
      return;
    }
    const id = Sentry.captureException(
      new Error(`Hynite test crash (renderer captured) ${stamp}`)
    );
    console.warn(`[hynite] test crash sent — GlitchTip event id: ${id}`);
    return id;
  };
}

type ErrorBoundaryProps = { children: React.ReactNode };
type ErrorBoundaryState = { hasError: boolean };

/**
 * Stops a render-time crash anywhere in the tree from white-screening the whole
 * app: reports to GlitchTip and shows a recoverable fallback instead.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack } }
    });
  }

  override render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          gap: "16px",
          color: "#e7e5ea",
          background: "#09080d",
          fontFamily: "system-ui, sans-serif"
        }}
      >
        <div style={{ fontSize: "18px", fontWeight: 600 }}>
          Something went wrong
        </div>
        <div style={{ opacity: 0.7, fontSize: "13px" }}>
          The issue was reported automatically.
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 20px",
            borderRadius: "8px",
            border: "1px solid #3a3742",
            background: "#1a1820",
            color: "inherit",
            cursor: "pointer",
            fontSize: "13px"
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
