import type { GameMetadataPatch, ImportedGame } from "@hynite/core";
import { fetchSteamAppInfoMetadata, fetchSteamMetadata } from "./steam";

export type MetadataProviderId = "steam-store" | "steam-appinfo" | "steam-cdn" | "steamgriddb";

export type MetadataProvider = {
  id: MetadataProviderId;
  label: string;
  refresh(game: ImportedGame): Promise<GameMetadataPatch>;
};

export type MetadataLog = {
  level: "info" | "warning" | "error";
  providerId: MetadataProviderId;
  gameTitle: string;
  appid: string;
  message: string;
  details?: Record<string, unknown>;
};

export type MetadataLogger = (entry: MetadataLog) => void;

function mergePatch(base: GameMetadataPatch, next: GameMetadataPatch): GameMetadataPatch {
  const merged: GameMetadataPatch = {
    title: base.title ?? next.title,
    sortTitle: base.sortTitle ?? next.sortTitle,
    coverUrl: base.coverUrl ?? next.coverUrl,
    backgroundUrl: base.backgroundUrl ?? next.backgroundUrl,
    communityIconUrl: base.communityIconUrl ?? next.communityIconUrl,
    libraryCapsuleUrl: base.libraryCapsuleUrl ?? next.libraryCapsuleUrl,
    headerUrl: base.headerUrl ?? next.headerUrl,
    trailerUrl: base.trailerUrl ?? next.trailerUrl,
    trailerPosterUrl: base.trailerPosterUrl ?? next.trailerPosterUrl,
    screenshots: base.screenshots?.length ? base.screenshots : next.screenshots,
    shortDescription: base.shortDescription ?? next.shortDescription,
    aboutText: base.aboutText ?? next.aboutText,
    websiteUrl: base.websiteUrl ?? next.websiteUrl,
    supportUrl: base.supportUrl ?? next.supportUrl,
    platforms: base.platforms ?? next.platforms,
    achievementCount: base.achievementCount ?? next.achievementCount,
    recommendationCount: base.recommendationCount ?? next.recommendationCount,
    contentDescriptors: base.contentDescriptors?.length ? base.contentDescriptors : next.contentDescriptors,
    discovery: base.discovery ?? next.discovery,
    genres: base.genres?.length ? base.genres : next.genres,
    tags: base.tags?.length ? base.tags : next.tags,
    developers: base.developers?.length ? base.developers : next.developers,
    publishers: base.publishers?.length ? base.publishers : next.publishers,
    releaseDate: base.releaseDate ?? next.releaseDate,
    metadataStatus: base.metadataStatus === "complete" || next.metadataStatus === "complete" ? "complete" : (base.metadataStatus ?? next.metadataStatus)
  };

  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as GameMetadataPatch;
}

export const steamStoreMetadataProvider: MetadataProvider = {
  id: "steam-store",
  label: "Steam Store",
  refresh: (game) => fetchSteamMetadata(game.externalId)
};

export const steamAppInfoMetadataProvider: MetadataProvider = {
  id: "steam-appinfo",
  label: "Steam appinfo",
  refresh: (game) => fetchSteamAppInfoMetadata(game.externalId)
};

async function reachableImage(url: string): Promise<{ ok: boolean; status?: number; statusText?: string; contentType?: string }> {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? undefined
    };
  } catch (error) {
    return {
      ok: false,
      statusText: error instanceof Error ? error.message : "request failed"
    };
  }
}

function createSteamCdnArtworkProvider(logger?: MetadataLogger): MetadataProvider {
  return {
    id: "steam-cdn",
    label: "Steam CDN artwork",
    async refresh(game) {
      const appid = encodeURIComponent(game.externalId);
      const libraryCapsule2xUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_600x900_2x.jpg`;
      const libraryCapsuleUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_600x900.jpg`;
      const backgroundUrl = `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_hero.jpg`;
      const headerUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`;
      const [capsule2x, capsule, background] = await Promise.all([reachableImage(libraryCapsule2xUrl), reachableImage(libraryCapsuleUrl), reachableImage(backgroundUrl)]);
      const bestCapsuleUrl = capsule2x.ok ? libraryCapsule2xUrl : capsule.ok ? libraryCapsuleUrl : undefined;

      if (!bestCapsuleUrl) {
        logger?.({
          level: "warning",
          providerId: "steam-cdn",
          gameTitle: game.title,
          appid: game.externalId,
          message: "Steam library capsule was not available",
          details: {
            requested: [libraryCapsule2xUrl, libraryCapsuleUrl],
            response: { image2x: capsule2x, image: capsule },
            alternatives: [headerUrl, backgroundUrl, `https://api.steamcmd.net/v1/info/${appid}`]
          }
        });
      }

      if (!background.ok) {
        logger?.({
          level: "warning",
          providerId: "steam-cdn",
          gameTitle: game.title,
          appid: game.externalId,
          message: "Steam library hero was not available",
          details: {
            requested: backgroundUrl,
            response: background,
            alternatives: [headerUrl, libraryCapsuleUrl]
          }
        });
      }

      return {
        coverUrl: bestCapsuleUrl,
        libraryCapsuleUrl: bestCapsuleUrl,
        backgroundUrl: background.ok ? backgroundUrl : undefined,
        headerUrl,
        metadataStatus: "partial"
      };
    }
  };
}

export const steamCdnArtworkProvider: MetadataProvider = createSteamCdnArtworkProvider();

type SteamGridDbGrid = {
  id?: number;
  score?: number;
  url?: string;
  thumb?: string;
  width?: number;
  height?: number;
  nsfw?: boolean;
  humor?: boolean;
  style?: string;
  mime?: string;
  types?: string[];
};

type SteamGridDbResponse = {
  success?: boolean;
  data?: SteamGridDbGrid[];
};

function chooseSteamGridDbGrid(grids: SteamGridDbGrid[]): SteamGridDbGrid | undefined {
  const usable = grids.filter((grid) => grid.url && !grid.nsfw && !grid.humor);
  const exact = usable.filter((grid) => (grid.width === 600 && grid.height === 900) || (grid.width === 300 && grid.height === 450));
  const vertical = usable.filter((grid) => (grid.height ?? 0) > (grid.width ?? Number.MAX_SAFE_INTEGER));
  return [...(exact.length ? exact : vertical)].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
}

type SteamGridDbGame = {
  id?: number;
  name?: string;
  types?: string[];
  verified?: boolean;
};

type SteamGridDbSearchResponse = {
  success?: boolean;
  data?: SteamGridDbGame[];
};

function chooseSteamGridDbGame(games: SteamGridDbGame[], title: string): SteamGridDbGame | undefined {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  return games.find((game) => game.name?.trim().toLocaleLowerCase() === normalizedTitle) ?? games[0];
}

export function createSteamGridDbArtworkProvider(apiKey: string, fetchImpl: typeof fetch = fetch, logger?: MetadataLogger): MetadataProvider {
  return {
    id: "steamgriddb",
    label: "SteamGridDB artwork",
    async refresh(game) {
      const appid = encodeURIComponent(game.externalId);
      const encodedTitle = encodeURIComponent(game.title);
      const headers = { Authorization: `Bearer ${apiKey}` };
      const appidRequests = [
        `https://www.steamgriddb.com/api/v2/grids/steam/${appid}?dimensions=600x900&types=static`,
        `https://www.steamgriddb.com/api/v2/grids/steam/${appid}?dimensions=300x450&types=static`,
        `https://www.steamgriddb.com/api/v2/grids/steam/${appid}?types=static`
      ];

      for (const url of appidRequests) {
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
          logger?.({
            level: "warning",
            providerId: "steamgriddb",
            gameTitle: game.title,
            appid: game.externalId,
            message: "SteamGridDB artwork request failed",
            details: { requested: url, status: response.status, statusText: response.statusText }
          });
          continue;
        }

        const json = (await response.json()) as SteamGridDbResponse;
        const grid = chooseSteamGridDbGrid(json.data ?? []);
        if (grid?.url) {
          return {
            coverUrl: grid.url,
            libraryCapsuleUrl: grid.url,
            metadataStatus: "partial"
          };
        }
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB returned no usable vertical static artwork",
          details: {
            requested: url,
            returned: json.data?.map((item) => ({
              url: item.url,
              width: item.width,
              height: item.height,
              score: item.score,
              nsfw: item.nsfw,
              humor: item.humor
            }))
          }
        });
      }

      const searchUrl = `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodedTitle}`;
      const searchResponse = await fetchImpl(searchUrl, { headers });
      if (!searchResponse.ok) {
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB title search failed",
          details: { requested: searchUrl, status: searchResponse.status, statusText: searchResponse.statusText }
        });
        return {};
      }

      const searchJson = (await searchResponse.json()) as SteamGridDbSearchResponse;
      const foundGame = chooseSteamGridDbGame(searchJson.data ?? [], game.title);
      if (!foundGame?.id) {
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB title search returned no game match",
          details: {
            requested: searchUrl,
            returned: searchJson.data?.map((item) => ({ id: item.id, name: item.name, verified: item.verified, types: item.types }))
          }
        });
        return {};
      }

      const gameRequests = [
        `https://www.steamgriddb.com/api/v2/grids/game/${foundGame.id}?dimensions=600x900&types=static`,
        `https://www.steamgriddb.com/api/v2/grids/game/${foundGame.id}?dimensions=300x450&types=static`,
        `https://www.steamgriddb.com/api/v2/grids/game/${foundGame.id}?types=static`
      ];

      for (const url of gameRequests) {
        const response = await fetchImpl(url, { headers });
        if (!response.ok) {
          logger?.({
            level: "warning",
            providerId: "steamgriddb",
            gameTitle: game.title,
            appid: game.externalId,
            message: "SteamGridDB artwork request failed",
            details: { requested: url, status: response.status, statusText: response.statusText, gameId: foundGame.id, gameName: foundGame.name }
          });
          continue;
        }

        const json = (await response.json()) as SteamGridDbResponse;
        const grid = chooseSteamGridDbGrid(json.data ?? []);
        if (grid?.url) {
          return {
            coverUrl: grid.url,
            libraryCapsuleUrl: grid.url,
            metadataStatus: "partial"
          };
        }
        logger?.({
          level: "warning",
          providerId: "steamgriddb",
          gameTitle: game.title,
          appid: game.externalId,
          message: "SteamGridDB returned no usable vertical static artwork",
          details: {
            requested: url,
            gameId: foundGame.id,
            gameName: foundGame.name,
            returned: json.data?.map((item) => ({
              url: item.url,
              width: item.width,
              height: item.height,
              score: item.score,
              nsfw: item.nsfw,
              humor: item.humor
            }))
          }
        });
      }

      return {};
    }
  };
}

export type MetadataFusionOptions = {
  steamGridDbApiKey?: string;
  logger?: MetadataLogger;
};

export function defaultMetadataProviders(options: MetadataFusionOptions = {}): MetadataProvider[] {
  return [
    steamStoreMetadataProvider,
    steamAppInfoMetadataProvider,
    createSteamCdnArtworkProvider(options.logger),
    ...(options.steamGridDbApiKey ? [createSteamGridDbArtworkProvider(options.steamGridDbApiKey, fetch, options.logger)] : [])
  ];
}

export async function refreshFusedMetadata(
  game: ImportedGame,
  providersOrOptions: MetadataProvider[] | MetadataFusionOptions = defaultMetadataProviders()
): Promise<GameMetadataPatch> {
  const providers = Array.isArray(providersOrOptions) ? providersOrOptions : defaultMetadataProviders(providersOrOptions);
  let fused: GameMetadataPatch = {};

  for (const provider of providers) {
    try {
      const patch = await provider.refresh(game);
      if (patch.metadataStatus === "failed") {
        continue;
      }

      fused = mergePatch(fused, patch);
    } catch (error) {
      if (!Array.isArray(providersOrOptions)) {
        providersOrOptions.logger?.({
          level: "error",
          providerId: provider.id,
          gameTitle: game.title,
          appid: game.externalId,
          message: `${provider.label} failed`,
          details: { error: error instanceof Error ? error.message : String(error) }
        });
      }
      continue;
    }
  }

  return Object.keys(fused).length > 0 ? fused : { metadataStatus: "failed" };
}
