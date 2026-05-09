import { app, BrowserWindow, clipboard, ipcMain, net, shell } from "electron";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CURRENT_METADATA_VERSION, HyniteRepository } from "@hynite/db";
import { discoverInstalledSteamApps, readLoginUsers, SteamImporterProvider } from "@hynite/importers";
import { makeGameId, type AppSettings, type EncryptedSecret, type Game, type GameMetadataPatch, type ImportedGame, type LaunchSession, type LibraryQuery, type ProviderId, type SourceImportInput, type SteamAccountSettings, type SteamLocalAccount, type SteamSearchResult, type SyncResult } from "@hynite/core";
import { getActiveSteamUser, switchSteamAccount } from "./steamSwitchService";
import { fetchSteamMetadata, metadataFromSteamAppInfo, refreshFusedMetadata } from "@hynite/metadata";
import { DiagnosticLogService } from "./diagnosticLogService";
import { HomeService } from "./homeService";
import { NativeBridge } from "./nativeBridge";
import { SettingsService } from "./settingsService";
import { SourceService } from "./sourceService";
import { searchSteamStore } from "./steamSearchService";
import { StartupProfileService } from "./startupProfileService";
import { SyncStatusService } from "./syncStatusService";
import {
  authenticateSteamSession,
  disconnectSteamFamilySession,
  pairSteamAccount,
  refreshSteamAccessToken
} from "./steamAuthService";

let mainWindow: Electron.BrowserWindow | undefined;
let repository: HyniteRepository;
let settingsService: SettingsService;
let homeService: HomeService;
let sourceService: SourceService;
let nativeBridge: NativeBridge;
let syncStatusService: SyncStatusService;
let diagnosticLogService: DiagnosticLogService;
let startupProfileService: StartupProfileService | undefined;
let startupHeartbeatTimer: NodeJS.Timeout | undefined;

const windowIconPath = join(__dirname, "../../assets/icons/app.ico");
const METADATA_REFRESH_CONCURRENCY = 4;
const RICH_METADATA_CONCURRENCY = 1;
const RICH_METADATA_STARTUP_LIMIT = Number.POSITIVE_INFINITY;
const STARTUP_BACKGROUND_DELAY_MS = 1_000;
const STEAM_SYNC_UPSERT_YIELD_INTERVAL = 25;
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

function profile(phase: string, message: string, details?: Record<string, unknown>): void {
  startupProfileService?.log({ scope: "main", phase, message, details });
}

function roundDuration(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function profileIpc<T>(channel: string, task: () => T | Promise<T>): T | Promise<T> {
  const startedAt = performance.now();
  profile("ipc:start", channel);

  try {
    const result = task();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>)
        .then((value) => {
          profile("ipc:end", channel, { durationMs: roundDuration(startedAt) });
          return value;
        })
        .catch((error: unknown) => {
          profile("ipc:error", channel, {
            durationMs: roundDuration(startedAt),
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        });
    }

    profile("ipc:end", channel, { durationMs: roundDuration(startedAt) });
    return result;
  } catch (error) {
    profile("ipc:error", channel, {
      durationMs: roundDuration(startedAt),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function handleIpc(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => profileIpc(channel, () => listener(event, ...args)));
}

function startStartupHeartbeat(): void {
  if (!startupProfileService?.enabled || startupHeartbeatTimer) {
    return;
  }

  let lastBeatAt = performance.now();
  startupHeartbeatTimer = setInterval(() => {
    const now = performance.now();
    const driftMs = Math.round((now - lastBeatAt - 1_000) * 10) / 10;
    lastBeatAt = now;
    if (driftMs > 250) {
      profile("main:heartbeat:lag", "Main event loop delayed", { driftMs });
    }
  }, 1_000);
  startupHeartbeatTimer.unref?.();
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

const FAMILY_TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

async function resolveFamilyAccessTokenForAccount(account: SteamAccountSettings): Promise<string | undefined> {
  const session = account.familySession;
  if (!session) {
    return undefined;
  }

  const expiresAt = Date.parse(session.expiresAt);
  const isExpiringSoon = !Number.isFinite(expiresAt) || expiresAt - Date.now() < FAMILY_TOKEN_REFRESH_THRESHOLD_MS;

  if (!isExpiringSoon) {
    try {
      return await nativeBridge.decryptSecret(session.accessToken);
    } catch (error) {
      console.warn("Failed to decrypt Steam family access token", error);
    }
  }

  try {
    const refreshed = await refreshSteamAccessToken();
    if (refreshed && refreshed.steamId === account.steamId) {
      const encrypted = await nativeBridge.encryptSecret({ value: refreshed.accessToken, scope: "current-user" });
      await settingsService.patchSteamAccount(account.steamId, {
        familySession: {
          accessToken: encrypted,
          steamId: refreshed.steamId,
          expiresAt: refreshed.expiresAt,
          connectedAt: session.connectedAt
        }
      });
      return refreshed.accessToken;
    }
  } catch (error) {
    console.warn("Steam family access token refresh failed", error);
  }

  if (!isExpiringSoon) {
    return undefined;
  }

  try {
    return await nativeBridge.decryptSecret(session.accessToken);
  } catch {
    return undefined;
  }
}

function hasReusableMetadata(game: { metadataStatus: string; metadataVersion?: number; id?: string }): boolean {
  return game.metadataStatus !== "none" && (game.metadataVersion ?? (game.id ? repository.getMetadataVersion(game.id) : 0)) >= CURRENT_METADATA_VERSION;
}

function saveSteamRawMetadata(gameId: string, externalId: string, source: string, raw: unknown): void {
  try {
    repository.saveRawGameMetadata({
      gameId,
      provider: "steam",
      externalId,
      source,
      raw
    });
  } catch (error) {
    diagnosticLogService?.log({
      level: "warning",
      phase: "metadata:raw",
      message: `Raw Steam metadata cache write failed for ${externalId}`,
      details: { source, error: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function fetchNativeSteamAppInfoMetadata(game: ImportedGame) {
  const appInfo = await nativeBridge.getSteamAppInfo(game.externalId);
  if (appInfo) {
    saveSteamRawMetadata(makeGameId(game.provider, game.externalId), game.externalId, "steam_appinfo", appInfo.raw ?? appInfo);
  }
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
    }, imported.title, (raw) => saveSteamRawMetadata(game.id, imported.externalId, "steam_appdetails", raw));
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
  profile("window:create:start", "Creating BrowserWindow");
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
  profile("window:create:end", "BrowserWindow created");

  if (process.env.ELECTRON_RENDERER_URL) {
    profile("window:load:start", "Loading renderer URL", { url: process.env.ELECTRON_RENDERER_URL });
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    profile("window:load:start", "Loading renderer file");
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    profile("window:ready-to-show", "Renderer ready to show");
    mainWindow?.focus();
  });

  mainWindow.webContents.on("dom-ready", () => {
    profile("renderer:dom-ready", "Renderer DOM ready");
  });
  mainWindow.webContents.on("did-finish-load", () => {
    profile("renderer:did-finish-load", "Renderer finished loading");
  });
  mainWindow.webContents.on("unresponsive", () => {
    profile("renderer:unresponsive", "Renderer became unresponsive");
  });
  mainWindow.webContents.on("responsive", () => {
    profile("renderer:responsive", "Renderer became responsive");
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    profile("renderer:process-gone", "Renderer process gone", { reason: details.reason, exitCode: details.exitCode });
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      profile("renderer:console", message, { level, line, sourceId });
    }
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximizeChanged", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximizeChanged", false));
  mainWindow.on("closed", () => {
    profile("window:closed", "BrowserWindow closed");
    mainWindow = undefined;
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    profile("window:load:failed", "Renderer failed to load", { errorCode, errorDescription });
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
    profile("startup:background:scheduled", "Startup background work scheduled", { delayMs: STARTUP_BACKGROUND_DELAY_MS });
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

  profile("steam-sync:start-requested", "Steam sync start requested", { providerId, refreshStaleMetadata: options.refreshStaleMetadata });
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
  const syncStartedAt = performance.now();
  profile("steam-sync:start", "Steam sync started", { providerId, refreshStaleMetadata: options.refreshStaleMetadata });
  throwIfSteamSyncCancelled(options.signal);
  const settings = await settingsService.get();
  throwIfSteamSyncCancelled(options.signal);
  const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;

  if (providerId && providerId !== "steam") {
    throw new Error(`Provider ${providerId} is not implemented yet.`);
  }

  const webApiKey = settings.steamWebApiKey ? await nativeBridge.decryptSecret(settings.steamWebApiKey) : undefined;
  const eligibleAccounts = webApiKey ? settings.steamAccounts : [];

  if (eligibleAccounts.length === 0) {
    syncStatusService.start("steam");
    syncStatusService.finish(
      webApiKey ? "Steam sync skipped: no paired accounts" : "Steam sync skipped: add a Steam Web API key in Settings"
    );
    return { providerId: "steam" as const, scanned: 0, upserted: 0, warnings: [] };
  }

  const buildScanLogger = (account: SteamAccountSettings) => (level: "info" | "warning" | "error", message: string, details?: Record<string, unknown>) => {
    const annotated = { ...details, account: account.personaName ?? account.steamId };
    diagnosticLogService.log({ level, phase: "steam:family", message, details: annotated });
    syncStatusService.log(level, "steam:family", message, annotated);
    if (level === "warning" || level === "error") {
      console.warn(`[steam:family] ${message}`, annotated);
    }
  };

  const buildProvider = (account: SteamAccountSettings, key: string, familyAccessToken: string | undefined) =>
    new SteamImporterProvider({
      account: { steamId: account.steamId, webApiKey: key, familyAccessToken },
      includePlayedFreeGames: true,
      steamGridDbApiKey,
      steamAppInfoProvider: fetchNativeSteamAppInfoMetadata,
      metadataMode: "fast",
      rawMetadataRecorder: (game, source, raw) =>
        saveSteamRawMetadata(makeGameId(game.provider, game.externalId), game.externalId, source, raw),
      signal: options.signal,
      scanLogger: buildScanLogger(account),
      metadataLogger: (entry) => {
        diagnosticLogService.log({
          level: entry.level,
          phase: `metadata:${entry.providerId}`,
          message: `${entry.gameTitle}: ${entry.message}`,
          details: { appid: entry.appid, ...entry.details }
        });
        syncStatusService.log(entry.level, `metadata:${entry.providerId}`, `${entry.gameTitle}: ${entry.message}`, entry.details);
        if (entry.level === "warning") {
          console.warn(entry.message, entry.details);
        }
      }
    });

  syncStatusService.start("steam");
  const refreshStaleMetadata = options.refreshStaleMetadata ?? true;

  // Scan all accounts sequentially so progress events stay coherent.
  let imported: ImportedGame[];
  let provider: SteamImporterProvider;
  try {
    const scanned: ImportedGame[] = [];
    for (const account of eligibleAccounts) {
      throwIfSteamSyncCancelled(options.signal);
      const familyAccessToken = await resolveFamilyAccessTokenForAccount(account);
      throwIfSteamSyncCancelled(options.signal);
      const accountProvider = buildProvider(account, webApiKey!, familyAccessToken);
      syncStatusService.progress(
        "steam:owned-games",
        `Calling Steam owned games API for ${account.personaName ?? account.steamId}`
      );
      const accountScan = await accountProvider.scan();
      scanned.push(...accountScan);
      profile("steam-sync:owned-games", "Steam owned games scan finished", {
        account: account.steamId,
        count: accountScan.length,
        durationMs: roundDuration(syncStartedAt)
      });
    }
    imported = scanned;
    // Metadata refresh provider — account-independent so any paired account works.
    provider = buildProvider(eligibleAccounts[0]!, webApiKey!, undefined);
    throwIfSteamSyncCancelled(options.signal);
  } catch (error) {
    if (isSteamSyncCancelledError(error)) {
      syncStatusService.cancel(error.message);
      profile("steam-sync:cancelled", "Steam sync cancelled while loading owned games", {
        durationMs: roundDuration(syncStartedAt),
        error: error.message
      });
      throw error;
    }
    syncStatusService.fail("Steam sync failed while loading owned games", { error: error instanceof Error ? error.message : String(error) });
    profile("steam-sync:error", "Steam sync failed while loading owned games", {
      durationMs: roundDuration(syncStartedAt),
      error: error instanceof Error ? error.message : String(error)
    });
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
    profile("steam-sync:local-installs", "Local Steam install scan finished", { count: installedApps.size, durationMs: roundDuration(syncStartedAt) });
    throwIfSteamSyncCancelled(options.signal);

    let upserted = 0;
    let metadataCacheHits = 0;
    let staleMetadataCount = 0;
    const warnings: string[] = [];
    const metadataTargets: Array<{ id: string; game: ImportedGame }> = [];

    const upsertStartedAt = performance.now();
    let lastYieldIndex = 0;
    while (lastYieldIndex < imported.length) {
      throwIfSteamSyncCancelled(options.signal);
      const chunkEnd = Math.min(imported.length, lastYieldIndex + STEAM_SYNC_UPSERT_YIELD_INTERVAL);
      const chunkStartedAt = performance.now();
      syncStatusService.progress(
        "steam:upsert",
        `Syncing Steam library ${chunkEnd}/${imported.length}`,
        chunkEnd,
        imported.length,
        { from: lastYieldIndex + 1, to: chunkEnd },
        { history: false }
      );
      repository.transaction(() => {
        for (let index = lastYieldIndex; index < chunkEnd; index += 1) {
          throwIfSteamSyncCancelled(options.signal);
          const game = imported[index] as ImportedGame;
          const installed = installedApps.get(game.externalId);
          const gameWithInstallState = {
            ...game,
            installState: installed ? ("installed" as const) : game.installState,
            installDirectory: installed?.installDirectory ?? game.installDirectory
          };
          const persisted = repository.upsertImportedGameSummary(gameWithInstallState);
          upserted += 1;
          if (hasReusableMetadata(persisted)) {
            metadataCacheHits += 1;
            continue;
          }

          if (!refreshStaleMetadata && persisted.metadataStatus !== "none") {
            staleMetadataCount += 1;
          }

          metadataTargets.push({ id: persisted.id, game: gameWithInstallState });
        }
      });
      const chunkDurationMs = roundDuration(chunkStartedAt);
      if (chunkDurationMs > 50) {
        profile("steam-sync:upsert-chunk", "Steam library upsert chunk finished", {
          from: lastYieldIndex + 1,
          to: chunkEnd,
          durationMs: chunkDurationMs
        });
      }
      lastYieldIndex = chunkEnd;
      await yieldToEventLoop();
    }
    profile("steam-sync:upsert", "Steam library upsert finished", {
      upserted,
      metadataCacheHits,
      staleMetadataCount,
      metadataTargets: metadataTargets.length,
      durationMs: roundDuration(upsertStartedAt),
      totalDurationMs: roundDuration(syncStartedAt)
    });
    if (metadataCacheHits > 0) {
      syncStatusService.log("info", "metadata:cache", `Metadata cache hits: ${metadataCacheHits}/${upserted}`);
    }
    if (staleMetadataCount > 0) {
      syncStatusService.log("info", "metadata:cache", `Stale metadata targets queued: ${staleMetadataCount}`);
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

    profile("steam-sync:metadata-refresh", "Steam metadata refresh finished", {
      count: metadataTargets.length,
      durationMs: roundDuration(syncStartedAt)
    });
    enqueueRichMetadataBackfill();
    throwIfSteamSyncCancelled(options.signal);
    syncStatusService.finish(`Steam sync complete: ${upserted} games, ${installedApps.size} local installs`);
    profile("steam-sync:end", "Steam sync completed", {
      scanned: imported.length,
      upserted,
      installed: installedApps.size,
      durationMs: roundDuration(syncStartedAt)
    });
    return { providerId: "steam" as const, scanned: imported.length, upserted, warnings };
  } catch (error) {
    if (isSteamSyncCancelledError(error)) {
      syncStatusService.cancel(error.message);
      profile("steam-sync:cancelled", "Steam sync cancelled", { durationMs: roundDuration(syncStartedAt), error: error.message });
      throw error;
    }
    syncStatusService.fail("Steam sync failed", { error: error instanceof Error ? error.message : String(error) });
    profile("steam-sync:error", "Steam sync failed", {
      durationMs: roundDuration(syncStartedAt),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

type LaunchResult =
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

/**
 * Decide which paired Steam account should run a game. An account is "launchable" if:
 *  - It owns the game directly (an `owned` source row whose `ownerSteamid` is the account), OR
 *  - The game is family-shared and the account is either the family owner (someone in
 *    `familyOwnerSteamIds`) or one of our paired accounts that imported the title via family share.
 * Returns the account that should be active to play the game.
 */
function resolveLaunchableAccounts(game: Game, accounts: SteamAccountSettings[]): {
  owners: SteamAccountSettings[];
  family: SteamAccountSettings[];
} {
  const accountById = new Map(accounts.map((account) => [account.steamId, account]));
  const owners: SteamAccountSettings[] = [];
  const family = new Set<SteamAccountSettings>();

  for (const source of game.sourceIds) {
    if (source.provider !== "steam") continue;
    const isFamily = source.shareType === "family";
    const importer = source.ownerSteamid ? accountById.get(source.ownerSteamid) : undefined;
    if (importer) {
      if (isFamily) family.add(importer);
      else owners.push(importer);
    }
    if (isFamily) {
      for (const ownerSteamId of source.familyOwnerSteamIds ?? []) {
        const lender = accountById.get(ownerSteamId);
        if (lender) {
          owners.push(lender); // a family lender that we have paired = direct owner.
        }
      }
    }
  }

  return { owners, family: [...family] };
}

async function resolveLaunchOrSwitch(id: string): Promise<LaunchResult> {
  const game = repository.getGame(id);
  if (!game) {
    throw new Error(`Game ${id} was not found.`);
  }

  const settings = await settingsService.get();
  const { owners, family } = resolveLaunchableAccounts(game, settings.steamAccounts);
  const launchable = [...owners, ...family];
  const hasSteamSource = game.sourceIds.some((source) => source.provider === "steam");

  // Non-Steam game, or no paired accounts at all → just launch.
  if (!hasSteamSource || settings.steamAccounts.length === 0) {
    return performLaunch(id);
  }

  const active = await getActiveSteamUser();
  const activeAccount = active.steamId ? settings.steamAccounts.find((account) => account.steamId === active.steamId) : undefined;
  const activeIsLaunchable = activeAccount ? launchable.some((account) => account.steamId === activeAccount.steamId) : false;

  if (activeIsLaunchable) {
    return performLaunch(id);
  }

  // Pick a target — owners first, then family-borrower viewers; require a mapped local username.
  const target = [...owners, ...family].find((account) => Boolean(account.localUsername));
  if (!target) {
    return performLaunch(id); // no usable target → fall back to plain launch
  }

  return {
    kind: "requires-switch",
    gameId: id,
    gameTitle: game.title,
    currentAccountName: active.accountName,
    currentSteamId: active.steamId,
    target: {
      steamId: target.steamId,
      accountName: target.localUsername!,
      personaName: target.personaName
    }
  };
}

async function performLaunch(id: string): Promise<{ kind: "launched" } & LaunchSession> {
  const game = repository.getGame(id);
  if (!game) {
    throw new Error(`Game ${id} was not found.`);
  }
  const steamSource = game.sourceIds.find((source) => source.provider === "steam");
  const command = repository.getLaunchCommand(id);
  const session = await nativeBridge.launchGame({
    gameId: id,
    provider: steamSource?.provider ?? "manual",
    externalId: steamSource?.externalId ?? id,
    command,
    executablePath: game.executablePath,
    workingDirectory: game.installDirectory
  });
  return { kind: "launched", ...session };
}

function registerIpc(): void {
  ipcMain.on("debug:profile", (_event, entry: { phase?: unknown; message?: unknown; details?: unknown; rendererElapsedMs?: unknown }) => {
    startupProfileService?.log({
      scope: "renderer",
      phase: typeof entry?.phase === "string" ? entry.phase : "renderer",
      message: typeof entry?.message === "string" ? entry.message : "Renderer profile event",
      details: entry?.details && typeof entry.details === "object" ? (entry.details as Record<string, unknown>) : undefined,
      rendererElapsedMs: typeof entry?.rendererElapsedMs === "number" ? entry.rendererElapsedMs : undefined
    });
  });

  handleIpc("library:sync", async (_event, providerId?: ProviderId) => {
    return startSteamSync(providerId, { refreshStaleMetadata: true });
  });

  handleIpc("library:list", (_event, query: LibraryQuery = {}) => repository.queryGames(query));
  handleIpc("library:clear", async () => {
    await withSteamSyncStartLock(() => cancelActiveSteamSync("Steam sync cancelled before clearing the library"));
    clearRichMetadataQueue("Detail metadata cancelled before clearing the library");
    const cleared = repository.clearLibrary();
    await homeService.clearCache();
    return { cleared };
  });

  handleIpc("games:get", (_event, id: string) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    enqueueRichMetadata(game, true);
    return { ...game, sourceMatches: sourceService.search(id) };
  });

  handleIpc("games:hydrateDiscovery", async (_event, game: Game) => {
    const hydrated = await hydrateDiscoveryDetailMetadata(game);
    return { ...hydrated, sourceMatches: sourceService.searchTitle(hydrated.title) };
  });

  handleIpc("games:launch", async (_event, id: string) => resolveLaunchOrSwitch(id));
  handleIpc("steam:switchAndLaunch", async (_event, id: string, targetSteamId: string) => {
    const settings = await settingsService.get();
    const target = settings.steamAccounts.find((account) => account.steamId === targetSteamId);
    if (!target) {
      throw new Error(`Paired Steam account ${targetSteamId} not found.`);
    }
    if (!target.localUsername) {
      throw new Error("Map a local Steam username to this account before switching.");
    }
    await switchSteamAccount({ steamId: target.steamId, accountName: target.localUsername });
    return performLaunch(id);
  });
  handleIpc("steam:listLocalAccounts", async () => {
    const { accounts } = await readLoginUsers();
    return accounts;
  });
  handleIpc("steam:getActiveUser", () => getActiveSteamUser());
  handleIpc("steam:setAccountLocalUsername", async (_event, steamId: string, localUsername: string | undefined) => {
    const trimmed = localUsername?.trim();
    return settingsService.patchSteamAccount(steamId, { localUsername: trimmed ? trimmed : undefined });
  });
  handleIpc("steam:removeAccount", async (_event, steamId: string) => settingsService.removeSteamAccount(steamId));

  handleIpc("home:get", async () => {
    const settings = await settingsService.get();
    const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
    return homeService.get(repository.listGames(), { steamGridDbApiKey, steamAppInfoProvider: fetchNativeSteamAppInfoMetadata });
  });
  handleIpc("sync:status", () => syncStatusService.get());
  handleIpc("sources:import", (_event, input: SourceImportInput) => sourceService.import(input));
  handleIpc("sources:list", () => sourceService.list());
  handleIpc("sources:remove", (_event, id: string) => sourceService.remove(id));
  handleIpc("sources:refreshSource", (_event, id: string, json: string) => sourceService.refreshSource(id, json));
  handleIpc("sources:search", (_event, gameId: string) => sourceService.search(gameId));
  handleIpc("sources:searchTitle", (_event, title: string, options) => sourceService.searchTitle(title, options));
  handleIpc("sources:exactTitleMatches", (_event, title: string) => sourceService.exactTitleMatches(title));
  handleIpc("clipboard:copy", (_event, text: string) => clipboard.writeText(text));
  handleIpc("settings:get", () => settingsService.get());
  handleIpc("settings:update", (_event, patch) => settingsService.update(patch));
  handleIpc("steam:pair", async () => {
    const paired = await pairSteamAccount(mainWindow);
    const current = await settingsService.get();
    const existing = current.steamAccounts.find((account) => account.steamId === paired.steamId);

    // Best-effort auto-map to a local Steam user — when the SteamID matches a row in
    // loginusers.vdf the user never has to choose anything by hand.
    let autoLocalUsername: string | undefined;
    let autoPersonaName: string | undefined;
    try {
      const { accounts } = await readLoginUsers();
      const match = accounts.find((account) => account.steamId === paired.steamId);
      if (match) {
        autoLocalUsername = match.accountName;
        autoPersonaName = match.personaName;
      }
    } catch (error) {
      console.warn("Could not auto-detect local Steam user", error);
    }

    await settingsService.upsertSteamAccount({
      ...(existing ?? {}),
      steamId: paired.steamId,
      pairedAt: paired.pairedAt,
      personaName: existing?.personaName ?? autoPersonaName,
      localUsername: existing?.localUsername ?? autoLocalUsername
    });
    return paired;
  });
  handleIpc("steam:saveApiKey", async (_event, apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Steam Web API key is required.");
    }
    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({ steamWebApiKey: encrypted });
  });
  handleIpc("steam:clearApiKey", async () => settingsService.update({ steamWebApiKey: undefined }));
  handleIpc("steam:disconnect", async (_event, steamId?: string) => {
    if (steamId) {
      return settingsService.removeSteamAccount(steamId);
    }
    return settingsService.update({ steamAccounts: [] });
  });
  handleIpc("steam:connectFamily", async (_event, steamId: string) => {
    const current = await settingsService.get();
    if (!current.steamAccounts.some((account) => account.steamId === steamId)) {
      throw new Error("Pair the Steam account before connecting the family library.");
    }
    const result = await authenticateSteamSession(mainWindow);
    if (result.steamId !== steamId) {
      throw new Error(
        `The Steam session you logged in as (${result.steamId}) doesn't match the paired account (${steamId}).`
      );
    }
    const encrypted = await nativeBridge.encryptSecret({ value: result.accessToken, scope: "current-user" });
    return settingsService.patchSteamAccount(steamId, {
      familySession: {
        accessToken: encrypted,
        steamId: result.steamId,
        expiresAt: result.expiresAt,
        connectedAt: new Date().toISOString()
      }
    });
  });
  handleIpc("steam:refreshFamily", async (_event, steamId: string) => {
    const current = await settingsService.get();
    const target = current.steamAccounts.find((account) => account.steamId === steamId);
    if (!target?.familySession) {
      throw new Error("Family library is not connected for this account.");
    }
    const refreshed = await refreshSteamAccessToken();
    if (!refreshed) {
      throw new Error("Steam family session expired; reconnect to continue.");
    }
    const encrypted = await nativeBridge.encryptSecret({ value: refreshed.accessToken, scope: "current-user" });
    return settingsService.patchSteamAccount(steamId, {
      familySession: {
        accessToken: encrypted,
        steamId: refreshed.steamId,
        expiresAt: refreshed.expiresAt,
        connectedAt: target.familySession.connectedAt
      }
    });
  });
  handleIpc("steam:disconnectFamily", async (_event, steamId: string) => {
    await disconnectSteamFamilySession();
    return settingsService.patchSteamAccount(steamId, { familySession: undefined });
  });
  handleIpc("steam:search", async (_event, query: string): Promise<SteamSearchResult[]> => {
    return searchSteamStore(query, net.fetch);
  });
  handleIpc("metadata:saveSteamGridDbKey", async (_event, apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("SteamGridDB API key is required.");
    }

    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({ steamGridDbApiKey: encrypted });
  });
  handleIpc("metadata:clearSteamGridDbKey", async () => settingsService.update({ steamGridDbApiKey: undefined }));
  handleIpc("native:openExternal", (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only web links can be opened externally.");
    }

    return shell.openExternal(parsed.toString());
  });
  handleIpc("native:openFolder", (_event, path: string) => shell.openPath(path));
  handleIpc("window:minimize", () => mainWindow?.minimize());
  handleIpc("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  handleIpc("window:close", () => mainWindow?.close());
  handleIpc("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  handleIpc("debug:seed", () => {
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
  startupProfileService = new StartupProfileService(join(userData, "startup-profile.ndjson"));
  profile("app:ready", "Electron app ready", {
    userData,
    profileCommand: startupProfileService.enabled,
    versions: process.versions
  });
  startStartupHeartbeat();
  repository = new HyniteRepository(join(userData, "hynite.db"));
  profile("services:repository", "Repository opened");
  settingsService = new SettingsService(join(userData, "settings.json"));
  diagnosticLogService = new DiagnosticLogService(join(userData, "metadata-diagnostics.ndjson"));
  homeService = new HomeService(join(userData, "home-cache.json"), diagnosticLogService);
  sourceService = new SourceService(repository);
  nativeBridge = new NativeBridge();
  syncStatusService = new SyncStatusService(() => mainWindow, join(userData, "sync-status.json"));
  profile("services:ready", "Main services initialized");
  registerIpc();
  profile("ipc:registered", "IPC handlers registered");
  createWindow();
  void settingsService.get().then((settings) => {
    const canSync = Boolean(settings.steamWebApiKey) && settings.steamAccounts.length > 0;
    profile("startup:settings-loaded", "Startup settings loaded", {
      steamAccounts: settings.steamAccounts.length,
      hasSteamWebApiKey: Boolean(settings.steamWebApiKey),
      hasSteamGridDbApiKey: Boolean(settings.steamGridDbApiKey)
    });
    runAfterInitialRendererPaint(() => {
      profile("startup:background:start", "Startup background work started");
      if (canSync) {
        void startSteamSync("steam", { refreshStaleMetadata: false }).catch((error: unknown) => {
          if (isSteamSyncCancelledError(error)) {
            return;
          }
          console.warn("Startup Steam sync failed", error);
        }).finally(() => {
          profile("startup:background:rich-backfill", "Queueing rich metadata after startup Steam sync");
          enqueueRichMetadataBackfill();
        });
        return;
      }

      profile("startup:background:rich-backfill", "Queueing rich metadata without startup Steam sync");
      enqueueRichMetadataBackfill();
    });
  });
});

app.on("window-all-closed", () => {
  profile("app:window-all-closed", "All windows closed");
  if (startupHeartbeatTimer) {
    clearInterval(startupHeartbeatTimer);
    startupHeartbeatTimer = undefined;
  }
  syncStatusService?.flush();
  repository?.close();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  profile("app:activate", "Electron app activated");
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
