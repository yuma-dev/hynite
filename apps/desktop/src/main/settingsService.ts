import { existsSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { controllerActionIds, defaultLibraryView, defaultWishlistView, soundEffectIds, type AppSettings, type BackgroundWorkload, type ControllerActionId, type ControllerButtonBinding, type ControllerSettings, type EncryptedSecret, type GameGroup, type LibraryView, type MusicSettings, type MusicTrack, type SettingsBackupInfo, type SettingsHealthWarning, type SoundEffectId, type SoundEffectPlayback, type SoundSettings, type SpotlightSettings, type SteamAccountSettings, type WindowBounds, type WindowState, type WishlistView } from "@hynite/core";
import { readAudioMetadata } from "./audioMetadata";

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
  startupWithSoundEnabled: false,
  startupWithSoundFadeInMs: 8_000,
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

const DEFAULT_CONTROLLER_BINDINGS: Record<ControllerActionId, ControllerButtonBinding> = {
  focusBigPicture: { buttons: [8, 9] },
  exitBigPicture: { buttons: [8, 9] },
  moveUp: { buttons: [12] },
  moveDown: { buttons: [13] },
  moveLeft: { buttons: [14] },
  moveRight: { buttons: [15] },
  previousGroup: { buttons: [4] },
  nextGroup: { buttons: [5] },
  play: { buttons: [0] },
  details: { buttons: [2] },
  filters: { buttons: [3] },
  back: { buttons: [1] },
  toggleGrid: { buttons: [10] },
  favoriteTab: { buttons: [9] }
};

const DEFAULT_CONTROLLER_SETTINGS: ControllerSettings = {
  enabled: true,
  backgroundInput: true,
  bindings: DEFAULT_CONTROLLER_BINDINGS
};

const DEFAULT_SPOTLIGHT_SETTINGS: SpotlightSettings = {
  enabled: true,
  hotkey: "Alt+Space"
};

const SETTINGS_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SETTINGS_BACKUP_MAX_FILES = 30;

const AUDIO_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"]);
const BUNDLED_SOUND_FILES: Record<SoundEffectId, string> = {
  startup: "startup.mp3",
  gameSelect: "selection.mp3",
  gameLaunch: "gamestart.mp3",
  bigPictureOpen: "bplaunch.mp3",
  navigation: "selection.mp3"
};

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
  startWithWindows: true,
  closeToTray: true,
  backgroundUpdatesEnabled: true,
  backgroundWorkload: "balanced",
  backgroundPlaytimeTracking: true,
  cardsPerRow: 6,
  libraryView: defaultLibraryView,
  wishlistView: defaultWishlistView,
  launchAccountPreferences: {},
  gameGroups: [],
  localRoots: [],
  localExcludePatterns: DEFAULT_LOCAL_EXCLUDE_PATTERNS,
  sound: DEFAULT_SOUND_SETTINGS,
  music: DEFAULT_MUSIC_SETTINGS,
  controller: DEFAULT_CONTROLLER_SETTINGS,
  spotlight: DEFAULT_SPOTLIGHT_SETTINGS,
  windowState: undefined,
  bigPictureGrayscaleCovers: true
};

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

function sanitizeCardsPerRow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(12, Math.max(4, Math.round(value)))
    : defaultSettings.cardsPerRow ?? 8;
}

function sanitizeWishlistView(value: unknown): WishlistView {
  const candidate = value as Partial<WishlistView> | undefined;
  const field = candidate?.sort?.field;
  const direction = candidate?.sort?.direction;
  return {
    sort: {
      field: field === "title" || field === "release" || field === "added" || field === "account"
        ? field
        : defaultWishlistView.sort.field,
      direction: direction === "asc" || direction === "desc" ? direction : defaultWishlistView.sort.direction
    }
  };
}

function sanitizeBackgroundWorkload(value: unknown): BackgroundWorkload {
  return value === "minimum" || value === "balanced" || value === "max" ? value : "balanced";
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
    startupWithSoundEnabled: candidate.startupWithSoundEnabled === true,
    startupWithSoundFadeInMs: clampMs(candidate.startupWithSoundFadeInMs, DEFAULT_MUSIC_SETTINGS.startupWithSoundFadeInMs!, 0, 60_000),
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

function sanitizeControllerButtonBinding(value: unknown): ControllerButtonBinding | undefined {
  const candidate = value && typeof value === "object" ? value as Partial<ControllerButtonBinding> : {};
  if (!Array.isArray(candidate.buttons)) {
    return undefined;
  }
  const buttons = [...new Set(candidate.buttons
    .filter((button): button is number => Number.isInteger(button) && button >= 0 && button <= 255)
    .map((button) => Math.round(button)))]
    .slice(0, 4);
  return buttons.length ? { buttons } : undefined;
}

function sanitizeControllerSettings(value: unknown): ControllerSettings {
  const candidate = value && typeof value === "object" ? value as Partial<ControllerSettings> : {};
  const rawBindings = candidate.bindings && typeof candidate.bindings === "object" ? candidate.bindings : {};
  const bindings: Partial<Record<ControllerActionId, ControllerButtonBinding>> = { ...DEFAULT_CONTROLLER_BINDINGS };
  for (const action of controllerActionIds) {
    const binding = sanitizeControllerButtonBinding((rawBindings as Partial<Record<ControllerActionId, unknown>>)[action]);
    if (binding) {
      bindings[action] = binding;
    }
  }
  return {
    enabled: candidate.enabled !== false,
    backgroundInput: candidate.backgroundInput !== false,
    bindings
  };
}

function sanitizeSpotlightSettings(value: unknown): SpotlightSettings {
  const candidate = value && typeof value === "object" ? value as Partial<SpotlightSettings> : {};
  const hotkey = typeof candidate.hotkey === "string" ? candidate.hotkey.trim().replace(/\s+/g, "") : "";
  const validHotkey = /^[A-Za-z0-9+]+$/.test(hotkey) && hotkey.includes("+");
  return {
    enabled: candidate.enabled !== false,
    hotkey: validHotkey ? hotkey : DEFAULT_SPOTLIGHT_SETTINGS.hotkey
  };
}

function sanitizeIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function sanitizeOnboarding(value: unknown): AppSettings["onboarding"] {
  const candidate = value && typeof value === "object"
    ? value as Partial<NonNullable<AppSettings["onboarding"]>>
    : {};
  if (candidate.version !== 1) {
    return undefined;
  }
  const completedAt = sanitizeIsoString(candidate.completedAt);
  const skippedAt = sanitizeIsoString(candidate.skippedAt);
  if (!completedAt && !skippedAt) {
    return undefined;
  }
  return {
    version: 1,
    ...(completedAt ? { completedAt } : {}),
    ...(skippedAt ? { skippedAt } : {})
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
    startWithWindows: raw.startWithWindows !== false,
    closeToTray: raw.closeToTray !== false,
    backgroundUpdatesEnabled: raw.backgroundUpdatesEnabled !== false,
    backgroundWorkload: sanitizeBackgroundWorkload(raw.backgroundWorkload),
    backgroundPlaytimeTracking: raw.backgroundPlaytimeTracking !== false,
    cardsPerRow: sanitizeCardsPerRow(raw.cardsPerRow),
    wishlistView: sanitizeWishlistView(raw.wishlistView),
    gameGroups: sanitizeGameGroups(raw.gameGroups),
    sound: sanitizeSoundSettings(raw.sound, bundledAudio),
    music: sanitizeMusicSettings(raw.music, bundledAudio),
    onboarding: sanitizeOnboarding(raw.onboarding),
    controller: sanitizeControllerSettings(raw.controller),
    spotlight: sanitizeSpotlightSettings(raw.spotlight),
    windowState: sanitizeWindowState(raw.windowState),
    bigPictureGrayscaleCovers: raw.bigPictureGrayscaleCovers !== false
  };
}

function backupTimestampName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function backupCreatedAtFromName(fileName: string): string | undefined {
  const match = /^settings-(.+)\.json$/.exec(fileName);
  if (!match) return undefined;
  const iso = match[1]!.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z"
  );
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function settingsBackupInfo(fileName: string, createdAt: string): SettingsBackupInfo {
  const id = fileName.replace(/\.json$/i, "");
  return {
    id,
    fileName,
    createdAt,
    restoreCommand: `await window.__hyniteSettings.restore("${id}")`
  };
}

function hasMeaningfulUserState(settings: AppSettings): boolean {
  return Boolean(
    settings.steamAccounts.length > 0 ||
    settings.steamWebApiKey ||
    settings.steamGridDbApiKey ||
    settings.igdb ||
    (settings.gameGroups?.length ?? 0) > 0 ||
    (settings.localRoots?.length ?? 0) > 0 ||
    (settings.localIgnoredPaths?.length ?? 0) > 0 ||
    Object.keys(settings.launchAccountPreferences ?? {}).length > 0 ||
    settings.onboarding ||
    settings.bigPictureDefaultTabId ||
    settings.reduceMotion ||
    settings.autoHideAfterLaunch === false ||
    settings.startWithWindows === false ||
    settings.closeToTray === false ||
    settings.backgroundUpdatesEnabled === false ||
    settings.backgroundPlaytimeTracking === false ||
    settings.backgroundWorkload !== "balanced" ||
    settings.spotlight?.enabled === false ||
    settings.spotlight?.hotkey !== DEFAULT_SPOTLIGHT_SETTINGS.hotkey ||
    settings.cardsPerRow !== defaultSettings.cardsPerRow ||
    settings.bigPictureGrayscaleCovers === false
  );
}

export class SettingsService {
  private bundledAudioCache: BundledAudioDefaults | undefined;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly audioRoot?: string,
    private readonly deps: { rename?: typeof rename; sleep?: (ms: number) => Promise<void> } = {}
  ) {}

  private bundledAudio(): BundledAudioDefaults {
    this.bundledAudioCache ??= loadBundledAudioDefaults(this.audioRoot);
    return this.bundledAudioCache;
  }

  private backupPath(): string {
    return `${this.filePath}.bak`;
  }

  private periodicBackupDir(): string {
    return join(dirname(this.filePath), "settings-backups");
  }

  hasPersistedSettings(): boolean {
    return existsSync(this.filePath) || existsSync(this.backupPath());
  }

  private async readRawSettings(): Promise<LegacySettings | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as LegacySettings;
    } catch (primaryError) {
      try {
        return JSON.parse(await readFile(this.backupPath(), "utf8")) as LegacySettings;
      } catch {
        if (!(primaryError instanceof Error && "code" in primaryError && primaryError.code === "ENOENT")) {
          console.warn(`Settings file could not be read; using defaults. ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
        }
        return undefined;
      }
    }
  }

  private async writeSettings(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) {
      await copyFile(this.filePath, this.backupPath()).catch(() => undefined);
    }
    const tempPath = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
    );
    await writeFile(tempPath, JSON.stringify(settings, null, 2));
    await this.renameWithRetry(tempPath, this.filePath);
    await copyFile(this.filePath, this.backupPath()).catch(() => undefined);
  }

  private async renameWithRetry(from: string, to: string): Promise<void> {
    const attempts = process.platform === "win32" ? 5 : 1;
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      try {
        await (this.deps.rename ?? rename)(from, to);
        return;
      } catch (error) {
        lastError = error;
        const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
        if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) {
          throw error;
        }
        if (index < attempts - 1) {
          await (this.deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(40 * (index + 1));
        }
      }
    }
    await rm(from, { force: true }).catch(() => undefined);
    throw lastError instanceof Error ? lastError : new Error(`Failed to rename ${from} to ${to}.`);
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private periodicBackupFiles(): SettingsBackupInfo[] {
    try {
      return readdirSync(this.periodicBackupDir())
        .flatMap((fileName) => {
          const createdAt = backupCreatedAtFromName(fileName);
          return createdAt ? [settingsBackupInfo(fileName, createdAt)] : [];
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    } catch {
      return [];
    }
  }

  private async prunePeriodicBackups(): Promise<void> {
    const backups = this.periodicBackupFiles();
    await Promise.all(backups.slice(SETTINGS_BACKUP_MAX_FILES).map((backup) =>
      rm(join(this.periodicBackupDir(), backup.fileName), { force: true }).catch(() => undefined)
    ));
  }

  async createPeriodicBackupIfDue(): Promise<SettingsBackupInfo | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    const current = await this.get();
    if (!hasMeaningfulUserState(current)) return undefined;
    const latest = this.periodicBackupFiles()[0];
    if (latest && Date.now() - Date.parse(latest.createdAt) < SETTINGS_BACKUP_INTERVAL_MS) {
      return undefined;
    }
    await mkdir(this.periodicBackupDir(), { recursive: true });
    const createdAt = new Date();
    const fileName = `settings-${backupTimestampName(createdAt)}.json`;
    await copyFile(this.filePath, join(this.periodicBackupDir(), fileName));
    await this.prunePeriodicBackups();
    return settingsBackupInfo(fileName, createdAt.toISOString());
  }

  listBackups(): SettingsBackupInfo[] {
    return this.periodicBackupFiles();
  }

  async restoreBackup(id: string): Promise<AppSettings> {
    return this.runExclusive(async () => {
      const backup = this.periodicBackupFiles().find((entry) => entry.id === id || entry.fileName === id);
      if (!backup) {
        throw new Error(`Settings backup ${id} was not found.`);
      }
      const raw = JSON.parse(await readFile(join(this.periodicBackupDir(), backup.fileName), "utf8")) as LegacySettings;
      const restored = migrate(raw, this.bundledAudio());
      await this.writeSettings(restored);
      return restored;
    });
  }

  async detectHealthWarning(): Promise<SettingsHealthWarning | undefined> {
    if (!this.hasPersistedSettings()) return undefined;
    const current = await this.get();
    if (hasMeaningfulUserState(current)) return undefined;
    const usefulBackups: SettingsBackupInfo[] = [];
    for (const backup of this.periodicBackupFiles()) {
      try {
        const raw = JSON.parse(await readFile(join(this.periodicBackupDir(), backup.fileName), "utf8")) as LegacySettings;
        if (hasMeaningfulUserState(migrate(raw, this.bundledAudio()))) {
          usefulBackups.push(backup);
        }
      } catch {
        // Ignore unreadable backup entries.
      }
    }
    if (usefulBackups.length === 0) return undefined;
    return {
      kind: "clean-slate-reset",
      message: "Settings look like a clean slate even though older backups contain configured settings.",
      backups: usefulBackups.slice(0, 5)
    };
  }

  async get(): Promise<AppSettings> {
    const raw = await this.readRawSettings();
    if (!raw) {
      return {
        ...defaultSettings,
        steamAccounts: [],
        sound: sanitizeSoundSettings(defaultSettings.sound, this.bundledAudio()),
        music: sanitizeMusicSettings(defaultSettings.music, this.bundledAudio()),
        controller: sanitizeControllerSettings(defaultSettings.controller),
        spotlight: sanitizeSpotlightSettings(defaultSettings.spotlight)
      };
    }
    return migrate(raw, this.bundledAudio());
  }

  async getWindowState(): Promise<WindowState | undefined> {
    return sanitizeWindowState((await this.readRawSettings())?.windowState);
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.runExclusive(() => this.updateUnlocked(patch));
  }

  async upsertSteamAccount(account: SteamAccountSettings): Promise<AppSettings> {
    return this.runExclusive(async () => {
      const current = await this.get();
      const others = current.steamAccounts.filter((existing) => existing.steamId !== account.steamId);
      return this.updateUnlocked({ steamAccounts: [...others, account] });
    });
  }

  async patchSteamAccount(steamId: string, patch: Partial<SteamAccountSettings>): Promise<AppSettings> {
    return this.runExclusive(async () => {
      const current = await this.get();
      const next = current.steamAccounts.map((account) =>
        account.steamId === steamId ? { ...account, ...patch } : account
      );
      return this.updateUnlocked({ steamAccounts: next });
    });
  }

  async removeSteamAccount(steamId: string): Promise<AppSettings> {
    return this.runExclusive(async () => {
      const current = await this.get();
      return this.updateUnlocked({ steamAccounts: current.steamAccounts.filter((account) => account.steamId !== steamId) });
    });
  }

  async setLaunchAccountPreference(gameId: string, steamId: string | undefined): Promise<AppSettings> {
    return this.runExclusive(async () => {
      const current = await this.get();
      const next = { ...(current.launchAccountPreferences ?? {}) };
      if (steamId) {
        next[gameId] = steamId;
      } else {
        delete next[gameId];
      }
      return this.updateUnlocked({ launchAccountPreferences: next });
    });
  }

  async setGameGroups(gameGroups: GameGroup[]): Promise<AppSettings> {
    return this.runExclusive(async () => this.updateUnlocked({ gameGroups }));
  }

  private async updateUnlocked(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next: AppSettings = { ...(await this.get()), ...patch };
    if (!Array.isArray(next.steamAccounts)) {
      next.steamAccounts = [];
    }
    next.startWithWindows = next.startWithWindows !== false;
    next.closeToTray = next.closeToTray !== false;
    next.backgroundUpdatesEnabled = next.backgroundUpdatesEnabled !== false;
    next.backgroundWorkload = sanitizeBackgroundWorkload(next.backgroundWorkload);
    next.backgroundPlaytimeTracking = next.backgroundPlaytimeTracking !== false;
    next.cardsPerRow = sanitizeCardsPerRow(next.cardsPerRow);
    next.wishlistView = sanitizeWishlistView(next.wishlistView);
    next.gameGroups = sanitizeGameGroups(next.gameGroups);
    next.sound = sanitizeSoundSettings(next.sound, this.bundledAudio());
    next.music = sanitizeMusicSettings(next.music, this.bundledAudio());
    next.onboarding = sanitizeOnboarding(next.onboarding);
    next.controller = sanitizeControllerSettings(next.controller);
    next.spotlight = sanitizeSpotlightSettings(next.spotlight);
    next.windowState = sanitizeWindowState(next.windowState);
    next.bigPictureGrayscaleCovers = next.bigPictureGrayscaleCovers !== false;
    await this.writeSettings(next);
    return next;
  }
}
