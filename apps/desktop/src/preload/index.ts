import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  Game,
  GameDetail,
  HomeModel,
  LaunchSession,
  LibraryQuery,
  ProviderId,
  SourceImportInput,
  SourceImportResult,
  SourceMatch,
  SyncResult
} from "@hynite/core";

const api = {
  library: {
    sync: (providerId?: ProviderId): Promise<SyncResult> => ipcRenderer.invoke("library:sync", providerId),
    list: (query: LibraryQuery): Promise<Game[]> => ipcRenderer.invoke("library:list", query)
  },
  games: {
    get: (id: string): Promise<GameDetail> => ipcRenderer.invoke("games:get", id),
    launch: (id: string): Promise<LaunchSession> => ipcRenderer.invoke("games:launch", id)
  },
  home: {
    get: (): Promise<HomeModel> => ipcRenderer.invoke("home:get")
  },
  sources: {
    import: (input: SourceImportInput): Promise<SourceImportResult> => ipcRenderer.invoke("sources:import", input),
    search: (gameId: string): Promise<SourceMatch[]> => ipcRenderer.invoke("sources:search", gameId),
    searchTitle: (title: string): Promise<SourceMatch[]> => ipcRenderer.invoke("sources:searchTitle", title)
  },
  clipboard: {
    copy: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:copy", text)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke("settings:update", patch)
  },
  debug: {
    seed: (): Promise<Game> => ipcRenderer.invoke("debug:seed")
  }
};

contextBridge.exposeInMainWorld("hynite", api);

export type HyniteApi = typeof api;
