import type { GameMetadataPatch, ImportedGame, ImporterProvider } from "@hynite/core";
import { refreshFusedMetadata, type MetadataFusionOptions, type MetadataLogger } from "@hynite/metadata";
import { fetchOwnedSteamGames } from "./webApi";

export type SteamProviderOptions = {
  account?: {
    steamId: string;
    webApiKey: string;
  };
  includePlayedFreeGames?: boolean;
  steamGridDbApiKey?: string;
  metadataLogger?: MetadataLogger;
  steamAppInfoProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>;
  rawMetadataRecorder?: MetadataFusionOptions["rawMetadataRecorder"];
  metadataMode?: MetadataFusionOptions["mode"];
  signal?: AbortSignal;
};

export class SteamImporterProvider implements ImporterProvider {
  readonly id = "steam" as const;
  readonly label = "Steam";

  constructor(private readonly options: SteamProviderOptions = {}) {}

  async scan(): Promise<ImportedGame[]> {
    if (!this.options.account?.steamId || !this.options.account.webApiKey) {
      throw new Error("Steam sync requires a paired Steam account and Steam Web API key.");
    }

    const ownedGames = await fetchOwnedSteamGames({
      steamId: this.options.account.steamId,
      webApiKey: this.options.account.webApiKey,
      includePlayedFreeGames: this.options.includePlayedFreeGames,
      signal: this.options.signal
    });

    return ownedGames;
  }

  async refreshMetadata(game: ImportedGame): Promise<GameMetadataPatch> {
    return refreshFusedMetadata(game, {
      steamGridDbApiKey: this.options.steamGridDbApiKey,
      logger: this.options.metadataLogger,
      steamAppInfoProvider: this.options.steamAppInfoProvider,
      rawMetadataRecorder: this.options.rawMetadataRecorder,
      mode: this.options.metadataMode
    });
  }
}
