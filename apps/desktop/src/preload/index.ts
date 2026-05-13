import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  DownloadSourceInfo,
  Game,
  GameAssetCandidateResult,
  GameAssetUpdate,
  GameDetail,
  HomeModel,
  LaunchSession,
  LibraryQuery,
  OnboardingState,
  ProviderId,
  SettingsBackupInfo,
  SettingsHealthWarning,
  SourceExactMatch,
  SourceImportInput,
  SourceImportResult,
  SourceMatch,
  SourceSearchOptions,
  SoundEffectId,
  SteamActiveUser,
  SteamLocalAccount,
  SteamPairingResult,
  SteamSearchResult,
  SyncStatus,
  SyncResult
} from "@hynite/core";

export type LaunchOutcome =
  | ({ kind: "launched" } & LaunchSession)
  | {
      kind: "requires-switch";
      gameId: string;
      gameTitle: string;
      currentAccountName?: string;
      currentSteamId?: string;
      target: { steamId: string; accountName: string; personaName?: string };
    }
  | { kind: "no-account"; reason: string };

const api = {
  onboarding: {
    state: (): Promise<OnboardingState> => ipcRenderer.invoke("onboarding:state"),
    complete: (input?: { skipped?: boolean }): Promise<AppSettings> => ipcRenderer.invoke("onboarding:complete", input)
  },
  library: {
    sync: (providerId?: ProviderId): Promise<SyncResult> => ipcRenderer.invoke("library:sync", providerId),
    list: (query: LibraryQuery): Promise<Game[]> => ipcRenderer.invoke("library:list", query),
    clear: (): Promise<{ cleared: number }> => ipcRenderer.invoke("library:clear")
  },
  games: {
    get: (id: string): Promise<GameDetail> => ipcRenderer.invoke("games:get", id),
    getAssetCandidates: (id: string): Promise<GameAssetCandidateResult> => ipcRenderer.invoke("games:get-asset-candidates", id),
    updateAssets: (id: string, update: GameAssetUpdate): Promise<GameDetail> => ipcRenderer.invoke("games:update-assets", id, update),
    hydrateDiscovery: (game: Game): Promise<GameDetail> => ipcRenderer.invoke("games:hydrateDiscovery", game),
    launch: (id: string, preferredSteamId?: string): Promise<LaunchOutcome> =>
      ipcRenderer.invoke("games:launch", id, preferredSteamId),
    setLaunchExe: (gameId: string, executablePath: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke("games:set-launch-exe", { gameId, executablePath }),
    onUpdated: (callback: (game: GameDetail) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, game: GameDetail) => callback(game);
      ipcRenderer.on("games:updated", listener);
      return () => ipcRenderer.removeListener("games:updated", listener);
    }
  },
  local: {
    scan: (): Promise<{ scanned: number; skipped: number; matched: number; ambiguous: number; unmatched: number; issues: unknown[] }> =>
      ipcRenderer.invoke("local:scan"),
    getIssues: (): Promise<unknown[]> => ipcRenderer.invoke("local:get-issues"),
    resolveAmbiguous: (
      candidateId: string,
      chosen: { provider: "steam" | "igdb"; externalId: string; title: string } | null
    ): Promise<{ ok: true }> => ipcRenderer.invoke("local:resolve-ambiguous", { candidateId, chosen }),
    addSingle: (args: {
      folderPath?: string;
      executablePath?: string;
      titleOverride?: string;
      match?: { provider: "steam" | "igdb"; externalId: string; title: string };
    }): Promise<{
      gameId: string;
      candidateId: string;
      title: string;
      chosenExe: string;
      identification:
        | { kind: "match"; match: { provider: "steam" | "igdb"; externalId: string; title: string; confidence: number; reason: string } }
        | { kind: "ambiguous"; candidates: Array<{ provider: "steam" | "igdb"; externalId: string; title: string; coverUrl?: string; releaseDate?: string }>; topConfidence: number }
        | { kind: "unmatched"; reason: string };
    }> => ipcRenderer.invoke("local:add-single", args),
    probe: (args: { folderPath?: string; executablePath?: string }): Promise<{
      folderPath: string;
      folderName: string;
      candidateId: string;
      exeOptions: Array<{
        path: string;
        size: number;
        productName?: string;
        fileDescription?: string;
        companyName?: string;
        score: number;
        reasons: string[];
        chosen: boolean;
      }>;
      chosenExe: string;
      identification:
        | { kind: "match"; match: { provider: "steam" | "igdb"; externalId: string; title: string; confidence: number; reason: string } }
        | { kind: "ambiguous"; candidates: Array<{ provider: "steam" | "igdb"; externalId: string; title: string; coverUrl?: string; releaseDate?: string }>; topConfidence: number }
        | { kind: "unmatched"; reason: string };
    }> => ipcRenderer.invoke("local:probe", args),
    searchMetadata: (query: string): Promise<{
      steam: Array<{ provider: "steam"; externalId: string; title: string; coverUrl?: string; releaseDate?: string }>;
      igdb: Array<{ provider: "igdb"; externalId: string; title: string; coverUrl?: string; releaseDate?: string }>;
    }> => ipcRenderer.invoke("local:search-metadata", { query }),
    ignoreFolder: (folderPath: string): Promise<AppSettings> => ipcRenderer.invoke("local:ignore-folder", folderPath),
    setIgnored: (paths: string[]): Promise<AppSettings> => ipcRenderer.invoke("local:set-ignored", paths),
    removeAndIgnore: (gameId: string, folderPath?: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke("local:remove-and-ignore", { gameId, folderPath }),
    removeGame: (gameId: string): Promise<{ ok: true }> => ipcRenderer.invoke("local:remove-game", gameId),
    countUnder: (folderPath: string): Promise<number> => ipcRenderer.invoke("local:count-under", folderPath),
    removeUnder: (folderPath: string): Promise<{ removed: number }> => ipcRenderer.invoke("local:remove-under", folderPath),
    removeAll: (): Promise<{ removed: number }> => ipcRenderer.invoke("local:remove-all"),
    repairLibrary: (): Promise<{ deleted: number }> => ipcRenderer.invoke("local:repair-library")
  },
  home: {
    get: (): Promise<HomeModel> => ipcRenderer.invoke("home:get")
  },
  sync: {
    status: (): Promise<SyncStatus> => ipcRenderer.invoke("sync:status"),
    onStatusChanged: (callback: (status: SyncStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: SyncStatus) => callback(status);
      ipcRenderer.on("sync:statusChanged", listener);
      return () => ipcRenderer.removeListener("sync:statusChanged", listener);
    }
  },
  sources: {
    import: (input: SourceImportInput): Promise<SourceImportResult> => ipcRenderer.invoke("sources:import", input),
    list: (): Promise<DownloadSourceInfo[]> => ipcRenderer.invoke("sources:list"),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("sources:remove", id),
    refreshSource: (id: string, json: string): Promise<SourceImportResult> =>
      ipcRenderer.invoke("sources:refreshSource", id, json),
    search: (gameId: string, options?: SourceSearchOptions): Promise<SourceMatch[]> => ipcRenderer.invoke("sources:search", gameId, options),
    searchTitle: (title: string, options?: SourceSearchOptions): Promise<SourceMatch[]> => ipcRenderer.invoke("sources:searchTitle", title, options),
    exactTitleMatches: (title: string): Promise<SourceExactMatch[]> => ipcRenderer.invoke("sources:exactTitleMatches", title)
  },
  clipboard: {
    copy: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:copy", text)
  },
  native: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("native:openExternal", url),
    openFolder: (path: string): Promise<string> => ipcRenderer.invoke("native:openFolder", path)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke("settings:update", patch),
    listBackups: (): Promise<SettingsBackupInfo[]> => ipcRenderer.invoke("settings:list-backups"),
    restoreBackup: (id: string): Promise<AppSettings> => ipcRenderer.invoke("settings:restore-backup", id),
    health: (): Promise<SettingsHealthWarning | undefined> => ipcRenderer.invoke("settings:health")
  },
  sound: {
    url: (effectId: SoundEffectId): string => `hynite-sound:///${encodeURIComponent(effectId)}`
  },
  music: {
    url: (trackIndex: number): string => `hynite-music://track/${trackIndex}`,
    coverUrl: (trackIndex: number): string => `hynite-music://cover/${trackIndex}`,
    isSystemAudioActive: (): Promise<boolean> => ipcRenderer.invoke("music:system-audio-active"),
    systemAudioDebug: (): Promise<string> => ipcRenderer.invoke("music:system-audio-debug"),
    onSystemAudioChanged: (callback: (active: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: boolean) => callback(value);
      ipcRenderer.on("music:systemAudioChanged", listener);
      return () => ipcRenderer.removeListener("music:systemAudioChanged", listener);
    }
  },
  steam: {
    pair: (): Promise<SteamPairingResult> => ipcRenderer.invoke("steam:pair"),
    saveApiKey: (apiKey: string): Promise<AppSettings> => ipcRenderer.invoke("steam:saveApiKey", apiKey),
    clearApiKey: (): Promise<AppSettings> => ipcRenderer.invoke("steam:clearApiKey"),
    disconnect: (steamId?: string): Promise<AppSettings> => ipcRenderer.invoke("steam:disconnect", steamId),
    removeAccount: (steamId: string): Promise<AppSettings> => ipcRenderer.invoke("steam:removeAccount", steamId),
    search: (query: string): Promise<SteamSearchResult[]> => ipcRenderer.invoke("steam:search", query),
    connectFamily: (steamId: string): Promise<AppSettings> => ipcRenderer.invoke("steam:connectFamily", steamId),
    refreshFamily: (steamId: string): Promise<AppSettings> => ipcRenderer.invoke("steam:refreshFamily", steamId),
    disconnectFamily: (steamId: string): Promise<AppSettings> => ipcRenderer.invoke("steam:disconnectFamily", steamId),
    listLocalAccounts: (): Promise<SteamLocalAccount[]> => ipcRenderer.invoke("steam:listLocalAccounts"),
    getActiveUser: (): Promise<SteamActiveUser> => ipcRenderer.invoke("steam:getActiveUser"),
    setAccountLocalUsername: (steamId: string, localUsername: string | undefined): Promise<AppSettings> =>
      ipcRenderer.invoke("steam:setAccountLocalUsername", steamId, localUsername),
    setPreferredLaunchAccount: (gameId: string, steamId: string | undefined): Promise<AppSettings> =>
      ipcRenderer.invoke("steam:setPreferredLaunchAccount", gameId, steamId),
    switchAndLaunch: (gameId: string, targetSteamId: string): Promise<LaunchOutcome> =>
      ipcRenderer.invoke("steam:switchAndLaunch", gameId, targetSteamId)
  },
  metadata: {
    saveSteamGridDbKey: (apiKey: string): Promise<AppSettings> => ipcRenderer.invoke("metadata:saveSteamGridDbKey", apiKey),
    clearSteamGridDbKey: (): Promise<AppSettings> => ipcRenderer.invoke("metadata:clearSteamGridDbKey"),
    saveIgdbCredentials: (clientId: string, clientSecret: string): Promise<AppSettings> =>
      ipcRenderer.invoke("metadata:save-igdb-credentials", { clientId, clientSecret }),
    clearIgdbCredentials: (): Promise<AppSettings> => ipcRenderer.invoke("metadata:clear-igdb-credentials")
  },
  dialog: {
    pickFolder: (args?: { title?: string; defaultPath?: string }): Promise<string | undefined> =>
      ipcRenderer.invoke("dialog:pick-folder", args ?? {}),
    pickFile: (args?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string | undefined> => ipcRenderer.invoke("dialog:pick-file", args ?? {}),
    pickFiles: (args?: {
      title?: string;
      defaultPath?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<string[]> => ipcRenderer.invoke("dialog:pick-files", args ?? {})
  },
  localExt: {
    setRoots: (roots: Array<{ path: string; depth: number }>): Promise<AppSettings> =>
      ipcRenderer.invoke("local:set-roots", roots),
    setExcludePatterns: (patterns: string[]): Promise<AppSettings> =>
      ipcRenderer.invoke("local:set-exclude-patterns", patterns)
  },
  startup: {
    signalReady: (input?: { mode?: "app" | "onboarding" }): void => ipcRenderer.send("startup:ready", input)
  },
  debug: {
    profileEnabled: process.env.HYNITE_STARTUP_PROFILE === "1" || process.env.HYNITE_STARTUP_PROFILE === "true",
    seed: (): Promise<Game> => ipcRenderer.invoke("debug:seed"),
    profile: (entry: { phase: string; message: string; details?: Record<string, unknown>; rendererElapsedMs?: number }): void =>
      ipcRenderer.send("debug:profile", entry),
    profileSpanStart: (entry: Record<string, unknown>): void => ipcRenderer.send("debug:profile-record", entry),
    profileSpanEnd: (entry: Record<string, unknown>): void => ipcRenderer.send("debug:profile-record", entry),
    profileMetric: (entry: Record<string, unknown>): void => ipcRenderer.send("debug:profile-record", entry),
    profileRecord: (entry: Record<string, unknown>): void => ipcRenderer.send("debug:profile-record", entry)
  },
  controller: {
    onBgBpCombo: (callback: () => void): (() => void) => {
      const listener = () => callback();
      ipcRenderer.on("controller:bg-bp-combo", listener);
      return () => ipcRenderer.removeListener("controller:bg-bp-combo", listener);
    }
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
    maximize: (): Promise<void> => ipcRenderer.invoke("window:maximize"),
    close: (): Promise<void> => ipcRenderer.invoke("window:close"),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:isMaximized"),
    onMaximizeChanged: (callback: (isMaximized: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: boolean) => callback(value);
      ipcRenderer.on("window:maximizeChanged", listener);
      return () => ipcRenderer.removeListener("window:maximizeChanged", listener);
    },
    setFullScreen: (fullscreen: boolean): Promise<void> => ipcRenderer.invoke("window:setFullScreen", fullscreen),
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke("window:isFullScreen"),
    focusBigPicture: (): Promise<void> => ipcRenderer.invoke("window:focusBigPicture"),
    onFullScreenChanged: (callback: (isFullScreen: boolean) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: boolean) => callback(value);
      ipcRenderer.on("window:fullScreenChanged", listener);
      return () => ipcRenderer.removeListener("window:fullScreenChanged", listener);
    }
  }
};

contextBridge.exposeInMainWorld("hynite", api);

export type HyniteApi = typeof api;
