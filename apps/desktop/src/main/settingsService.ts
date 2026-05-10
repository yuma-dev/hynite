import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultLibraryView, type AppSettings, type EncryptedSecret, type GameGroup, type LibraryView, type SteamAccountSettings } from "@hynite/core";

const defaultSettings: AppSettings = {
  steamAccounts: [],
  steamWebApiKey: undefined,
  steamGridDbApiKey: undefined,
  cacheTtlHours: 24,
  reduceMotion: false,
  libraryView: defaultLibraryView,
  launchAccountPreferences: {},
  gameGroups: []
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
    gameGroups: sanitizeGameGroups(raw.gameGroups)
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
