import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultLibraryView, soundEffectIds, type AppSettings, type EncryptedSecret, type GameGroup, type LibraryView, type MusicSettings, type SoundEffectPlayback, type SoundSettings, type SteamAccountSettings } from "@hynite/core";

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
  masterVolume: 0.8,
  muted: false,
  effects: {}
};

const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  enabled: true,
  volume: 0.4,
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
  music: DEFAULT_MUSIC_SETTINGS
};

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

function sanitizeSoundSettings(value: unknown): SoundSettings {
  const candidate = value && typeof value === "object" ? value as Partial<SoundSettings> : {};
  const rawEffects = candidate.effects && typeof candidate.effects === "object" ? candidate.effects : {};
  const effects: SoundSettings["effects"] = {};

  for (const id of soundEffectIds) {
    const raw = rawEffects[id];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const effect = raw as { filePath?: unknown; volume?: unknown; enabled?: unknown; playback?: unknown };
    const filePath = typeof effect.filePath === "string" ? effect.filePath.trim() : "";
    effects[id] = {
      filePath: filePath || undefined,
      volume: clampVolume(effect.volume, 1),
      enabled: effect.enabled !== false,
      playback: sanitizePlayback(effect.playback)
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

function sanitizeMusicSettings(value: unknown): MusicSettings {
  const candidate = value && typeof value === "object" ? value as Partial<MusicSettings> : {};
  const tracks = Array.isArray(candidate.tracks)
    ? candidate.tracks.flatMap((track) => {
      const filePath = typeof track?.filePath === "string" ? track.filePath.trim() : "";
      return filePath ? [{ filePath }] : [];
    })
    : [];
  const gapMinMs = clampMs(candidate.gapMinMs, DEFAULT_MUSIC_SETTINGS.gapMinMs!, 0, 600_000);
  const gapMaxMs = clampMs(candidate.gapMaxMs, DEFAULT_MUSIC_SETTINGS.gapMaxMs!, 0, 600_000);

  return {
    enabled: candidate.enabled !== false,
    volume: clampVolume(candidate.volume, DEFAULT_MUSIC_SETTINGS.volume!),
    tracks,
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

function migrate(raw: LegacySettings): AppSettings {
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
    sound: sanitizeSoundSettings(raw.sound),
    music: sanitizeMusicSettings(raw.music)
  };
}

export class SettingsService {
  constructor(private readonly filePath: string) {}

  async get(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return migrate(JSON.parse(raw) as LegacySettings);
    } catch {
      return { ...defaultSettings, steamAccounts: [] };
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next: AppSettings = { ...(await this.get()), ...patch };
    if (!Array.isArray(next.steamAccounts)) {
      next.steamAccounts = [];
    }
    next.gameGroups = sanitizeGameGroups(next.gameGroups);
    next.sound = sanitizeSoundSettings(next.sound);
    next.music = sanitizeMusicSettings(next.music);
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
