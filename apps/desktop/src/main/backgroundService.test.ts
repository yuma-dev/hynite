import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@hynite/core";
import { BackgroundService } from "./backgroundService";
import type { LocalPlaytimeMonitor } from "./localPlaytimeMonitor";

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    steamAccounts: [],
    cacheTtlHours: 24,
    reduceMotion: false,
    autoHideAfterLaunch: true,
    startWithWindows: true,
    closeToTray: true,
    backgroundUpdatesEnabled: true,
    backgroundWorkload: "balanced",
    backgroundPlaytimeTracking: true,
    cardsPerRow: 6,
    launchAccountPreferences: {},
    gameGroups: [],
    localRoots: [],
    localExcludePatterns: [],
    sound: { masterVolume: 1 },
    music: {},
    controller: { enabled: true, backgroundInput: true, bindings: {} },
    ...patch
  };
}

function monitor(): LocalPlaytimeMonitor {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    refreshSettings: vi.fn(async () => undefined),
    refreshExecutables: vi.fn(async () => undefined),
    ignorePid: vi.fn(),
    pollNow: vi.fn(async () => undefined)
  } as unknown as LocalPlaytimeMonitor;
}

describe("BackgroundService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("foreground mode keeps passive monitoring and maintenance timers active", async () => {
    const localPlaytimeMonitor = monitor();
    const startSteamSync = vi.fn();
    const service = new BackgroundService({
      getSettings: async () => settings({ steamAccounts: [{ steamId: "a", pairedAt: "2026-01-01T00:00:00.000Z" }], steamWebApiKey: { cipherText: "x", scope: "current-user" } }),
      startSteamSync,
      runLocalScan: vi.fn(),
      syncLocalLastPlayedFromPrefetch: vi.fn(async () => 0),
      enqueueRichMetadataBackfill: vi.fn(),
      localPlaytimeMonitor
    });

    service.start("foreground");
    await Promise.resolve();

    expect(localPlaytimeMonitor.start).toHaveBeenCalled();
    expect(localPlaytimeMonitor.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(startSteamSync).not.toHaveBeenCalled();
  });

  it("tray mode starts playtime monitor and schedules tray jobs", async () => {
    const localPlaytimeMonitor = monitor();
    const service = new BackgroundService({
      getSettings: async () => settings(),
      startSteamSync: vi.fn(),
      runLocalScan: vi.fn(),
      syncLocalLastPlayedFromPrefetch: vi.fn(async () => 0),
      enqueueRichMetadataBackfill: vi.fn(),
      localPlaytimeMonitor
    });

    service.start("tray");
    await Promise.resolve();

    expect(localPlaytimeMonitor.start).toHaveBeenCalled();
    expect(localPlaytimeMonitor.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("skips tray Steam sync without credentials or accounts", async () => {
    const startSteamSync = vi.fn();
    const service = new BackgroundService({
      getSettings: async () => settings(),
      startSteamSync,
      runLocalScan: vi.fn(),
      syncLocalLastPlayedFromPrefetch: vi.fn(async () => 0),
      enqueueRichMetadataBackfill: vi.fn(),
      localPlaytimeMonitor: monitor()
    });

    await service.runSteamSyncNow("tray");

    expect(startSteamSync).not.toHaveBeenCalled();
  });

  it("clears tray timers when background updates are disabled", async () => {
    let current = settings({
      steamAccounts: [{ steamId: "a", pairedAt: "2026-01-01T00:00:00.000Z" }],
      steamWebApiKey: { cipherText: "x", scope: "current-user" }
    });
    const cancelActiveSteamSync = vi.fn(async () => undefined);
    const service = new BackgroundService({
      getSettings: async () => current,
      startSteamSync: vi.fn(),
      runLocalScan: vi.fn(),
      syncLocalLastPlayedFromPrefetch: vi.fn(async () => 0),
      enqueueRichMetadataBackfill: vi.fn(),
      localPlaytimeMonitor: monitor(),
      cancelActiveSteamSync
    });

    service.start("tray");
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    current = settings({ backgroundUpdatesEnabled: false });
    await service.refreshSettings();

    expect(cancelActiveSteamSync).toHaveBeenCalledWith("Background updates disabled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips heavy local scan and rich backfill on battery", async () => {
    const runLocalScan = vi.fn();
    const enqueueRichMetadataBackfill = vi.fn();
    const service = new BackgroundService({
      getSettings: async () => settings({
        steamAccounts: [{ steamId: "a", pairedAt: "2026-01-01T00:00:00.000Z" }],
        steamWebApiKey: { cipherText: "x", scope: "current-user" },
        localRoots: [{ path: "C:\\Games", depth: 1 }]
      }),
      startSteamSync: vi.fn(async () => ({ providerId: "steam" as const, scanned: 0, upserted: 0, warnings: [] })),
      runLocalScan,
      syncLocalLastPlayedFromPrefetch: vi.fn(async () => 0),
      enqueueRichMetadataBackfill,
      localPlaytimeMonitor: monitor(),
      isOnBatteryPower: () => true,
      getSystemIdleTime: () => 10 * 60
    });

    service.start("tray");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(runLocalScan).not.toHaveBeenCalled();
    expect(enqueueRichMetadataBackfill).not.toHaveBeenCalled();
  });

  it("runs passive local scans with unchanged-cache skipping enabled", async () => {
    const runLocalScan = vi.fn(async () => undefined);
    const service = new BackgroundService({
      getSettings: async () => settings({
        localRoots: [{ path: "C:\\Games", depth: 1 }]
      }),
      startSteamSync: vi.fn(),
      runLocalScan,
      syncLocalLastPlayedFromPrefetch: vi.fn(async () => 0),
      enqueueRichMetadataBackfill: vi.fn(),
      localPlaytimeMonitor: monitor(),
      getSystemIdleTime: () => 10 * 60
    });

    service.start("foreground");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(runLocalScan).toHaveBeenCalledWith({ skipUnchanged: true, refreshMetadata: true });
  });

  it("defers capped rich backfill after passive Steam sync", async () => {
    const startSteamSync = vi.fn(async () => ({ providerId: "steam" as const, scanned: 0, upserted: 0, warnings: [] }));
    const enqueueRichMetadataBackfill = vi.fn();
    const service = new BackgroundService({
      getSettings: async () => settings({
        steamAccounts: [{ steamId: "a", pairedAt: "2026-01-01T00:00:00.000Z" }],
        steamWebApiKey: { cipherText: "x", scope: "current-user" }
      }),
      startSteamSync,
      runLocalScan: vi.fn(),
      syncLocalLastPlayedFromPrefetch: vi.fn(async () => 0),
      enqueueRichMetadataBackfill,
      localPlaytimeMonitor: monitor(),
      isOnBatteryPower: () => false
    });

    service.start("foreground");
    await Promise.resolve();
    await service.runSteamSyncNow("timer");

    expect(startSteamSync).toHaveBeenCalledWith("steam", {
      refreshStaleMetadata: false,
      replaceActive: false,
      richBackfillLimit: false
    });
    expect(enqueueRichMetadataBackfill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(enqueueRichMetadataBackfill).toHaveBeenCalledWith(25);
  });
});
