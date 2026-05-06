import type { GameMetadataPatch } from "@hynite/core";

type SteamAppDetailsResponse = Record<
  string,
  {
    success: boolean;
    data?: {
      type?: string;
      name?: string;
      steam_appid?: number;
      required_age?: number;
      is_free?: boolean;
      detailed_description?: string;
      short_description?: string;
      header_image?: string;
      capsule_image?: string;
      capsule_imagev5?: string;
      background_raw?: string;
      background?: string;
      developers?: string[];
      publishers?: string[];
      genres?: Array<{ id: string; description: string }>;
      categories?: Array<{ id: number; description: string }>;
      release_date?: { coming_soon?: boolean; date?: string };
    };
  }
>;

function parseSteamDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

export async function fetchSteamMetadata(appid: string, fetchImpl: typeof fetch = fetch): Promise<GameMetadataPatch> {
  try {
    const response = await fetchImpl(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&cc=us&l=en`);
    if (!response.ok) {
      return { metadataStatus: "failed" };
    }

    const json = (await response.json()) as SteamAppDetailsResponse;
    const details = json[appid];
    if (!details?.success || !details.data) {
      return { metadataStatus: "failed" };
    }

    const data = details.data;
    return {
      coverUrl: data.capsule_imagev5 ?? data.capsule_image ?? data.header_image,
      backgroundUrl: data.background_raw ?? data.background,
      genres: data.genres?.map((genre) => genre.description) ?? [],
      tags: data.categories?.map((category) => category.description) ?? [],
      developers: data.developers ?? [],
      publishers: data.publishers ?? [],
      releaseDate: parseSteamDate(data.release_date?.date),
      metadataStatus: "complete"
    };
  } catch {
    return { metadataStatus: "failed" };
  }
}

