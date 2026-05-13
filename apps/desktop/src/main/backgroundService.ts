import type { AppSettings, SyncResult } from "@hynite/core";
import type { LocalPlaytimeMonitor } from "./localPlaytimeMonitor";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const TRAY_STARTUP_DELAY_MS = 90_000;
const PREFETCH_STARTUP_DELAY_MS = 3 * MINUTE_MS;
const LOCAL_SCAN_STARTUP_DELAY_MS = 10 * MINUTE_MS;
const RICH_BACKFILL_DELAY_MS = 15 * MINUTE_MS;
const RESUME_PREFETCH_DEBOUNCE_MS = 5 * MINUTE_MS;
const STEAM_JITTER_MS = 15 * MINUTE_MS;

type BackgroundMode = "foreground" | "tray";
type BackgroundTrigger = "tray" | "timer" | "startup";

type BackgroundCadence = {
  steamIntervalMs: number;
  prefetchIntervalMs: number;
  localScanIntervalMs?: number;
  richBackfillLimit: number;
};

export type BackgroundServiceOptions = {
  getSettings: () => Promise<AppSettings>;
  startSteamSync: (providerId: "steam", options: { refreshStaleMetadata: false }) => Promise<SyncResult>;
  runLocalScan: () => Promise<unknown>;
  syncLocalLastPlayedFromPrefetch: () => Promise<number>;
  enqueueRichMetadataBackfill: (limit?: number) => void;
  localPlaytimeMonitor: LocalPlaytimeMonitor;
  isOnBatteryPower?: () => boolean;
  getSystemIdleTime?: () => number;
  cancelActiveSteamSync?: (reason?: string) => Promise<void>;
  profile?: (phase: string, message: string, details?: Record<string, unknown>) => void;
};

function cadenceFor(settings: AppSettings): BackgroundCadence {
  if (settings.backgroundWorkload === "minimum") {
    return {
      steamIntervalMs: 12 * HOUR_MS,
      prefetchIntervalMs: 4 * HOUR_MS,
      richBackfillLimit: 0
    };
  }
  if (settings.backgroundWorkload === "max") {
    return {
      steamIntervalMs: 3 * HOUR_MS,
      prefetchIntervalMs: HOUR_MS,
      localScanIntervalMs: 12 * HOUR_MS,
      richBackfillLimit: 100
    };
  }
  return {
    steamIntervalMs: 6 * HOUR_MS,
    prefetchIntervalMs: 2 * HOUR_MS,
    localScanIntervalMs: 24 * HOUR_MS,
    richBackfillLimit: 25
  };
}

function jitter(ms: number): number {
  return Math.round(ms + (Math.random() * STEAM_JITTER_MS * 2) - STEAM_JITTER_MS);
}

export class BackgroundService {
  private mode: BackgroundMode = "foreground";
  private stopped = true;
  private readonly timers = new Set<NodeJS.Timeout>();
  private runningSteam = false;
  private runningLocalScan = false;
  private runningPrefetch = false;

  constructor(private readonly options: BackgroundServiceOptions) {}

  getState(): Record<string, unknown> {
    return {
      mode: this.mode,
      stopped: this.stopped,
      timerCount: this.timers.size,
      runningSteam: this.runningSteam,
      runningLocalScan: this.runningLocalScan,
      runningPrefetch: this.runningPrefetch
    };
  }

  start(mode: BackgroundMode): void {
    this.mode = mode;
    this.stopped = false;
    this.clearTimers();
    void this.options.localPlaytimeMonitor.start();
    if (mode === "tray") {
      void this.scheduleTrayWork();
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.options.localPlaytimeMonitor.stop();
  }

  async refreshSettings(): Promise<void> {
    await this.options.localPlaytimeMonitor.refreshSettings();
    if (this.stopped) return;
    if (this.mode === "tray") {
      this.clearTimers();
      await this.scheduleTrayWork();
    }
  }

  async onResume(): Promise<void> {
    if (this.stopped || this.mode !== "tray") return;
    this.setTimer(() => {
      void this.runPrefetchSync("timer");
    }, RESUME_PREFETCH_DEBOUNCE_MS);
  }

  async runSteamSyncNow(trigger: BackgroundTrigger): Promise<void> {
    if (this.runningSteam) return;
    const settings = await this.options.getSettings();
    if (!this.canRunBackgroundUpdates(settings) || !settings.steamWebApiKey || settings.steamAccounts.length === 0) {
      this.options.profile?.("background:steam:skipped", "Background Steam sync skipped", {
        trigger,
        updatesEnabled: settings.backgroundUpdatesEnabled !== false,
        hasSteamWebApiKey: Boolean(settings.steamWebApiKey),
        steamAccounts: settings.steamAccounts.length
      });
      return;
    }

    this.runningSteam = true;
    try {
      this.options.profile?.("background:steam:start", "Background Steam sync started", { trigger });
      await this.options.startSteamSync("steam", { refreshStaleMetadata: false });
      await this.scheduleRichBackfill(settings);
    } finally {
      this.runningSteam = false;
    }
  }

  private async scheduleTrayWork(): Promise<void> {
    const settings = await this.options.getSettings();
    if (!this.canRunBackgroundUpdates(settings)) {
      await this.options.cancelActiveSteamSync?.("Background updates disabled");
      return;
    }
    const cadence = cadenceFor(settings);

    this.setTimer(() => {
      void this.runSteamLoop(cadence.steamIntervalMs);
    }, TRAY_STARTUP_DELAY_MS);
    this.setTimer(() => {
      void this.runPrefetchLoop(cadence.prefetchIntervalMs);
    }, PREFETCH_STARTUP_DELAY_MS);
    if (cadence.localScanIntervalMs) {
      this.setTimer(() => {
        void this.runLocalScanLoop(cadence.localScanIntervalMs!);
      }, LOCAL_SCAN_STARTUP_DELAY_MS);
    }
  }

  private async runSteamLoop(intervalMs: number): Promise<void> {
    if (this.stopped || this.mode !== "tray") return;
    try {
      await this.runSteamSyncNow("timer");
    } catch (error) {
      console.warn("Background Steam sync failed", error);
    } finally {
      this.setTimer(() => {
        void this.runSteamLoop(intervalMs);
      }, Math.max(MINUTE_MS, jitter(intervalMs)));
    }
  }

  private async runPrefetchLoop(intervalMs: number): Promise<void> {
    if (this.stopped || this.mode !== "tray") return;
    try {
      await this.runPrefetchSync("timer");
    } finally {
      this.setTimer(() => {
        void this.runPrefetchLoop(intervalMs);
      }, intervalMs);
    }
  }

  private async runPrefetchSync(trigger: BackgroundTrigger): Promise<void> {
    if (this.runningPrefetch) return;
    this.runningPrefetch = true;
    try {
      this.options.profile?.("background:prefetch:start", "Background Prefetch sync started", { trigger });
      await this.options.syncLocalLastPlayedFromPrefetch();
    } catch (error) {
      console.warn("Background Prefetch sync failed", error);
    } finally {
      this.runningPrefetch = false;
    }
  }

  private async runLocalScanLoop(intervalMs: number): Promise<void> {
    if (this.stopped || this.mode !== "tray") return;
    try {
      await this.runLocalScanIfAllowed("timer");
    } finally {
      this.setTimer(() => {
        void this.runLocalScanLoop(intervalMs);
      }, intervalMs);
    }
  }

  private async runLocalScanIfAllowed(trigger: BackgroundTrigger): Promise<void> {
    if (this.runningLocalScan || this.options.isOnBatteryPower?.() === true) return;
    const settings = await this.options.getSettings();
    const roots = (settings.localRoots ?? []).filter((root) => root.path && root.path.trim().length > 0);
    if (!this.canRunBackgroundUpdates(settings) || roots.length === 0) return;
    if ((this.options.getSystemIdleTime?.() ?? 0) < 5 * 60) return;

    this.runningLocalScan = true;
    try {
      this.options.profile?.("background:local-scan:start", "Background local scan started", { trigger, rootCount: roots.length });
      await this.options.runLocalScan();
      await this.options.localPlaytimeMonitor.refreshExecutables();
    } catch (error) {
      console.warn("Background local scan failed", error);
    } finally {
      this.runningLocalScan = false;
    }
  }

  private async scheduleRichBackfill(settings: AppSettings): Promise<void> {
    const cadence = cadenceFor(settings);
    if (cadence.richBackfillLimit <= 0 || this.options.isOnBatteryPower?.() === true) return;
    this.setTimer(() => {
      void this.options.getSettings().then((current) => {
        if (!this.canRunBackgroundUpdates(current) || this.options.isOnBatteryPower?.() === true) return;
        this.options.enqueueRichMetadataBackfill(cadence.richBackfillLimit);
      });
    }, RICH_BACKFILL_DELAY_MS);
  }

  private canRunBackgroundUpdates(settings: AppSettings): boolean {
    return settings.backgroundUpdatesEnabled !== false;
  }

  private setTimer(task: () => void, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      task();
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
