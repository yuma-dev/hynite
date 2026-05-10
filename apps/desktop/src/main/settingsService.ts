import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultLibraryView, type AppSettings, type EncryptedSecret, type SteamAccountSettings } from "@hynite/core";

const defaultSettings: AppSettings = {
  steamAccounts: [],
  steamWebApiKey: undefined,
  steamGridDbApiKey: undefined,
  cacheTtlHours: 24,
  reduceMotion: false,
  libraryView: defaultLibraryView,
  launchAccountPreferences: {}
};

type LegacyAccount = SteamAccountSettings & { webApiKey?: EncryptedSecret };
type LegacySettings = Partial<Omit<AppSettings, "steamAccounts">> & {
  steamAccount?: LegacyAccount;
  steamAccounts?: LegacyAccount[];
};

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
    steamWebApiKey: liftedKey
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
}
