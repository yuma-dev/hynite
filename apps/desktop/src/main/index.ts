import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import { join } from "node:path";
import { HyniteRepository } from "@hynite/db";
import { SteamImporterProvider } from "@hynite/importers";
import { makeGameId, type LibraryQuery, type ProviderId, type SourceImportInput } from "@hynite/core";
import { HomeService } from "./homeService";
import { NativeBridge } from "./nativeBridge";
import { SettingsService } from "./settingsService";
import { SourceService } from "./sourceService";

let mainWindow: Electron.BrowserWindow | undefined;
let repository: HyniteRepository;
let settingsService: SettingsService;
let homeService: HomeService;
let sourceService: SourceService;
let nativeBridge: NativeBridge;

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

function registerIpc(): void {
  ipcMain.handle("library:sync", async (_event, providerId?: ProviderId) => {
    const settings = await settingsService.get();
    const provider = new SteamImporterProvider({ candidateRoots: settings.steamLibraryRoots });
    if (providerId && providerId !== "steam") {
      throw new Error(`Provider ${providerId} is not implemented yet.`);
    }

    const imported = await provider.scan();
    let upserted = 0;
    const warnings: string[] = [];

    for (const game of imported) {
      const persisted = repository.upsertImportedGame(game);
      upserted += 1;
      const metadata = await provider.refreshMetadata(game);
      repository.applyMetadata(persisted.id, metadata);
      if (metadata.metadataStatus === "failed") {
        warnings.push(`Metadata failed for ${game.title}`);
      }
    }

    return { providerId: "steam", scanned: imported.length, upserted, warnings };
  });

  ipcMain.handle("library:list", (_event, query: LibraryQuery = {}) =>
    repository.queryGames(query.search, query.installState ?? "all", query.sort ?? "title")
  );

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
  ipcMain.handle("sources:import", (_event, input: SourceImportInput) => sourceService.import(input));
  ipcMain.handle("sources:search", (_event, gameId: string) => sourceService.search(gameId));
  ipcMain.handle("sources:searchTitle", (_event, title: string) => sourceService.searchTitle(title));
  ipcMain.handle("clipboard:copy", (_event, text: string) => clipboard.writeText(text));
  ipcMain.handle("settings:get", () => settingsService.get());
  ipcMain.handle("settings:update", (_event, patch) => settingsService.update(patch));
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
  registerIpc();
  createWindow();
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
