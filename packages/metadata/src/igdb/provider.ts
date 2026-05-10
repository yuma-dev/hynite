import type { GameMetadataPatch, ImportedGame } from "@hynite/core";
import { buildIgdbImageUrl, IgdbClient, type IgdbGame } from "./client";

export type IgdbProviderOptions = {
  client: IgdbClient;
};

export function mapIgdbGameToPatch(game: IgdbGame): GameMetadataPatch {
  const patch: GameMetadataPatch = { metadataStatus: "partial" };

  if (game.name) patch.title = game.name;
  if (game.summary) patch.shortDescription = game.summary;
  if (game.storyline) patch.aboutText = game.storyline;
  if (game.first_release_date) {
    patch.releaseDate = new Date(game.first_release_date * 1000).toISOString();
  }

  if (game.cover?.image_id) {
    const cover = buildIgdbImageUrl(game.cover.image_id, "cover_big");
    patch.coverUrl = cover;
    patch.libraryCapsuleUrl = cover;
  }

  if (game.artworks?.length) {
    const art = game.artworks.find((entry) => entry.image_id)?.image_id;
    if (art) patch.backgroundUrl = buildIgdbImageUrl(art, "1080p");
  }

  if (game.screenshots?.length) {
    patch.screenshots = game.screenshots
      .filter((entry): entry is { image_id: string } => Boolean(entry.image_id))
      .slice(0, 8)
      .map((entry) => ({
        thumbnailUrl: buildIgdbImageUrl(entry.image_id, "thumb"),
        fullUrl: buildIgdbImageUrl(entry.image_id, "screenshot_big")
      }));
  }

  if (game.genres?.length) {
    patch.genres = game.genres.map((entry) => entry.name).filter((value): value is string => Boolean(value));
  }
  if (game.themes?.length) {
    patch.tags = game.themes.map((entry) => entry.name).filter((value): value is string => Boolean(value));
  }

  if (game.involved_companies?.length) {
    const developers = game.involved_companies
      .filter((entry) => entry.developer && entry.company?.name)
      .map((entry) => entry.company!.name!);
    const publishers = game.involved_companies
      .filter((entry) => entry.publisher && entry.company?.name)
      .map((entry) => entry.company!.name!);
    if (developers.length) patch.developers = [...new Set(developers)];
    if (publishers.length) patch.publishers = [...new Set(publishers)];
  }

  if (game.websites?.length) {
    const official = game.websites.find((entry) => entry.category === 1)?.url;
    if (official) patch.websiteUrl = official;
  }

  if (patch.coverUrl && patch.shortDescription) {
    patch.metadataStatus = "complete";
  }

  return patch;
}

export function createIgdbMetadataRefresher(
  options: IgdbProviderOptions
): (game: ImportedGame) => Promise<GameMetadataPatch> {
  return async (game) => {
    const id = Number(game.externalId);
    if (!Number.isFinite(id)) return { metadataStatus: "failed" };
    const igdbGame = await options.client.getGame(id);
    if (!igdbGame) return { metadataStatus: "failed" };
    return mapIgdbGameToPatch(igdbGame);
  };
}
