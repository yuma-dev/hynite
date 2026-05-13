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

  it("foreground mode starts playtime monitor without scheduling tray jobs", async () => {
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
    expect(vi.getTimerCount()).toBe(0);
    expect(startSteamSync).not.toHaveBeenCalled();
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
});
