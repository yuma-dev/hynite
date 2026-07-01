import { BrowserWindow, session } from "electron";
import type { SourceFetchDiagnostic, SourceFetchPhase } from "@hynite/core";
import { classifySourcePage } from "@hynite/source-search";

// A persistent partition so the Cloudflare `cf_clearance` cookie (bound to this
// UA + the partition) survives between refreshes. After the first manual solve,
// subsequent refreshes often sail straight through without another challenge.
const SOURCE_FETCH_PARTITION = "persist:source-fetch";

const POLL_INTERVAL_MS = 1200;
// Generous overall cap so a forgotten window can't linger forever, while still
// leaving plenty of time for a human to work through a captcha.
const MAX_RUN_MS = 10 * 60 * 1000;
// How long a bot-check must persist before we reveal the window. Cloudflare's
// managed / Turnstile challenges frequently auto-solve within a few seconds with
// no interaction — if we revealed on first detection the window would flash on
// every successful pass. So we wait this long: an auto-solving challenge reaches
// the JSON first and the window never shows; a real interactive one is revealed.
const CHALLENGE_REVEAL_DELAY_MS = 6000;
// Absolute backstop: if we're still stuck after this long in some state our
// detector doesn't recognise as a challenge, reveal anyway so the user isn't
// staring at nothing.
const FALLBACK_REVEAL_MS = 11000;

// Silent (background) mode: never show a window. If a challenge can't auto-solve
// within this window, give up and report that manual verification is needed.
const SILENT_CHALLENGE_TIMEOUT_MS = 15000;
// Overall cap for a silent attempt so a daily sweep of several sources can't hang.
const SILENT_OVERALL_TIMEOUT_MS = 45000;

/**
 * Thrown by a silent fetch when a source is gated behind a bot-check that won't
 * auto-solve — i.e. the user must open it and pass verification by hand.
 */
export class ManualVerificationRequiredError extends Error {
  readonly needsVerification = true;
  constructor(message = "This source needs manual verification (bot check).") {
    super(message);
    this.name = "ManualVerificationRequiredError";
  }
}

/**
 * Clear the persisted bot-check session (cookies, storage) for the source-fetch
 * browser. Forces Cloudflare to re-issue its challenge on the next fetch — useful
 * as a recovery escape hatch when a stale clearance cookie misbehaves.
 */
export async function clearSourceFetchSession(): Promise<void> {
  await session.fromPartition(SOURCE_FETCH_PARTITION).clearStorageData();
}

export type SourceFetchResult = {
  json: string;
  name: string;
  rawLength: number;
};

export type FetchSourceOptions = {
  url: string;
  parent?: BrowserWindow;
  onDiagnostic?: (diagnostic: SourceFetchDiagnostic) => void;
  /**
   * Background mode: never reveal the window. If a bot-check doesn't auto-solve
   * quickly, reject with {@link ManualVerificationRequiredError} instead of
   * waiting for a human. Used by the daily auto-refresh sweep.
   */
  silent?: boolean;
};

// Reads document title + does an in-page same-origin fetch of the URL (with
// cookies) so we get the *exact* bytes once Cloudflare is cleared, rather than
// scraping DOM-rendered text. Falls back to the rendered body when a background
// fetch is re-challenged but the visible document already shows the JSON.
const PROBE_SCRIPT = `(async () => {
  const out = { url: location.href, title: document.title || "" };
  const bodyText = (document.body && document.body.innerText) ? document.body.innerText : "";
  const docTrimmed = bodyText.replace(/^\\s+/, "");
  const docLooksJson = docTrimmed[0] === '{' || docTrimmed[0] === '[';
  try {
    const r = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
    out.status = r.status;
    out.text = await r.text();
  } catch (e) {
    out.fetchError = String(e);
  }
  const fetched = (out.text || "").replace(/^\\s+/, "");
  const fetchLooksJson = fetched[0] === '{' || fetched[0] === '[';
  if (docLooksJson && !fetchLooksJson) {
    out.text = bodyText;
    out.usedDoc = true;
  }
  return out;
})()`;

type ProbeResult = {
  url: string;
  title: string;
  status?: number;
  text?: string;
  fetchError?: string;
  usedDoc?: boolean;
};

export function fetchSourceViaBrowser(options: FetchSourceOptions): Promise<SourceFetchResult> {
  const { url, parent, onDiagnostic, silent = false } = options;

  return new Promise<SourceFetchResult>((resolve, reject) => {
    const startedAt = Date.now();
    let seq = 0;
    let lastChallengeReason: string | undefined;
    let challengeSince: number | undefined;
    let settled = false;
    let probing = false;

    const emit = (phase: SourceFetchPhase, message: string, detail?: string): void => {
      seq += 1;
      const diagnostic: SourceFetchDiagnostic = { seq, at: Date.now() - startedAt, phase, message, detail };
      // Always log on the main side too, so a failed run leaves a trail even if
      // the renderer panel was closed.
      console.info(`[source:fetch] +${diagnostic.at}ms [${phase}] ${message}${detail ? ` — ${detail}` : ""}`);
      try {
        onDiagnostic?.(diagnostic);
      } catch (error) {
        console.warn("[source:fetch] diagnostic sink threw:", error);
      }
    };

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error(`Not a valid URL: ${url}`));
      return;
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      reject(new Error(`Source URL must be http(s): ${url}`));
      return;
    }

    emit("opening", "Opening source in a built-in browser window", parsedUrl.origin);

    const win = new BrowserWindow({
      width: 1024,
      height: 760,
      minWidth: 640,
      minHeight: 480,
      parent,
      // Stay hidden on the happy path: if the source loads without a bot-check
      // (or one that auto-solves), the user never sees a window at all. We reveal
      // only when a challenge persists long enough to clearly need a human.
      show: false,
      skipTaskbar: silent,
      title: "Fetch source — solve the human check, then wait",
      autoHideMenuBar: true,
      webPreferences: {
        partition: SOURCE_FETCH_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    let revealed = false;
    const reveal = (why: string): void => {
      if (revealed || settled || win.isDestroyed() || silent) {
        return;
      }
      revealed = true;
      win.show();
      win.focus();
      emit("challenge", "Bot check needs you — solve it in the window, then wait", why);
    };

    const timeoutTimer = setTimeout(() => {
      settle(new Error(
        silent
          ? "Timed out fetching the source in the background."
          : "Timed out waiting for the source to load (10 min). The window was left open in case you want to retry."
      ));
    }, silent ? SILENT_OVERALL_TIMEOUT_MS : MAX_RUN_MS);

    // Absolute backstop for states we don't recognise as a challenge (interactive only).
    const fallbackRevealTimer = silent
      ? undefined
      : setTimeout(() => reveal("Taking longer than expected — continue here if a check is shown"), FALLBACK_REVEAL_MS);

    let pollTimer: ReturnType<typeof setInterval> | undefined;

    function settle(error: Error | undefined, result?: SourceFetchResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(fallbackRevealTimer);
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (error) {
        emit("error", error.message);
        reject(error);
      } else if (result) {
        resolve(result);
      }
      if (!win.isDestroyed()) {
        win.close();
      }
    }

    async function probe(): Promise<void> {
      if (settled || probing || win.isDestroyed()) {
        return;
      }
      probing = true;
      try {
        const result = (await win.webContents.executeJavaScript(PROBE_SCRIPT, true)) as ProbeResult;
        if (settled) {
          return;
        }

        if (result.fetchError && !result.text) {
          emit("probing", "In-page fetch failed; will retry", result.fetchError);
          return;
        }

        const classification = classifySourcePage(result.text, result.title);
        switch (classification.kind) {
          case "loading":
            emit("probing", "Waiting for source content", `${classification.reason}${result.status ? ` (HTTP ${result.status})` : ""}`);
            return;
          case "challenge": {
            // First sighting: note when, and log it once (quietly — it may well
            // auto-solve before we ever show anything).
            if (challengeSince === undefined) {
              challengeSince = Date.now();
              emit("challenge", "Bot check in progress (may auto-solve)…", classification.reason);
            } else if (classification.reason !== lastChallengeReason) {
              emit("challenge", "Bot check still in progress…", classification.reason);
            }
            lastChallengeReason = classification.reason;
            const heldFor = Date.now() - challengeSince;
            if (silent) {
              // Background sweep: don't wait for a human — flag it and move on.
              if (heldFor >= SILENT_CHALLENGE_TIMEOUT_MS) {
                settle(new ManualVerificationRequiredError(`Bot check did not auto-solve (${classification.reason}).`));
              }
            } else if (heldFor >= CHALLENGE_REVEAL_DELAY_MS) {
              // Only reveal once it's clearly not auto-solving.
              reveal(classification.reason);
            }
            return;
          }
          case "invalid":
            settle(new Error(classification.reason));
            return;
          case "json": {
            const text = (result.text ?? "").trim();
            emit("extracting", "Source JSON received", `${classification.rawLength.toLocaleString()} chars${result.usedDoc ? " (from page text)" : ""}`);
            emit("validating", `Parsed "${classification.source.name}"`, `${classification.source.downloads.length.toLocaleString()} downloads`);
            emit("success", challengeSince === undefined ? "Fetched source (no bot check)" : "Bot check passed — source fetched");
            settle(undefined, { json: text, name: classification.source.name, rawLength: classification.rawLength });
            return;
          }
        }
      } catch (error) {
        // executeJavaScript can transiently fail mid-navigation; keep polling.
        emit("probing", "Probe error (will retry)", error instanceof Error ? error.message : String(error));
      } finally {
        probing = false;
      }
    }

    win.webContents.on("did-finish-load", () => {
      if (settled) {
        return;
      }
      emit("loaded", "Page loaded", win.webContents.getURL());
      void probe();
    });

    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (settled || !isMainFrame) {
        return;
      }
      // -3 (ABORTED) is normal during challenge redirects; don't treat as fatal.
      if (errorCode === -3) {
        return;
      }
      emit("probing", "Navigation reported an error (will keep waiting)", `${errorDescription} (${errorCode}) @ ${validatedURL}`);
    });

    win.on("closed", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(fallbackRevealTimer);
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        emit("cancelled", "Window closed before the source was fetched");
        reject(new Error("Source fetch was cancelled."));
      }
    });

    pollTimer = setInterval(() => void probe(), POLL_INTERVAL_MS);

    void win.loadURL(url).catch((error: unknown) => {
      emit("probing", "Initial load threw (will keep waiting)", error instanceof Error ? error.message : String(error));
    });
  });
}
