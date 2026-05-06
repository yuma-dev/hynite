import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { join } from "node:path";
import { HyniteRepository } from "@hynite/db";
import { discoverInstalledSteamApps, SteamImporterProvider } from "@hynite/importers";
import { makeGameId, type LibraryQuery, type ProviderId, type SourceImportInput } from "@hynite/core";
import { HomeService } from "./homeService";
import { NativeBridge } from "./nativeBridge";
import { SettingsService } from "./settingsService";
import { SourceService } from "./sourceService";
import { SyncStatusService } from "./syncStatusService";
import { pairSteamAccount } from "./steamAuthService";

let mainWindow: Electron.BrowserWindow | undefined;
let repository: HyniteRepository;
let settingsService: SettingsService;
let homeService: HomeService;
let sourceService: SourceService;
let nativeBridge: NativeBridge;
let syncStatusService: SyncStatusService;

function hasReusableMetadata(game: { id: string; metadataStatus: string }): boolean {
  return game.metadataStatus !== "none";
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0a0b0d",
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
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`);
  });
}

async function syncSteamLibrary(providerId?: ProviderId) {
  const settings = await settingsService.get();
  const webApiKey = settings.steamAccount?.webApiKey ? await nativeBridge.decryptSecret(settings.steamAccount.webApiKey) : undefined;
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
    metadataLogger: (entry) => {
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
  let imported;
  try {
    syncStatusService.progress("steam:owned-games", "Calling Steam owned games API");
    imported = await provider.scan();
  } catch (error) {
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

    let upserted = 0;
    const warnings: string[] = [];

    for (const [index, game] of imported.entries()) {
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

      syncStatusService.progress("metadata:refresh", `Fetching metadata for ${game.title}`, index + 1, imported.length, { appid: game.externalId });
      const metadata = await provider.refreshMetadata(gameWithInstallState);
      repository.applyMetadata(persisted.id, metadata);
      if (metadata.metadataStatus === "failed") {
        warnings.push(`Metadata failed for ${game.title}`);
      }
    }

    syncStatusService.finish(`Steam sync complete: ${upserted} games, ${installedApps.size} local installs`);
    return { providerId: "steam" as const, scanned: imported.length, upserted, warnings };
  } catch (error) {
    syncStatusService.fail("Steam sync failed", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function registerIpc(): void {
  ipcMain.handle("library:sync", async (_event, providerId?: ProviderId) => {
    return syncSteamLibrary(providerId);
  });

  ipcMain.handle("library:list", (_event, query: LibraryQuery = {}) =>
    repository.queryGames(query.search, query.installState ?? "all", query.sort ?? "title", query.sortDirection)
  );
  ipcMain.handle("library:clear", () => ({ cleared: repository.clearLibrary() }));

  ipcMain.handle("games:get", (_event, id: string) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    return { ...game, sourceMatches: sourceService.search(id) };
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

  ipcMain.handle("home:get", () => homeService.get(repository.listGames()));
  ipcMain.handle("sync:status", () => syncStatusService.get());
  ipcMain.handle("sources:import", (_event, input: SourceImportInput) => sourceService.import(input));
  ipcMain.handle("sources:search", (_event, gameId: string) => sourceService.search(gameId));
  ipcMain.handle("sources:searchTitle", (_event, title: string) => sourceService.searchTitle(title));
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
    if (parsed.protocol !== "https:" || parsed.hostname !== "store.steampowered.com") {
      throw new Error("Only Steam Store links can be opened externally.");
    }

    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle("native:openFolder", (_event, path: string) => shell.openPath(path));
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
  homeService = new HomeService(join(userData, "home-cache.json"));
  sourceService = new SourceService(repository);
  nativeBridge = new NativeBridge();
  syncStatusService = new SyncStatusService(() => mainWindow, join(userData, "sync-status.json"));
  registerIpc();
  createWindow();
  void settingsService.get().then((settings) => {
    if (settings.steamAccount?.webApiKey) {
      return syncSteamLibrary("steam").catch((error: unknown) => {
        console.warn("Startup Steam sync failed", error);
      });
    }
    return undefined;
  });
});

app.on("window-all-closed", () => {
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
