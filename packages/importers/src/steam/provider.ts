import type { GameMetadataPatch, ImportedGame, ImporterProvider } from "@hynite/core";
import { fetchSteamMetadata } from "@hynite/metadata";
import { discoverSteamLibraries, readSteamManifests } from "./discovery";

export type SteamProviderOptions = {
  candidateRoots?: string[];
};

export class SteamImporterProvider implements ImporterProvider {
  readonly id = "steam" as const;
  readonly label = "Steam";

  constructor(private readonly options: SteamProviderOptions = {}) {}

  async scan(): Promise<ImportedGame[]> {
    const libraries = await discoverSteamLibraries(this.options.candidateRoots);
    const manifests = (await Promise.all(libraries.map((library) => readSteamManifests(library)))).flat();

    return manifests.map((manifest) => ({
      provider: this.id,
      externalId: manifest.appid,
      title: manifest.name,
      installState: "installed",
      installDirectory: manifest.installDirectory,
      launchCommand: `steam://rungameid/${manifest.appid}`,
      playtimeMinutes: manifest.playtimeMinutes
    }));
  }

  async refreshMetadata(game: ImportedGame): Promise<GameMetadataPatch> {
    return fetchSteamMetadata(game.externalId);
  }
}

