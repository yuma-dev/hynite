import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@hynite/core";
import { LocalPlaytimeMonitor } from "./localPlaytimeMonitor";

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

describe("LocalPlaytimeMonitor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts and ends externally launched local sessions", async () => {
    let now = Date.parse("2026-05-13T10:00:00.000Z");
    let running = [{ path: "C:\\Games\\Example\\game.exe", pid: 42, startedAt: new Date(now).toISOString() }];
    const writes: Array<{ id: string; minutes: number; at?: string }> = [];
    const updated: string[] = [];
    const monitor = new LocalPlaytimeMonitor({
      repository: {
        getLocalGameExecutables: () => [{ id: "local:example", executablePath: "C:\\Games\\Example\\game.exe", lastPlayedAt: null }],
        addPlaytime: (id, minutes, at) => writes.push({ id, minutes, at })
      },
      nativeBridge: {
        getRunningProcesses: async () => running
      },
      getSettings: async () => settings(),
      emitGameUpdated: (id) => updated.push(id),
      now: () => now
    });

    await monitor.start();
    await monitor.pollNow();

    expect(writes).toEqual([{ id: "local:example", minutes: 0, at: "2026-05-13T10:00:00.000Z" }]);
    expect(updated).toEqual(["local:example"]);

    running = [];
    now += 30_000;
    await monitor.pollNow();
    expect(writes).toHaveLength(1);

    now += 30_000;
    await monitor.pollNow();
    expect(writes.at(-1)).toMatchObject({ id: "local:example", minutes: 1, at: "2026-05-13T10:01:00.000Z" });
  });

  it("ignores Hynite-launched pids", async () => {
    const writes: unknown[] = [];
    const monitor = new LocalPlaytimeMonitor({
      repository: {
        getLocalGameExecutables: () => [{ id: "local:example", executablePath: "C:\\Games\\Example\\game.exe", lastPlayedAt: null }],
        addPlaytime: (...args) => writes.push(args)
      },
      nativeBridge: {
        getRunningProcesses: async () => [{ path: "C:\\Games\\Example\\game.exe", pid: 42, startedAt: "2026-05-13T10:00:00.000Z" }]
      },
      getSettings: async () => settings(),
      now: () => Date.parse("2026-05-13T10:00:00.000Z")
    });

    await monitor.start();
    monitor.ignorePid(42);
    await monitor.pollNow();

    expect(writes).toHaveLength(0);
  });

  it("does not poll native processes when disabled or when no exe paths exist", async () => {
    const getRunningProcesses = vi.fn(async () => []);
    const disabled = new LocalPlaytimeMonitor({
      repository: {
        getLocalGameExecutables: () => [{ id: "local:example", executablePath: "C:\\Games\\Example\\game.exe", lastPlayedAt: null }],
        addPlaytime: vi.fn()
      },
      nativeBridge: { getRunningProcesses },
      getSettings: async () => settings({ backgroundPlaytimeTracking: false })
    });

    await disabled.start();
    await disabled.pollNow();
    expect(getRunningProcesses).not.toHaveBeenCalled();

    const empty = new LocalPlaytimeMonitor({
      repository: {
        getLocalGameExecutables: () => [{ id: "local:link", executablePath: "C:\\Games\\Example\\start.url", lastPlayedAt: null }],
        addPlaytime: vi.fn()
      },
      nativeBridge: { getRunningProcesses },
      getSettings: async () => settings()
    });

    await empty.start();
    await empty.pollNow();
    expect(getRunningProcesses).not.toHaveBeenCalled();
  });
});
