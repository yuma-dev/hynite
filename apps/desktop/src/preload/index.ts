import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  DownloadSourceInfo,
  Game,
  GameDetail,
  HomeModel,
  LaunchSession,
  LibraryQuery,
  ProviderId,
  SourceExactMatch,
  SourceImportInput,
  SourceImportResult,
  SourceMatch,
  SourceSearchOptions,
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
  library: {
    sync: (providerId?: ProviderId): Promise<SyncResult> => ipcRenderer.invoke("library:sync", providerId),
    list: (query: LibraryQuery): Promise<Game[]> => ipcRenderer.invoke("library:list", query),
    clear: (): Promise<{ cleared: number }> => ipcRenderer.invoke("library:clear")
  },
  games: {
    get: (id: string): Promise<GameDetail> => ipcRenderer.invoke("games:get", id),
    hydrateDiscovery: (game: Game): Promise<GameDetail> => ipcRenderer.invoke("games:hydrateDiscovery", game),
    launch: (id: string, preferredSteamId?: string): Promise<LaunchOutcome> =>
      ipcRenderer.invoke("games:launch", id, preferredSteamId),
    onUpdated: (callback: (game: GameDetail) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, game: GameDetail) => callback(game);
      ipcRenderer.on("games:updated", listener);
      return () => ipcRenderer.removeListener("games:updated", listener);
    }
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
    search: (gameId: string): Promise<SourceMatch[]> => ipcRenderer.invoke("sources:search", gameId),
    searchTitle: (title: string, options?: SourceSearchOptions): Promise<SourceMatch[]> => ipcRenderer.invoke("sources:searchTitle", title, options),
    exactTitleMatches: (title: string): Promise<SourceExactMatch[]> => ipcRenderer.invoke("sources:exactTitleMatches", title)
  },
  clipboard: {
    copy: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:copy", text)
  },
  native: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("native:openExternal", url)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke("settings:update", patch)
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
    clearSteamGridDbKey: (): Promise<AppSettings> => ipcRenderer.invoke("metadata:clearSteamGridDbKey")
  },
  debug: {
    seed: (): Promise<Game> => ipcRenderer.invoke("debug:seed"),
    profile: (entry: { phase: string; message: string; details?: Record<string, unknown>; rendererElapsedMs?: number }): void =>
      ipcRenderer.send("debug:profile", entry)
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
    }
  }
};

contextBridge.exposeInMainWorld("hynite", api);

export type HyniteApi = typeof api;
