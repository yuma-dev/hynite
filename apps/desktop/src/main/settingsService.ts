import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { defaultLibraryView, soundEffectIds, type AppSettings, type EncryptedSecret, type GameGroup, type LibraryView, type MusicSettings, type MusicTrack, type SoundEffectId, type SoundEffectPlayback, type SoundSettings, type SteamAccountSettings, type WindowBounds, type WindowState } from "@hynite/core";

export const DEFAULT_LOCAL_EXCLUDE_PATTERNS = [
  "^_redist$",
  "^redist$",
  "^_Commonredist$",
  "^Tools$",
  "^Saves$",
  "^Backups?$",
  "^Emulators$",
  "^DLC$",
  "^_CommonRedist$"
];

const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  masterVolume: 0.1,
  muted: false,
  effects: {}
};

const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  enabled: true,
  volume: 0.04,
  tracks: [],
  startupDelayEnabled: true,
  startupDelayMs: 5_000,
  fadesEnabled: true,
  trackFadeInMs: 5_000,
  pauseFadeOutMs: 2_000,
  resumeFadeInMs: 1_500,
  gameLaunchFadeOutMs: 600,
  pauseOnGameLaunch: true,
  pauseOnFocusLoss: true,
  pauseOnSystemAudio: true,
  continuousPlay: false,
  gapMinMs: 30_000,
  gapMaxMs: 120_000
};

const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"]);
const BUNDLED_SOUND_FILES: Record<SoundEffectId, string> = {
  startup: "startup.mp3",
  gameSelect: "selection.mp3",
  gameLaunch: "gamestart.mp3",
  navigation: "selection.mp3"
};

type AudioMetadata = Pick<MusicTrack, "title" | "artist" | "album" | "copyright">;

type BundledAudioDefaults = {
  soundEffects: Partial<Record<SoundEffectId, NonNullable<SoundSettings["effects"]>[SoundEffectId]>>;
  musicTracks: MusicTrack[];
};

const defaultSettings: AppSettings = {
  steamAccounts: [],
  steamWebApiKey: undefined,
  steamGridDbApiKey: undefined,
  cacheTtlHours: 24,
  reduceMotion: false,
  autoHideAfterLaunch: true,
  libraryView: defaultLibraryView,
  launchAccountPreferences: {},
  gameGroups: [],
  localRoots: [],
  localExcludePatterns: DEFAULT_LOCAL_EXCLUDE_PATTERNS,
  sound: DEFAULT_SOUND_SETTINGS,
  music: DEFAULT_MUSIC_SETTINGS,
  windowState: undefined
};

function synchsafeToInt(bytes: Buffer, offset: number): number {
  return ((bytes[offset] ?? 0) & 0x7f) << 21
    | ((bytes[offset + 1] ?? 0) & 0x7f) << 14
    | ((bytes[offset + 2] ?? 0) & 0x7f) << 7
    | ((bytes[offset + 3] ?? 0) & 0x7f);
}

function decodeId3TextFrame(bytes: Buffer): string | undefined {
  if (bytes.length < 2) return undefined;
  const encoding = bytes[0];
  const data = bytes.subarray(1);
  let text: string;
  if (encoding === 1 || encoding === 2) {
    text = data.toString("utf16le");
  } else if (encoding === 3) {
    text = data.toString("utf8");
  } else {
    text = data.toString("latin1");
  }
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
  return cleaned || undefined;
}

function readMp3Metadata(filePath: string): AudioMetadata {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const header = Buffer.alloc(10);
    if (readSync(fd, header, 0, header.length, 0) !== header.length) return {};
    if (header.subarray(0, 3).toString("latin1") !== "ID3") return {};
    const version = header[3];
    const tagSize = synchsafeToInt(header, 6);
    const bytes = Buffer.alloc(10 + tagSize);
    header.copy(bytes, 0);
    readSync(fd, bytes, 10, tagSize, 10);
    const end = bytes.length;
    const metadata: AudioMetadata = {};
    let offset = 10;

    while (offset + 10 <= end) {
      const frameId = bytes.subarray(offset, offset + 4).toString("latin1");
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
      const frameSize = version === 4 ? synchsafeToInt(bytes, offset + 4) : bytes.readUInt32BE(offset + 4);
      offset += 10;
      if (frameSize <= 0 || offset + frameSize > end) break;
      const value = decodeId3TextFrame(bytes.subarray(offset, offset + frameSize));
      if (value) {
        if (frameId === "TIT2") metadata.title = value;
        if (frameId === "TPE1") metadata.artist = value;
        if (frameId === "TALB") metadata.album = value;
        if (frameId === "TCOP") metadata.copyright = value;
      }
      offset += frameSize;
    }

    return metadata;
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure after metadata best-effort read.
      }
    }
  }
}

function readAudioMetadata(filePath: string): AudioMetadata {
  return extname(filePath).toLowerCase() === ".mp3" ? readMp3Metadata(filePath) : {};
}

function sanitizeTrackMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeTrackMetadata(filePath: string, raw: Partial<MusicTrack> = {}, source: MusicTrack["source"]): MusicTrack {
  const metadata = readAudioMetadata(filePath);
  return {
    filePath,
    title: sanitizeTrackMetadata(raw.title) ?? metadata.title,
    artist: sanitizeTrackMetadata(raw.artist) ?? metadata.artist,
    album: sanitizeTrackMetadata(raw.album) ?? metadata.album,
    copyright: sanitizeTrackMetadata(raw.copyright) ?? metadata.copyright,
    source
  };
}

function pathKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

function loadBundledAudioDefaults(audioRoot?: string): BundledAudioDefaults {
  const defaults: BundledAudioDefaults = { soundEffects: {}, musicTracks: [] };
  if (!audioRoot || !existsSync(audioRoot)) {
    return defaults;
  }

  const soundRoot = join(audioRoot, "soundeffects");
  for (const effectId of soundEffectIds) {
    const filePath = join(soundRoot, BUNDLED_SOUND_FILES[effectId]);
    try {
      if (statSync(filePath).isFile()) {
        defaults.soundEffects[effectId] = {
          filePath,
          volume: 1,
          enabled: true,
          source: "bundled"
        };
      }
    } catch {
      // Missing bundled sounds fail silently; the effect becomes a no-op.
    }
  }

  const musicRoot = join(audioRoot, "music");
  try {
    defaults.musicTracks = readdirSync(musicRoot)
      .filter((name) => AUDIO_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .flatMap((name) => {
        const filePath = join(musicRoot, name);
        try {
          return statSync(filePath).isFile() ? [mergeTrackMetadata(filePath, {}, "bundled")] : [];
        } catch {
          return [];
        }
      });
  } catch {
    defaults.musicTracks = [];
  }

  return defaults;
}

type LegacyAccount = SteamAccountSettings & { webApiKey?: EncryptedSecret };
type LegacySettings = Partial<Omit<AppSettings, "steamAccounts">> & {
  steamAccount?: LegacyAccount;
  steamAccounts?: LegacyAccount[];
};

function normalizeLibraryView(view: unknown): LibraryView {
  const candidate = view && typeof view === "object" ? view as Partial<LibraryView> : {};
  return {
    filters: {
      ...defaultLibraryView.filters,
      ...(candidate.filters ?? {})
    },
    sort: {
      ...defaultLibraryView.sort,
      ...(candidate.sort ?? {})
    }
  };
}

function sanitizeGameGroups(value: unknown): GameGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): GameGroup[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const group = entry as Partial<GameGroup>;
    if (typeof group.id !== "string" || !group.id || typeof group.name !== "string" || !group.name) {
      return [];
    }
    const createdAt = typeof group.createdAt === "string" ? group.createdAt : new Date().toISOString();
    const updatedAt = typeof group.updatedAt === "string" ? group.updatedAt : createdAt;
    if (group.kind === "manual") {
      return [{
        id: group.id,
        kind: "manual",
        name: group.name,
        gameIds: Array.isArray(group.gameIds) ? group.gameIds.filter((id): id is string => typeof id === "string" && Boolean(id)) : [],
        createdAt,
        updatedAt
      }];
    }
    if (group.kind === "smart") {
      return [{
        id: group.id,
        kind: "smart",
        name: group.name,
        search: typeof group.search === "string" ? group.search : undefined,
        view: normalizeLibraryView(group.view),
        createdAt,
        updatedAt
      }];
    }
    return [];
  });
}

function clampVolume(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function sanitizePlayback(value: unknown): SoundEffectPlayback | undefined {
  return value === "overlap" || value === "restart" || value === "fade" ? value : undefined;
}

function sanitizeSoundSettings(value: unknown, bundledAudio: BundledAudioDefaults = { soundEffects: {}, musicTracks: [] }): SoundSettings {
  const candidate = value && typeof value === "object" ? value as Partial<SoundSettings> : {};
  const rawEffects = candidate.effects && typeof candidate.effects === "object" ? candidate.effects : {};
  const effects: SoundSettings["effects"] = {};

  for (const id of soundEffectIds) {
    const raw = rawEffects[id];
    const fallback = bundledAudio.soundEffects[id];
    const effect = raw && typeof raw === "object"
      ? raw as { filePath?: unknown; volume?: unknown; enabled?: unknown; playback?: unknown; source?: unknown }
      : {};
    const rawFilePath = typeof effect.filePath === "string" && effect.filePath.trim()
      ? effect.filePath.trim()
      : undefined;
    const filePath = effect.source === "bundled"
      ? fallback?.filePath
      : rawFilePath ?? fallback?.filePath;
    if (!filePath) continue;
    const source = fallback?.filePath && effect.source !== "custom" && pathKey(filePath) === pathKey(fallback.filePath)
      ? "bundled"
      : "custom";
    effects[id] = {
      filePath,
      volume: clampVolume(effect.volume, 1),
      enabled: effect.enabled !== false,
      playback: sanitizePlayback(effect.playback),
      source
    };
  }

  return {
    masterVolume: clampVolume(candidate.masterVolume, DEFAULT_SOUND_SETTINGS.masterVolume),
    muted: candidate.muted === true,
    effects
  };
}

function clampMs(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function sanitizeMusicSettings(value: unknown, bundledAudio: BundledAudioDefaults = { soundEffects: {}, musicTracks: [] }): MusicSettings {
  const candidate = value && typeof value === "object" ? value as Partial<MusicSettings> : {};
  const bundledPathKeys = new Set(bundledAudio.musicTracks.map((track) => pathKey(track.filePath)));
  const tracks = Array.isArray(candidate.tracks)
    ? candidate.tracks.flatMap((track) => {
      const filePath = typeof track?.filePath === "string" ? track.filePath.trim() : "";
      if (!filePath || track?.source === "bundled" || bundledPathKeys.has(pathKey(filePath))) return [];
      return [mergeTrackMetadata(filePath, track as Partial<MusicTrack>, "custom")];
    })
    : [];
  const gapMinMs = clampMs(candidate.gapMinMs, DEFAULT_MUSIC_SETTINGS.gapMinMs!, 0, 600_000);
  const gapMaxMs = clampMs(candidate.gapMaxMs, DEFAULT_MUSIC_SETTINGS.gapMaxMs!, 0, 600_000);

  return {
    enabled: candidate.enabled !== false,
    volume: clampVolume(candidate.volume, DEFAULT_MUSIC_SETTINGS.volume!),
    tracks: [...bundledAudio.musicTracks, ...tracks],
    startupDelayEnabled: candidate.startupDelayEnabled !== false,
    startupDelayMs: clampMs(candidate.startupDelayMs, DEFAULT_MUSIC_SETTINGS.startupDelayMs!, 0, 60_000),
    fadesEnabled: candidate.fadesEnabled !== false,
    trackFadeInMs: clampMs(candidate.trackFadeInMs, DEFAULT_MUSIC_SETTINGS.trackFadeInMs!, 0, 30_000),
    pauseFadeOutMs: clampMs(candidate.pauseFadeOutMs, DEFAULT_MUSIC_SETTINGS.pauseFadeOutMs!, 0, 30_000),
    resumeFadeInMs: clampMs(candidate.resumeFadeInMs, DEFAULT_MUSIC_SETTINGS.resumeFadeInMs!, 0, 30_000),
    gameLaunchFadeOutMs: clampMs(candidate.gameLaunchFadeOutMs, DEFAULT_MUSIC_SETTINGS.gameLaunchFadeOutMs!, 0, 10_000),
    pauseOnGameLaunch: candidate.pauseOnGameLaunch !== false,
    pauseOnFocusLoss: candidate.pauseOnFocusLoss !== false,
    pauseOnSystemAudio: candidate.pauseOnSystemAudio !== false,
    continuousPlay: candidate.continuousPlay === true,
    gapMinMs: Math.min(gapMinMs, gapMaxMs),
    gapMaxMs: Math.max(gapMinMs, gapMaxMs)
  };
}

function sanitizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function sanitizeWindowBounds(value: unknown): WindowBounds | undefined {
  const candidate = value && typeof value === "object" ? value as Partial<WindowBounds> : {};
  const x = sanitizeFiniteNumber(candidate.x);
  const y = sanitizeFiniteNumber(candidate.y);
  const width = sanitizeFiniteNumber(candidate.width);
  const height = sanitizeFiniteNumber(candidate.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return undefined;
  }
  return { x, y, width, height };
}

function sanitizeWindowState(value: unknown): WindowState | undefined {
  const candidate = value && typeof value === "object" ? value as Partial<WindowState> : {};
  const bounds = sanitizeWindowBounds(candidate.bounds);
  const displayId = sanitizeFiniteNumber(candidate.displayId);
  const isMaximized = candidate.isMaximized === true;
  if (!bounds && displayId === undefined && !isMaximized) {
    return undefined;
  }
  return {
    ...(bounds ? { bounds } : {}),
    ...(displayId !== undefined ? { displayId } : {}),
    isMaximized
  };
}

function migrate(raw: LegacySettings, bundledAudio: BundledAudioDefaults): AppSettings {
  const rawAccounts: LegacyAccount[] = Array.isArray(raw.steamAccounts)
    ? raw.steamAccounts
    : raw.steamAccount
      ? [raw.steamAccount]
      : [];

  // Lift any per-account webApiKey to the top-level setting (first one wins).
  let liftedKey: EncryptedSecret | undefined = raw.steamWebApiKey;
  const cleanedAccounts: SteamAccountSettings[] = rawAccounts.map((account) => {
    const { webApiKey, ...rest } = account;
    if (!liftedKey && webApiKey) {
      liftedKey = webApiKey;
    }
    return rest;
  });

  const { steamAccount: _ignored, steamAccounts: _ignored2, steamWebApiKey: _ignored3, ...rest } = raw;
  return {
    ...defaultSettings,
    ...rest,
    steamAccounts: cleanedAccounts,
    steamWebApiKey: liftedKey,
    gameGroups: sanitizeGameGroups(raw.gameGroups),
    sound: sanitizeSoundSettings(raw.sound, bundledAudio),
    music: sanitizeMusicSettings(raw.music, bundledAudio),
    windowState: sanitizeWindowState(raw.windowState)
  };
}

export class SettingsService {
  private bundledAudioCache: BundledAudioDefaults | undefined;

  constructor(private readonly filePath: string, private readonly audioRoot?: string) {}

  private bundledAudio(): BundledAudioDefaults {
    this.bundledAudioCache ??= loadBundledAudioDefaults(this.audioRoot);
    return this.bundledAudioCache;
  }

  async get(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return migrate(JSON.parse(raw) as LegacySettings, this.bundledAudio());
    } catch {
      return {
        ...defaultSettings,
        steamAccounts: [],
        sound: sanitizeSoundSettings(defaultSettings.sound, this.bundledAudio()),
        music: sanitizeMusicSettings(defaultSettings.music, this.bundledAudio())
      };
    }
  }

  async getWindowState(): Promise<WindowState | undefined> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return sanitizeWindowState((JSON.parse(raw) as LegacySettings).windowState);
    } catch {
      return undefined;
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next: AppSettings = { ...(await this.get()), ...patch };
    if (!Array.isArray(next.steamAccounts)) {
      next.steamAccounts = [];
    }
    next.gameGroups = sanitizeGameGroups(next.gameGroups);
    next.sound = sanitizeSoundSettings(next.sound, this.bundledAudio());
    next.music = sanitizeMusicSettings(next.music, this.bundledAudio());
    next.windowState = sanitizeWindowState(next.windowState);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(next, null, 2));
    return next;
  }

  async upsertSteamAccount(account: SteamAccountSettings): Promise<AppSettings> {
    const current = await this.get();
    const others = current.steamAccounts.filter((existing) => existing.steamId !== account.steamId);
    return this.update({ steamAccounts: [...others, account] });
  }

  async patchSteamAccount(steamId: string, patch: Partial<SteamAccountSettings>): Promise<AppSettings> {
    const current = await this.get();
    const next = current.steamAccounts.map((account) =>
      account.steamId === steamId ? { ...account, ...patch } : account
    );
    return this.update({ steamAccounts: next });
  }

  async removeSteamAccount(steamId: string): Promise<AppSettings> {
    const current = await this.get();
    return this.update({ steamAccounts: current.steamAccounts.filter((account) => account.steamId !== steamId) });
  }

  async setLaunchAccountPreference(gameId: string, steamId: string | undefined): Promise<AppSettings> {
    const current = await this.get();
    const next = { ...(current.launchAccountPreferences ?? {}) };
    if (steamId) {
      next[gameId] = steamId;
    } else {
      delete next[gameId];
    }
    return this.update({ launchAccountPreferences: next });
  }

  async setGameGroups(gameGroups: GameGroup[]): Promise<AppSettings> {
    return this.update({ gameGroups });
  }
}
