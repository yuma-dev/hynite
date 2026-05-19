import { userInfo } from "node:os";
import * as Sentry from "@sentry/electron/main";
import { app } from "electron";
import {
  SENTRY_DSN,
  createScrubber,
  sentryEnvironment,
  sentryRelease
} from "../shared/observability";

let initialized = false;

/**
 * Initialize crash/error reporting to the self-hosted GlitchTip instance.
 * Call as early as possible in the main entry so early crashes are captured.
 *
 * @sentry/electron/main auto-captures uncaughtException, unhandledRejection,
 * native minidumps, and child/renderer process crashes. Renderer events are
 * routed through this process, so the single `beforeSend` scrubber here covers
 * both processes.
 */
export function initMainObservability(): void {
  if (initialized) return;
  initialized = true;

  // Escape hatch for debugging / privacy: HYNITE_DISABLE_SENTRY=1 skips init.
  if (process.env.HYNITE_DISABLE_SENTRY === "1") {
    console.log("Sentry disabled via HYNITE_DISABLE_SENTRY");
    return;
  }

  let homeDir = "";
  let username = "";
  try {
    const info = userInfo();
    username = info.username ?? "";
    homeDir = info.homedir ?? "";
  } catch {
    // userInfo can throw on locked-down accounts; scrub by username only.
  }

  const scrub = createScrubber(homeDir, username);

  // Crash/error reporting only. Performance tracing is deliberately off — the
  // built-in profiler (npm run dev:profile) is the optimization tool; a generic
  // pageload transaction adds runtime cost without actionable signal.
  Sentry.init({
    dsn: SENTRY_DSN,
    release: sentryRelease(app.getVersion()),
    environment: sentryEnvironment(app.isPackaged),
    sendDefaultPii: false,
    beforeSend: scrub
  });
}

/**
 * Honor the user's crash-reporting opt-out once settings have loaded.
 * Sentry is initialized early (before settings exist); flip it here.
 */
export function setObservabilityEnabled(enabled: boolean): void {
  const client = Sentry.getClient();
  if (!client) return;
  client.getOptions().enabled = enabled;
}
