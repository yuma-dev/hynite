import { app } from "electron";
import type { BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

const EMIT_THROTTLE_MS = 300;
const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdaterStatus {
  phase: UpdaterPhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
  /** False in dev builds / when no update feed exists — UI hides the pill. */
  supported: boolean;
  checkedAt?: string;
}

interface UpdateInfoLike {
  version: string;
}

interface ProgressInfoLike {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

type UpdaterLog = (level: "info" | "warning" | "error", message: string, details?: Record<string, unknown>) => void;

/**
 * Wraps electron-updater for the sidebar "Update available" flow:
 * check in the background, let the user trigger the download from the pill,
 * then a silent NSIS install + relaunch. No installer UI is ever shown
 * because the build uses a one-click NSIS target.
 */
export class UpdaterService {
  private status: UpdaterStatus;
  private emitTimer?: NodeJS.Timeout;
  private checkTimer?: NodeJS.Timeout;
  private downloadStarted = false;
  private wired = false;

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly options: { log?: UpdaterLog } = {}
  ) {
    this.status = {
      phase: "idle",
      currentVersion: app.getVersion(),
      supported: app.isPackaged
    };
  }

  get(): UpdaterStatus {
    return { ...this.status };
  }

  /** Attach listeners, run the first check, and schedule periodic checks. No-op in dev. */
  start(): void {
    if (this.wired) {
      return;
    }
    this.wired = true;

    if (!app.isPackaged) {
      this.options.log?.("info", "Updater disabled in development build");
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (message: unknown) => this.options.log?.("info", String(message)),
      warn: (message: unknown) => this.options.log?.("warning", String(message)),
      error: (message: unknown) => this.options.log?.("error", String(message)),
      debug: () => {}
    };

    autoUpdater.on("checking-for-update", () => {
      this.set({ phase: "checking", error: undefined });
    });
    autoUpdater.on("update-available", (info: UpdateInfoLike) => {
      this.set({ phase: "available", availableVersion: info.version, error: undefined });
    });
    autoUpdater.on("update-not-available", () => {
      this.set({ phase: "not-available", availableVersion: undefined });
    });
    autoUpdater.on("download-progress", (progress: ProgressInfoLike) => {
      this.set({
        phase: "downloading",
        percent: Math.round(progress.percent),
        bytesPerSecond: Math.round(progress.bytesPerSecond),
        transferred: progress.transferred,
        total: progress.total
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfoLike) => {
      this.set({ phase: "downloaded", availableVersion: info.version, percent: 100 });
    });
    autoUpdater.on("error", (error: Error) => {
      this.downloadStarted = false;
      this.set({ phase: "error", error: error?.message ?? String(error) });
    });

    void this.check();
    this.checkTimer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  async check(): Promise<void> {
    if (!app.isPackaged) {
      return;
    }
    try {
      this.status.checkedAt = new Date().toISOString();
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  async download(): Promise<void> {
    if (!app.isPackaged || this.downloadStarted) {
      return;
    }
    if (this.status.phase !== "available" && this.status.phase !== "error") {
      return;
    }
    this.downloadStarted = true;
    this.set({ phase: "downloading", percent: 0, error: undefined });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.downloadStarted = false;
      this.set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }

  install(): void {
    if (!app.isPackaged || this.status.phase !== "downloaded") {
      return;
    }
    // One-click NSIS installs silently; isForceRunAfter relaunches the app.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  dispose(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    autoUpdater.removeAllListeners();
  }

  private set(patch: Partial<UpdaterStatus>): void {
    this.status = { ...this.status, ...patch };
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.emitTimer) {
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      const window = this.getWindow();
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("updater:status", this.get());
      }
    }, EMIT_THROTTLE_MS);
  }
}
