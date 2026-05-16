import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "./settingsService";
import { readAudioArtwork } from "./audioMetadata";

let tempDir: string | undefined;

function createService(): SettingsService {
  tempDir = mkdtempSync(join(tmpdir(), "hynite-settings-"));
  return new SettingsService(join(tempDir, "settings.json"));
}

function createServiceWithDeps(deps: ConstructorParameters<typeof SettingsService>[2]): SettingsService {
  tempDir = mkdtempSync(join(tmpdir(), "hynite-settings-"));
  return new SettingsService(join(tempDir, "settings.json"), undefined, deps);
}

function synchsafe(size: number): Buffer {
  return Buffer.from([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f
  ]);
}

function textFrame(id: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([Buffer.from(id, "latin1"), size, Buffer.alloc(2), payload]);
}

function apicFrame(mimeType: string, imageBytes: Buffer): Buffer {
  const payload = Buffer.concat([
    Buffer.from([3]),
    Buffer.from(mimeType, "latin1"),
    Buffer.from([0, 3, 0]),
    imageBytes
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([Buffer.from("APIC", "latin1"), size, Buffer.alloc(2), payload]);
}

function taggedMp3(tags: Record<string, string>, extraFrames: Buffer[] = []): Buffer {
  const frames = Buffer.concat([
    ...Object.entries(tags).map(([id, value]) => textFrame(id, value)),
    ...extraFrames
  ]);
  return Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), synchsafe(frames.length), frames, Buffer.from([0xff, 0xfb])]);
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("SettingsService", () => {
  it("detects no persisted settings", () => {
    const service = createService();
    expect(service.hasPersistedSettings()).toBe(false);
  });

  it("detects primary or backup settings files", () => {
    const service = createService();
    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({ cacheTtlHours: 12 }));
    expect(service.hasPersistedSettings()).toBe(true);

    rmSync(join(tempDir!, "settings.json"), { force: true });
    writeFileSync(join(tempDir!, "settings.json.bak"), JSON.stringify({ cacheTtlHours: 18 }));
    expect(service.hasPersistedSettings()).toBe(true);
  });

  it("migrates existing settings without launch account preferences", async () => {
    const service = createService();
    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({ cacheTtlHours: 12, reduceMotion: true }));

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 12,
      reduceMotion: true,
      autoHideAfterLaunch: true,
      startWithWindows: true,
      closeToTray: true,
      backgroundUpdatesEnabled: true,
      backgroundWorkload: "balanced",
      backgroundPlaytimeTracking: true,
      launchAccountPreferences: {},
      gameGroups: []
    });
  });

  it("persists and sanitizes background lifecycle settings", async () => {
    const service = createService();

    await expect(service.update({
      cacheTtlHours: 6,
      startWithWindows: false,
      closeToTray: false,
      backgroundUpdatesEnabled: false,
      backgroundWorkload: "minimum",
      backgroundPlaytimeTracking: false
    })).resolves.toMatchObject({
      cacheTtlHours: 6,
      startWithWindows: false,
      closeToTray: false,
      backgroundUpdatesEnabled: false,
      backgroundWorkload: "minimum",
      backgroundPlaytimeTracking: false
    });

    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({
      cacheTtlHours: 9,
      backgroundWorkload: "aggressive",
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    }));

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 9,
      startWithWindows: true,
      closeToTray: true,
      backgroundUpdatesEnabled: true,
      backgroundWorkload: "balanced",
      backgroundPlaytimeTracking: true,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    });
  });

  it("persists and sanitizes Spotlight settings", async () => {
    const service = createService();

    await expect(service.get()).resolves.toMatchObject({
      spotlight: {
        enabled: true,
        hotkey: "Alt+Space"
      }
    });

    await expect(service.update({
      cacheTtlHours: 6,
      spotlight: { enabled: false, hotkey: "Ctrl+Alt+Space" }
    })).resolves.toMatchObject({
      cacheTtlHours: 6,
      spotlight: { enabled: false, hotkey: "Ctrl+Alt+Space" }
    });

    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({
      cacheTtlHours: 9,
      spotlight: { enabled: true, hotkey: "   " }
    }));

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 9,
      spotlight: { enabled: true, hotkey: "Alt+Space" }
    });
  });

  it("persists launch auto-hide without dropping other settings", async () => {
    const service = createService();
    await service.update({
      cacheTtlHours: 6,
      reduceMotion: true,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    });

    await expect(service.update({ autoHideAfterLaunch: false })).resolves.toMatchObject({
      cacheTtlHours: 6,
      reduceMotion: true,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }],
      autoHideAfterLaunch: false
    });

    await expect(service.update({ autoHideAfterLaunch: true })).resolves.toMatchObject({
      cacheTtlHours: 6,
      reduceMotion: true,
      autoHideAfterLaunch: true
    });
  });

  it("serializes concurrent settings updates without dropping unrelated fields", async () => {
    const service = createService();
    await service.update({
      cacheTtlHours: 6,
      reduceMotion: true,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    });

    await Promise.all([
      service.update({ autoHideAfterLaunch: false }),
      service.update({ cardsPerRow: 8 })
    ]);

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 6,
      reduceMotion: true,
      autoHideAfterLaunch: false,
      cardsPerRow: 8,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    });
  });

  it("retries rename failures while writing settings", async () => {
    const rename = vi.fn(async () => {
      if (rename.mock.calls.length < 3) {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
    });
    const service = createServiceWithDeps({ rename, sleep: async () => undefined });

    await expect(service.update({ cacheTtlHours: 12, reduceMotion: true })).resolves.toMatchObject({
      cacheTtlHours: 12,
      reduceMotion: true
    });
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("sanitizes onboarding marker", async () => {
    const service = createService();
    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({
      onboarding: {
        version: 1,
        completedAt: "2026-05-13T10:20:30.000Z",
        skippedAt: "not-a-date"
      }
    }));

    await expect(service.get()).resolves.toMatchObject({
      onboarding: {
        version: 1,
        completedAt: "2026-05-13T10:20:30.000Z"
      }
    });

    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({
      onboarding: {
        version: 2,
        completedAt: "2026-05-13T10:20:30.000Z"
      }
    }));

    const loaded = await service.get();
    expect(loaded.onboarding).toBeUndefined();
  });

  it("updates onboarding marker without dropping unrelated settings", async () => {
    const service = createService();
    await service.update({
      cacheTtlHours: 6,
      reduceMotion: true,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    });

    await expect(service.update({
      onboarding: { version: 1, skippedAt: "2026-05-13T10:00:00.000Z" }
    })).resolves.toMatchObject({
      cacheTtlHours: 6,
      reduceMotion: true,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }],
      onboarding: { version: 1, skippedAt: "2026-05-13T10:00:00.000Z" }
    });
  });

  it("writes a backup and recovers settings when the primary file is corrupt", async () => {
    const service = createService();
    await service.update({ cacheTtlHours: 6, reduceMotion: true });
    expect(existsSync(join(tempDir!, "settings.json.bak"))).toBe(true);

    writeFileSync(join(tempDir!, "settings.json"), "{");

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 6,
      reduceMotion: true
    });
  });

  it("persists and clamps cards per row", async () => {
    const service = createService();

    await expect(service.get()).resolves.toMatchObject({ cardsPerRow: 6 });
    await expect(service.update({ cardsPerRow: 10.6 })).resolves.toMatchObject({ cardsPerRow: 11 });
    await expect(service.update({ cardsPerRow: 99 })).resolves.toMatchObject({ cardsPerRow: 12 });
    await expect(service.update({ cardsPerRow: 1 })).resolves.toMatchObject({ cardsPerRow: 4 });
  });

  it("creates, lists, restores, and health-checks periodic settings backups", async () => {
    const service = createService();
    await service.update({
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }],
      bigPictureGrayscaleCovers: false
    });

    const created = await service.createPeriodicBackupIfDue();
    expect(created?.restoreCommand).toContain("window.__hyniteSettings.restore");
    expect(service.listBackups()).toHaveLength(1);

    await service.update({ steamAccounts: [], bigPictureGrayscaleCovers: true, onboarding: undefined });
    await expect(service.detectHealthWarning()).resolves.toMatchObject({
      kind: "clean-slate-reset",
      backups: [{ id: created?.id }]
    });

    await expect(service.restoreBackup(created!.id)).resolves.toMatchObject({
      steamAccounts: [{ steamId: "owner-a" }],
      bigPictureGrayscaleCovers: false
    });
  });

  it("persists and sanitizes controller bindings", async () => {
    const service = createService();

    await expect(service.get()).resolves.toMatchObject({
      controller: {
        enabled: true,
        backgroundInput: true,
        bindings: {
          focusBigPicture: { buttons: [8, 9] },
          exitBigPicture: { buttons: [8, 9] },
          play: { buttons: [0] }
        }
      }
    });

    await expect(service.update({
      controller: {
        enabled: false,
        backgroundInput: false,
        bindings: {
          focusBigPicture: { buttons: [19, 20, 19, -1, 300] },
          exitBigPicture: { buttons: [8, 9] },
          play: { buttons: [31] },
          details: { buttons: [] }
        }
      }
    })).resolves.toMatchObject({
      controller: {
        enabled: false,
        backgroundInput: false,
        bindings: {
          focusBigPicture: { buttons: [19, 20] },
          exitBigPicture: { buttons: [8, 9] },
          play: { buttons: [31] },
          details: { buttons: [2] }
        }
      }
    });
  });

  it("persists and sanitizes window placement", async () => {
    const service = createService();
    await service.update({
      cacheTtlHours: 6,
      windowState: {
        bounds: { x: 120.4, y: 80.6, width: 1280.2, height: 720.7 },
        displayId: 42.8,
        isMaximized: true
      }
    });

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 6,
      windowState: {
        bounds: { x: 120, y: 81, width: 1280, height: 721 },
        displayId: 43,
        isMaximized: true
      }
    });
    await expect(service.getWindowState()).resolves.toMatchObject({
      bounds: { x: 120, y: 81, width: 1280, height: 721 },
      displayId: 43,
      isMaximized: true
    });
  });

  it("drops invalid window placement while preserving maximized state", async () => {
    const service = createService();
    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({
      windowState: {
        bounds: { x: 0, y: 0, width: -1, height: 720 },
        displayId: "primary",
        isMaximized: true
      }
    }));

    await expect(service.get()).resolves.toMatchObject({
      windowState: { isMaximized: true }
    });
  });

  it("persists and sanitizes sound settings", async () => {
    const service = createService();
    await service.update({
      sound: {
        masterVolume: 1.8,
        muted: true,
        effects: {
          startup: { filePath: " C:\\Sounds\\boot.wav ", volume: -1, enabled: true, playback: "restart" },
          gameSelect: { filePath: "C:\\Sounds\\select.mp3", volume: 0.35, enabled: false, playback: "overlap" },
          gameLaunch: { filePath: "C:\\Sounds\\launch.ogg", volume: 2, enabled: true, playback: "fade" },
          bigPictureOpen: { filePath: "C:\\Sounds\\bp.mp3", volume: 0.8, enabled: true, playback: "fade" }
        }
      }
    });

    await expect(service.get()).resolves.toMatchObject({
      sound: {
        masterVolume: 1,
        muted: true,
        effects: {
          startup: { filePath: "C:\\Sounds\\boot.wav", volume: 0, enabled: true, playback: "restart" },
          gameSelect: { filePath: "C:\\Sounds\\select.mp3", volume: 0.35, enabled: false, playback: "overlap" },
          gameLaunch: { filePath: "C:\\Sounds\\launch.ogg", volume: 1, enabled: true, playback: "fade" },
          bigPictureOpen: { filePath: "C:\\Sounds\\bp.mp3", volume: 0.8, enabled: true, playback: "fade" }
        }
      }
    });
  });

  it("applies bundled audio defaults and reads track copyright", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "hynite-settings-"));
    const audioRoot = join(tempDir, "audio");
    mkdirSync(join(audioRoot, "soundeffects"), { recursive: true });
    mkdirSync(join(audioRoot, "music"), { recursive: true });
    writeFileSync(join(audioRoot, "soundeffects", "startup.mp3"), "startup");
    writeFileSync(join(audioRoot, "soundeffects", "selection.mp3"), "selection");
    writeFileSync(join(audioRoot, "soundeffects", "gamestart.mp3"), "gamestart");
    writeFileSync(join(audioRoot, "soundeffects", "bplaunch.mp3"), "bplaunch");
    writeFileSync(join(audioRoot, "music", "01. Theme.mp3"), taggedMp3({
      TIT2: "Theme",
      TPE1: "Artist",
      TALB: "Album",
      TCOP: "Copyright Holder 2026"
    }));

    const service = new SettingsService(join(tempDir, "settings.json"), audioRoot);
    await expect(service.get()).resolves.toMatchObject({
      sound: {
        masterVolume: 0.1,
        effects: {
          startup: { source: "bundled", filePath: join(audioRoot, "soundeffects", "startup.mp3") },
          gameSelect: { source: "bundled", filePath: join(audioRoot, "soundeffects", "selection.mp3") },
          gameLaunch: { source: "bundled", filePath: join(audioRoot, "soundeffects", "gamestart.mp3") },
          bigPictureOpen: { source: "bundled", filePath: join(audioRoot, "soundeffects", "bplaunch.mp3") },
          navigation: { source: "bundled", filePath: join(audioRoot, "soundeffects", "selection.mp3") }
        }
      },
      music: {
        volume: 0.04,
        tracks: [{
          source: "bundled",
          filePath: join(audioRoot, "music", "01. Theme.mp3"),
          title: "Theme",
          artist: "Artist",
          album: "Album",
          copyright: "Copyright Holder 2026"
        }]
      }
    });

  });

  it("reads embedded MP3 artwork for music cover tooltips", () => {
    tempDir = mkdtempSync(join(tmpdir(), "hynite-settings-"));
    const coverBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const filePath = join(tempDir, "cover.mp3");
    writeFileSync(filePath, taggedMp3({ TIT2: "Theme" }, [apicFrame("image/png", coverBytes)]));

    const artwork = readAudioArtwork(filePath);
    expect(artwork?.mimeType).toBe("image/png");
    expect(artwork?.bytes.equals(coverBytes)).toBe(true);
  });

  it("persists and sanitizes music settings", async () => {
    const service = createService();
    await service.update({
      music: {
        enabled: true,
        volume: 2,
        tracks: [{ filePath: " C:\\Music\\one.mp3 " }, { filePath: "" }],
        startupDelayEnabled: false,
        startupDelayMs: -1,
        startupWithSoundEnabled: true,
        startupWithSoundFadeInMs: 90_000,
        fadesEnabled: true,
        trackFadeInMs: 45_000,
        pauseFadeOutMs: 750,
        resumeFadeInMs: 1_250,
        gameLaunchFadeOutMs: 12_000,
        pauseOnGameLaunch: false,
        pauseOnFocusLoss: false,
        pauseOnSystemAudio: false,
        continuousPlay: true,
        gapMinMs: 90_000,
        gapMaxMs: 10_000
      }
    });

    await expect(service.get()).resolves.toMatchObject({
      music: {
        enabled: true,
        volume: 1,
        tracks: [{ filePath: "C:\\Music\\one.mp3" }],
        startupDelayEnabled: false,
        startupDelayMs: 0,
        startupWithSoundEnabled: true,
        startupWithSoundFadeInMs: 60_000,
        fadesEnabled: true,
        trackFadeInMs: 30_000,
        pauseFadeOutMs: 750,
        resumeFadeInMs: 1_250,
        gameLaunchFadeOutMs: 10_000,
        pauseOnGameLaunch: false,
        pauseOnFocusLoss: false,
        pauseOnSystemAudio: false,
        continuousPlay: true,
        gapMinMs: 10_000,
        gapMaxMs: 90_000
      }
    });
  });

  it("writes and clears per-game launch account preferences without dropping settings", async () => {
    const service = createService();
    await service.update({
      cacheTtlHours: 6,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }]
    });

    await expect(service.setLaunchAccountPreference("steam:10", "owner-a")).resolves.toMatchObject({
      cacheTtlHours: 6,
      steamAccounts: [{ steamId: "owner-a", pairedAt: "2026-01-01T00:00:00.000Z" }],
      launchAccountPreferences: { "steam:10": "owner-a" }
    });

    await expect(service.setLaunchAccountPreference("steam:10", undefined)).resolves.toMatchObject({
      cacheTtlHours: 6,
      launchAccountPreferences: {}
    });
  });

  it("writes and sanitizes game groups without dropping other settings", async () => {
    const service = createService();
    await service.update({ cacheTtlHours: 6, reduceMotion: true });
    const createdAt = "2026-05-10T00:00:00.000Z";
    const updatedAt = "2026-05-10T01:00:00.000Z";

    await expect(service.setGameGroups([
      {
        id: "manual-1",
        kind: "manual",
        name: "Favorites",
        gameIds: ["steam:10"],
        createdAt,
        updatedAt
      },
      {
        id: "smart-1",
        kind: "smart",
        name: "Installed RPGs",
        search: "rpg",
        view: {
          filters: { installState: "installed", ownership: "all", sources: [], genres: ["RPG"], tags: [], playerModes: [], dateFilter: "any" },
          sort: { field: "title", direction: "asc" }
        },
        createdAt,
        updatedAt
      }
    ])).resolves.toMatchObject({
      cacheTtlHours: 6,
      reduceMotion: true,
      gameGroups: [
        { id: "manual-1", kind: "manual", name: "Favorites", gameIds: ["steam:10"] },
        { id: "smart-1", kind: "smart", name: "Installed RPGs", search: "rpg" }
      ]
    });

    await expect(service.setGameGroups([])).resolves.toMatchObject({
      cacheTtlHours: 6,
      gameGroups: []
    });
  });
});
