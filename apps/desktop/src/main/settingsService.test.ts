import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsService } from "./settingsService";
import { readAudioArtwork } from "./audioMetadata";

let tempDir: string | undefined;

function createService(): SettingsService {
  tempDir = mkdtempSync(join(tmpdir(), "hynite-settings-"));
  return new SettingsService(join(tempDir, "settings.json"));
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
  it("migrates existing settings without launch account preferences", async () => {
    const service = createService();
    writeFileSync(join(tempDir!, "settings.json"), JSON.stringify({ cacheTtlHours: 12, reduceMotion: true }));

    await expect(service.get()).resolves.toMatchObject({
      cacheTtlHours: 12,
      reduceMotion: true,
      autoHideAfterLaunch: true,
      launchAccountPreferences: {},
      gameGroups: []
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

    await expect(service.get()).resolves.toMatchObject({ cardsPerRow: 8 });
    await expect(service.update({ cardsPerRow: 10.6 })).resolves.toMatchObject({ cardsPerRow: 11 });
    await expect(service.update({ cardsPerRow: 99 })).resolves.toMatchObject({ cardsPerRow: 12 });
    await expect(service.update({ cardsPerRow: 1 })).resolves.toMatchObject({ cardsPerRow: 4 });
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
          gameLaunch: { filePath: "C:\\Sounds\\launch.ogg", volume: 2, enabled: true, playback: "fade" }
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
          gameLaunch: { filePath: "C:\\Sounds\\launch.ogg", volume: 1, enabled: true, playback: "fade" }
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
