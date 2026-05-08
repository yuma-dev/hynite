import { app, BrowserWindow, clipboard, ipcMain, net, shell } from "electron";
import { join } from "node:path";
import { CURRENT_METADATA_VERSION, HyniteRepository } from "@hynite/db";
import { discoverInstalledSteamApps, SteamImporterProvider } from "@hynite/importers";
import { makeGameId, type Game, type GameMetadataPatch, type ImportedGame, type LibraryQuery, type ProviderId, type SourceImportInput, type SteamSearchResult, type SyncResult } from "@hynite/core";
import { fetchSteamMetadata, metadataFromSteamAppInfo, refreshFusedMetadata } from "@hynite/metadata";
import { DiagnosticLogService } from "./diagnosticLogService";
import { HomeService } from "./homeService";
import { NativeBridge } from "./nativeBridge";
import { SettingsService } from "./settingsService";
import { SourceService } from "./sourceService";
import { searchSteamStore } from "./steamSearchService";
import { SyncStatusService } from "./syncStatusService";
import { pairSteamAccount } from "./steamAuthService";

let mainWindow: Electron.BrowserWindow | undefined;
let repository: HyniteRepository;
let settingsService: SettingsService;
let homeService: HomeService;
let sourceService: SourceService;
let nativeBridge: NativeBridge;
let syncStatusService: SyncStatusService;
let diagnosticLogService: DiagnosticLogService;

const windowIconPath = join(__dirname, "../../assets/icons/app.ico");
const METADATA_REFRESH_CONCURRENCY = 4;
const RICH_METADATA_CONCURRENCY = 1;
const RICH_METADATA_STARTUP_LIMIT = Number.POSITIVE_INFINITY;
const STARTUP_BACKGROUND_DELAY_MS = 1_000;
const richMetadataQueued = new Set<string>();
const richMetadataQueue: string[] = [];
const richMetadataInFlight = new Set<string>();
let richMetadataRunning = 0;
let richMetadataBackfillTotal = 0;
let richMetadataBackfillDone = 0;
let activeSteamSync:
  | {
      controller: AbortController;
      promise: Promise<SyncResult>;
    }
  | undefined;
let steamSyncStartLock = Promise.resolve();

class SteamSyncCancelledError extends Error {
  constructor(message = "Steam sync cancelled") {
    super(message);
    this.name = "SteamSyncCancelledError";
  }
}

function isSteamSyncCancelledError(error: unknown): error is SteamSyncCancelledError {
  return error instanceof SteamSyncCancelledError || (error instanceof Error && error.name === "AbortError");
}

function throwIfSteamSyncCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SteamSyncCancelledError(typeof signal.reason === "string" ? signal.reason : "Steam sync cancelled");
  }
}

async function cancelActiveSteamSync(reason = "Steam sync cancelled"): Promise<void> {
  const active = activeSteamSync;
  if (!active) {
    return;
  }

  active.controller.abort(reason);
  await active.promise.catch(() => undefined);
}

async function withSteamSyncStartLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = steamSyncStartLock;
  let release: () => void = () => undefined;
  steamSyncStartLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
}

function hasReusableMetadata(game: { id: string; metadataStatus: string }): boolean {
  return game.metadataStatus !== "none" && repository.getMetadataVersion(game.id) >= CURRENT_METADATA_VERSION;
}

async function fetchNativeSteamAppInfoMetadata(game: ImportedGame) {
  const appInfo = await nativeBridge.getSteamAppInfo(game.externalId);
  return metadataFromSteamAppInfo(
    game.externalId,
    appInfo
      ? {
          name: appInfo.name,
          type: appInfo.type,
          parent: appInfo.parent,
          clienticon: appInfo.clienticon,
          icon: appInfo.icon,
          steamReleaseDate: appInfo.steamReleaseDate,
          headerImage: appInfo.headerImage,
          smallCapsule: appInfo.smallCapsule,
          associations: appInfo.associations,
          libraryAssetsFull: appInfo.libraryAssetsFull,
          libraryAssets: appInfo.libraryAssets,
          extended: appInfo.extended
        }
      : undefined,
    undefined,
    game.title
  );
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await mapper(items[currentIndex] as T, currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

function steamImportedGameFromGame(game: Game): ImportedGame | undefined {
  const steamSource = game.sourceIds.find((source) => source.provider === "steam");
  if (!steamSource) {
    return undefined;
  }

  return {
    provider: "steam",
    externalId: steamSource.externalId,
    title: game.title,
    installState: game.installState,
    installDirectory: game.installDirectory,
    executablePath: game.executablePath,
    playtimeMinutes: game.playtimeMinutes,
    lastPlayedAt: game.lastPlayedAt,
    addedAt: game.addedAt,
    communityIconUrl: game.communityIconUrl
  };
}

function hasRichDetailMetadata(game: Game): boolean {
  return Boolean(game.shortDescription || game.aboutText || game.screenshots.length || game.trailerUrl);
}

async function hydrateRichDetailMetadata(game: Game): Promise<Game> {
  const imported = steamImportedGameFromGame(game);
  if (!imported || hasRichDetailMetadata(game)) {
    return game;
  }

  try {
    syncStatusService.log("info", "metadata:detail", `Fetching detail metadata for ${game.title}`, { appid: imported.externalId });
    const metadata = await fetchSteamMetadata(imported.externalId, fetch, (entry) => {
      diagnosticLogService.log({
        level: entry.level,
        phase: `metadata:${entry.providerId}`,
        message: `${entry.gameTitle}: ${entry.message}`,
        details: {
          appid: entry.appid,
          ...entry.details
        }
      });
    }, imported.title);
    if (metadata.metadataStatus === "failed") {
      return game;
    }

    repository.applyMetadata(game.id, metadata);
    return repository.getGame(game.id) ?? game;
  } catch (error) {
    diagnosticLogService.log({
      level: "warning",
      phase: "metadata:detail",
      message: `${game.title}: detail metadata refresh failed`,
      details: { appid: imported.externalId, error: error instanceof Error ? error.message : String(error) }
    });
    return game;
  }
}

function mergeDetailMetadata(game: Game, metadata: GameMetadataPatch): Game {
  return {
    ...game,
    ...metadata,
    id: game.id,
    sourceIds: game.sourceIds,
    installState: game.installState,
    discovery: game.discovery,
    screenshots: metadata.screenshots ?? game.screenshots,
    genres: metadata.genres ?? game.genres,
    tags: metadata.tags ?? game.tags,
    developers: metadata.developers ?? game.developers,
    publishers: metadata.publishers ?? game.publishers,
    contentDescriptors: metadata.contentDescriptors ?? game.contentDescriptors,
    metadataStatus: metadata.metadataStatus ?? game.metadataStatus
  };
}

async function hydrateDiscoveryDetailMetadata(game: Game): Promise<Game> {
  const imported = steamImportedGameFromGame(game);
  if (!imported || hasRichDetailMetadata(game)) {
    return game;
  }

  try {
    syncStatusService.backgroundProgress("metadata:detail", `Fetching detail metadata for ${game.title}`, undefined, undefined, {
      appid: imported.externalId
    });
    const metadata = await fetchSteamMetadata(imported.externalId, fetch, (entry) => {
      diagnosticLogService.log({
        level: entry.level,
        phase: `metadata:${entry.providerId}`,
        message: `${entry.gameTitle}: ${entry.message}`,
        details: {
          appid: entry.appid,
          discovery: true,
          ...entry.details
        }
      });
    }, imported.title);

    if (metadata.metadataStatus === "failed") {
      return game;
    }

    return mergeDetailMetadata(game, metadata);
  } catch (error) {
    diagnosticLogService.log({
      level: "warning",
      phase: "metadata:detail",
      message: `${game.title}: discovery detail metadata refresh failed`,
      details: { appid: imported.externalId, error: error instanceof Error ? error.message : String(error) }
    });
    return game;
  } finally {
    if (richMetadataBackfillTotal === 0) {
      syncStatusService.backgroundFinish(`Detail metadata loaded for ${game.title}`);
    }
  }
}

function prioritizeRichMetadataBackfill(games: Game[]): Game[] {
  return games
    .filter((game) => !hasRichDetailMetadata(game) && steamImportedGameFromGame(game))
    .sort((a, b) => {
      const installedDelta = Number(b.installState === "installed") - Number(a.installState === "installed");
      if (installedDelta !== 0) {
        return installedDelta;
      }

      const playedDelta = (Date.parse(b.lastPlayedAt ?? "") || 0) - (Date.parse(a.lastPlayedAt ?? "") || 0);
      if (playedDelta !== 0) {
        return playedDelta;
      }

      return (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0);
    });
}

function enqueueRichMetadata(gameOrId: Game | string, priority = false): void {
  const id = typeof gameOrId === "string" ? gameOrId : gameOrId.id;
  const game = typeof gameOrId === "string" ? repository.getGame(gameOrId) : gameOrId;
  if (!game || hasRichDetailMetadata(game) || !steamImportedGameFromGame(game) || richMetadataQueued.has(id) || richMetadataInFlight.has(id)) {
    return;
  }

  richMetadataQueued.add(id);
  if (priority) {
    richMetadataQueue.unshift(id);
  } else {
    richMetadataQueue.push(id);
  }

  richMetadataBackfillTotal += 1;
  void processRichMetadataQueue();
}

function finishRichMetadataQueueIfIdle(): void {
  if (richMetadataQueued.size > 0 || richMetadataRunning > 0 || richMetadataBackfillTotal === 0) {
    return;
  }

  syncStatusService.backgroundFinish(`Detail metadata complete: ${richMetadataBackfillDone}/${richMetadataBackfillTotal} games`);
  richMetadataBackfillTotal = 0;
  richMetadataBackfillDone = 0;
}

function enqueueRichMetadataBackfill(limit = RICH_METADATA_STARTUP_LIMIT): void {
  for (const game of prioritizeRichMetadataBackfill(repository.listGames()).slice(0, limit)) {
    enqueueRichMetadata(game);
  }
}

function clearRichMetadataQueue(message?: string): void {
  richMetadataQueued.clear();
  richMetadataQueue.length = 0;
  if (message) {
    syncStatusService.backgroundFinish(message);
  }
  richMetadataBackfillTotal = 0;
  richMetadataBackfillDone = 0;
}

async function processRichMetadataQueue(): Promise<void> {
  while (richMetadataRunning < RICH_METADATA_CONCURRENCY && richMetadataQueued.size > 0) {
    const id = richMetadataQueue.shift();
    if (!id) {
      return;
    }

    if (!richMetadataQueued.has(id)) {
      continue;
    }

    richMetadataQueued.delete(id);
    richMetadataInFlight.add(id);
    richMetadataRunning += 1;
    void refreshRichMetadata(id).finally(() => {
      richMetadataInFlight.delete(id);
      richMetadataRunning -= 1;
      richMetadataBackfillDone += 1;
      finishRichMetadataQueueIfIdle();
      void processRichMetadataQueue();
    });
  }
}

async function refreshRichMetadata(id: string): Promise<void> {
  const game = repository.getGame(id);
  if (!game || hasRichDetailMetadata(game)) {
    return;
  }

  const imported = steamImportedGameFromGame(game);
  syncStatusService.backgroundProgress(
    "metadata:detail",
    `Fetching detail metadata for ${game.title}`,
    Math.min(richMetadataBackfillTotal, richMetadataBackfillDone + richMetadataRunning),
    richMetadataBackfillTotal,
    imported ? { appid: imported.externalId } : undefined
  );
  const refreshed = await hydrateRichDetailMetadata(game);
  if (refreshed !== game && hasRichDetailMetadata(refreshed)) {
    mainWindow?.webContents.send("games:updated", { ...refreshed, sourceMatches: sourceService.search(refreshed.id) });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#0a0b0d",
    icon: windowIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.focus();
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximizeChanged", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximizeChanged", false));

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`);
  });
}

function runAfterInitialRendererPaint(task: () => void): void {
  const window = mainWindow;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) {
      return;
    }

    scheduled = true;
    setTimeout(task, STARTUP_BACKGROUND_DELAY_MS);
  };

  if (!window) {
    schedule();
    return;
  }

  if (!window.webContents.isLoading()) {
    schedule();
    return;
  }

  window.webContents.once("did-finish-load", schedule);
  window.webContents.once("did-fail-load", schedule);
  setTimeout(schedule, STARTUP_BACKGROUND_DELAY_MS * 4);
}

async function startSteamSync(providerId?: ProviderId, options: { refreshStaleMetadata?: boolean } = {}): Promise<SyncResult> {
  if (providerId && providerId !== "steam") {
    throw new Error(`Provider ${providerId} is not implemented yet.`);
  }

  const started = await withSteamSyncStartLock(async () => {
    await cancelActiveSteamSync("Steam sync replaced by a newer request");
    const controller = new AbortController();
    const promise = syncSteamLibrary(providerId, { ...options, signal: controller.signal }).finally(() => {
      if (activeSteamSync?.promise === promise) {
        activeSteamSync = undefined;
      }
    });
    activeSteamSync = { controller, promise };
    return { promise };
  });
  return started.promise;
}

async function syncSteamLibrary(providerId?: ProviderId, options: { refreshStaleMetadata?: boolean; signal?: AbortSignal } = {}) {
  throwIfSteamSyncCancelled(options.signal);
  const settings = await settingsService.get();
  throwIfSteamSyncCancelled(options.signal);
  const webApiKey = settings.steamAccount?.webApiKey ? await nativeBridge.decryptSecret(settings.steamAccount.webApiKey) : undefined;
  throwIfSteamSyncCancelled(options.signal);
  const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
  const provider = new SteamImporterProvider({
    account:
      settings.steamAccount && webApiKey
        ? {
            steamId: settings.steamAccount.steamId,
            webApiKey
          }
        : undefined,
    includePlayedFreeGames: true,
    steamGridDbApiKey,
    steamAppInfoProvider: fetchNativeSteamAppInfoMetadata,
    metadataMode: "fast",
    signal: options.signal,
    metadataLogger: (entry) => {
      diagnosticLogService.log({
        level: entry.level,
        phase: `metadata:${entry.providerId}`,
        message: `${entry.gameTitle}: ${entry.message}`,
        details: {
          appid: entry.appid,
          ...entry.details
        }
      });
      syncStatusService.log(entry.level, `metadata:${entry.providerId}`, `${entry.gameTitle}: ${entry.message}`, entry.details);
      if (entry.level === "warning") {
        console.warn(entry.message, entry.details);
      }
    }
  });
  if (providerId && providerId !== "steam") {
    throw new Error(`Provider ${providerId} is not implemented yet.`);
  }

  syncStatusService.start("steam");
  const refreshStaleMetadata = options.refreshStaleMetadata ?? true;
  let imported;
  try {
    syncStatusService.progress("steam:owned-games", "Calling Steam owned games API");
    imported = await provider.scan();
    throwIfSteamSyncCancelled(options.signal);
  } catch (error) {
    if (isSteamSyncCancelledError(error)) {
      syncStatusService.cancel(error.message);
      throw error;
    }
    syncStatusService.fail("Steam sync failed while loading owned games", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  try {
    syncStatusService.progress("steam:local-installs", "Reading local Steam install manifests", 0, imported.length);
    const installedApps = await discoverInstalledSteamApps().catch((error: unknown) => {
      syncStatusService.log("warning", "steam:local-installs", "Could not read local Steam install manifests", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Map();
    });
    throwIfSteamSyncCancelled(options.signal);

    let upserted = 0;
    const warnings: string[] = [];
    const metadataTargets: Array<{ id: string; game: ImportedGame }> = [];

    for (const [index, game] of imported.entries()) {
      throwIfSteamSyncCancelled(options.signal);
      const installed = installedApps.get(game.externalId);
      const gameWithInstallState = {
        ...game,
        installState: installed ? ("installed" as const) : game.installState,
        installDirectory: installed?.installDirectory ?? game.installDirectory
      };
      syncStatusService.progress("steam:upsert", `Syncing ${game.title}`, index + 1, imported.length, {
        appid: game.externalId,
        installed: Boolean(installed)
      });
      const persisted = repository.upsertImportedGame(gameWithInstallState);
      upserted += 1;
      if (hasReusableMetadata(persisted)) {
        syncStatusService.log("info", "metadata:cache", `${game.title}: metadata cache hit`, { appid: game.externalId });
        continue;
      }

      if (!refreshStaleMetadata && persisted.metadataStatus !== "none") {
        syncStatusService.log("info", "metadata:cache", `${game.title}: cached metadata version is stale; refreshing fast metadata`, {
          appid: game.externalId,
          metadataStatus: persisted.metadataStatus
        });
      }

      metadataTargets.push({ id: persisted.id, game: gameWithInstallState });
    }

    await mapWithConcurrency(metadataTargets, METADATA_REFRESH_CONCURRENCY, async (target, index) => {
      throwIfSteamSyncCancelled(options.signal);
      syncStatusService.progress("metadata:refresh", `Fetching fast metadata for ${target.game.title}`, index + 1, metadataTargets.length, {
        appid: target.game.externalId
      });
      const metadata = await provider.refreshMetadata(target.game);
      throwIfSteamSyncCancelled(options.signal);
      repository.applyMetadata(target.id, metadata);
      const enriched = repository.getGame(target.id);
      if (enriched) {
        enqueueRichMetadata(enriched);
      }
      if (metadata.metadataStatus === "failed") {
        warnings.push(`Metadata failed for ${target.game.title}`);
      }
    });

    enqueueRichMetadataBackfill();
    throwIfSteamSyncCancelled(options.signal);
    syncStatusService.finish(`Steam sync complete: ${upserted} games, ${installedApps.size} local installs`);
    return { providerId: "steam" as const, scanned: imported.length, upserted, warnings };
  } catch (error) {
    if (isSteamSyncCancelledError(error)) {
      syncStatusService.cancel(error.message);
      throw error;
    }
    syncStatusService.fail("Steam sync failed", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function registerIpc(): void {
  ipcMain.handle("library:sync", async (_event, providerId?: ProviderId) => {
    return startSteamSync(providerId, { refreshStaleMetadata: true });
  });

  ipcMain.handle("library:list", (_event, query: LibraryQuery = {}) =>
    repository.queryGames(query.search, query.installState ?? "all", query.sort ?? "title", query.sortDirection)
  );
  ipcMain.handle("library:clear", async () => {
    await withSteamSyncStartLock(() => cancelActiveSteamSync("Steam sync cancelled before clearing the library"));
    clearRichMetadataQueue("Detail metadata cancelled before clearing the library");
    const cleared = repository.clearLibrary();
    await homeService.clearCache();
    return { cleared };
  });

  ipcMain.handle("games:get", (_event, id: string) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    enqueueRichMetadata(game, true);
    return { ...game, sourceMatches: sourceService.search(id) };
  });

  ipcMain.handle("games:hydrateDiscovery", async (_event, game: Game) => {
    const hydrated = await hydrateDiscoveryDetailMetadata(game);
    return { ...hydrated, sourceMatches: sourceService.searchTitle(hydrated.title) };
  });

  ipcMain.handle("games:launch", async (_event, id: string) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    const steamSource = game.sourceIds.find((source) => source.provider === "steam");
    const command = repository.getLaunchCommand(id);
    return nativeBridge.launchGame({
      gameId: id,
      provider: steamSource?.provider ?? "manual",
      externalId: steamSource?.externalId ?? id,
      command,
      executablePath: game.executablePath,
      workingDirectory: game.installDirectory
    });
  });

  ipcMain.handle("home:get", async () => {
    const settings = await settingsService.get();
    const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
    return homeService.get(repository.listGames(), { steamGridDbApiKey, steamAppInfoProvider: fetchNativeSteamAppInfoMetadata });
  });
  ipcMain.handle("sync:status", () => syncStatusService.get());
  ipcMain.handle("sources:import", (_event, input: SourceImportInput) => sourceService.import(input));
  ipcMain.handle("sources:list", () => sourceService.list());
  ipcMain.handle("sources:remove", (_event, id: string) => sourceService.remove(id));
  ipcMain.handle("sources:refreshSource", (_event, id: string, json: string) => sourceService.refreshSource(id, json));
  ipcMain.handle("sources:search", (_event, gameId: string) => sourceService.search(gameId));
  ipcMain.handle("sources:searchTitle", (_event, title: string, options) => sourceService.searchTitle(title, options));
  ipcMain.handle("sources:exactTitleMatches", (_event, title: string) => sourceService.exactTitleMatches(title));
  ipcMain.handle("clipboard:copy", (_event, text: string) => clipboard.writeText(text));
  ipcMain.handle("settings:get", () => settingsService.get());
  ipcMain.handle("settings:update", (_event, patch) => settingsService.update(patch));
  ipcMain.handle("steam:pair", async () => {
    const paired = await pairSteamAccount(mainWindow);
    const current = await settingsService.get();
    await settingsService.update({
      steamAccount: {
        ...current.steamAccount,
        steamId: paired.steamId,
        pairedAt: paired.pairedAt
      }
    });
    return paired;
  });
  ipcMain.handle("steam:saveApiKey", async (_event, apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Steam Web API key is required.");
    }

    const current = await settingsService.get();
    if (!current.steamAccount) {
      throw new Error("Pair a Steam account before saving a Web API key.");
    }

    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({
      steamAccount: {
        ...current.steamAccount,
        webApiKey: encrypted
      }
    });
  });
  ipcMain.handle("steam:disconnect", async () => settingsService.update({ steamAccount: undefined }));
  ipcMain.handle("steam:search", async (_event, query: string): Promise<SteamSearchResult[]> => {
    return searchSteamStore(query, net.fetch);
  });
  ipcMain.handle("metadata:saveSteamGridDbKey", async (_event, apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("SteamGridDB API key is required.");
    }

    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({ steamGridDbApiKey: encrypted });
  });
  ipcMain.handle("metadata:clearSteamGridDbKey", async () => settingsService.update({ steamGridDbApiKey: undefined }));
  ipcMain.handle("native:openExternal", (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only web links can be opened externally.");
    }

    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle("native:openFolder", (_event, path: string) => shell.openPath(path));
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle("debug:seed", () => {
    const seeded = repository.upsertImportedGame({
      provider: "steam",
      externalId: "1086940",
      title: "Baldur's Gate 3",
      installState: "installed",
      launchCommand: "steam://rungameid/1086940",
      playtimeMinutes: 4200,
      lastPlayedAt: new Date().toISOString()
    });
    repository.applyMetadata(makeGameId("steam", "1086940"), {
      coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1086940/library_600x900.jpg",
      backgroundUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1086940/library_hero.jpg",
      genres: ["RPG", "Adventure", "Strategy"],
      tags: ["Choices Matter", "Story Rich", "Co-op"],
      developers: ["Larian Studios"],
      publishers: ["Larian Studios"],
      releaseDate: "2023-08-03",
      metadataStatus: "complete"
    });
    return seeded;
  });
}

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  repository = new HyniteRepository(join(userData, "hynite.db"));
  settingsService = new SettingsService(join(userData, "settings.json"));
  diagnosticLogService = new DiagnosticLogService(join(userData, "metadata-diagnostics.ndjson"));
  homeService = new HomeService(join(userData, "home-cache.json"), diagnosticLogService);
  sourceService = new SourceService(repository);
  nativeBridge = new NativeBridge();
  syncStatusService = new SyncStatusService(() => mainWindow, join(userData, "sync-status.json"));
  registerIpc();
  createWindow();
  void settingsService.get().then((settings) => {
    runAfterInitialRendererPaint(() => {
      if (settings.steamAccount?.webApiKey) {
        void startSteamSync("steam", { refreshStaleMetadata: false }).catch((error: unknown) => {
          if (isSteamSyncCancelledError(error)) {
            return;
          }
          console.warn("Startup Steam sync failed", error);
        }).finally(() => {
          enqueueRichMetadataBackfill();
        });
        return;
      }

      enqueueRichMetadataBackfill();
    });
  });
});

app.on("window-all-closed", () => {
  syncStatusService?.flush();
  repository?.close();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
