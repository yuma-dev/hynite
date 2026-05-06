import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { objectValue, parseVdf, stringValue, type VdfObject } from "./vdf";

export type SteamLibraryFolder = {
  path: string;
  steamAppsPath: string;
};

export type SteamAppManifest = {
  appid: string;
  name: string;
  installdir?: string;
  installDirectory?: string;
  playtimeMinutes?: number;
};

function commonSteamRoots(): string[] {
  const roots = new Set<string>();
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const programFiles = process.env.ProgramFiles;
  const localAppData = process.env.LOCALAPPDATA;

  if (programFilesX86) {
    roots.add(join(programFilesX86, "Steam"));
  }
  if (programFiles) {
    roots.add(join(programFiles, "Steam"));
  }
  if (localAppData) {
    roots.add(join(localAppData, "Steam"));
  }

  return [...roots];
}

function extractLibraryPaths(root: string, parsed: VdfObject): string[] {
  const libraryFolders = objectValue(parsed.libraryfolders);
  if (!libraryFolders) {
    return [root];
  }

  const paths = new Set<string>([root]);
  for (const value of Object.values(libraryFolders)) {
    if (typeof value === "string") {
      paths.add(value.replace(/\\\\/g, "\\"));
      continue;
    }

    const path = stringValue(value.path);
    if (path) {
      paths.add(path.replace(/\\\\/g, "\\"));
    }
  }

  return [...paths];
}

export async function discoverSteamLibraries(candidateRoots: string[] = []): Promise<SteamLibraryFolder[]> {
  const roots = [...candidateRoots, ...commonSteamRoots()].map((root) => resolve(root));
  const libraries = new Map<string, SteamLibraryFolder>();

  for (const root of roots) {
    const steamAppsPath = join(root, "steamapps");
    if (!existsSync(steamAppsPath)) {
      continue;
    }

    const libraryFoldersPath = join(steamAppsPath, "libraryfolders.vdf");
    let paths = [root];
    if (existsSync(libraryFoldersPath)) {
      const parsed = parseVdf(await readFile(libraryFoldersPath, "utf8"));
      paths = extractLibraryPaths(root, parsed);
    }

    for (const path of paths) {
      const candidate = resolve(path);
      const appsPath = join(candidate, "steamapps");
      if (existsSync(appsPath)) {
        libraries.set(candidate.toLocaleLowerCase(), { path: candidate, steamAppsPath: appsPath });
      }
    }
  }

  return [...libraries.values()];
}

function parseManifest(input: string): SteamAppManifest | undefined {
  const parsed = parseVdf(input);
  const appState = objectValue(parsed.AppState);
  if (!appState) {
    return undefined;
  }

  const appid = stringValue(appState.appid);
  const name = stringValue(appState.name);
  if (!appid || !name) {
    return undefined;
  }

  const installdir = stringValue(appState.installdir);
  const minutes = Number.parseInt(stringValue(appState.LastPlayed) ?? "", 10);

  return {
    appid,
    name,
    installdir,
    playtimeMinutes: Number.isFinite(minutes) ? minutes : undefined
  };
}

export async function readSteamManifests(library: SteamLibraryFolder): Promise<SteamAppManifest[]> {
  const files = await readdir(library.steamAppsPath);
  const manifests: SteamAppManifest[] = [];

  for (const file of files.filter((name) => /^appmanifest_\d+\.acf$/i.test(name))) {
    const manifest = parseManifest(await readFile(join(library.steamAppsPath, file), "utf8"));
    if (!manifest) {
      continue;
    }

    manifests.push({
      ...manifest,
      installDirectory: manifest.installdir ? join(library.steamAppsPath, "common", manifest.installdir) : undefined
    });
  }

  return manifests;
}

