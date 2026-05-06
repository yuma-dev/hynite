import { type Game, type HomeModel, makeGameId, makeSortTitle } from "@hynite/core";
import { fetchSteamMetadata } from "@hynite/metadata";

type SteamChartItem = {
  appid: number;
  rank?: number;
  peak_in_game?: number;
};

type SteamChartsResponse = {
  response?: {
    ranks?: SteamChartItem[];
  };
};

const fallbackPopular = [
  { appid: "730", title: "Counter-Strike 2" },
  { appid: "570", title: "Dota 2" },
  { appid: "1172470", title: "Apex Legends" },
  { appid: "578080", title: "PUBG: BATTLEGROUNDS" },
  { appid: "271590", title: "Grand Theft Auto V Enhanced" },
  { appid: "1245620", title: "ELDEN RING" },
  { appid: "1086940", title: "Baldur's Gate 3" },
  { appid: "1091500", title: "Cyberpunk 2077" }
];

function candidateToGame(appid: string, title: string): Game {
  return {
    id: makeGameId("steam", appid),
    title,
    sortTitle: makeSortTitle(title),
    sourceIds: [{ provider: "steam", externalId: appid }],
    installState: "not_installed",
    genres: [],
    tags: [],
    developers: [],
    publishers: [],
    metadataStatus: "none"
  };
}

async function popularSteamCandidates(fetchImpl: typeof fetch): Promise<Game[]> {
  try {
    const response = await fetchImpl("https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/?format=json");
    if (!response.ok) {
      throw new Error(`Steam charts returned ${response.status}`);
    }
    const json = (await response.json()) as SteamChartsResponse;
    const ranks = json.response?.ranks?.slice(0, 12) ?? [];
    if (ranks.length === 0) {
      throw new Error("Steam charts returned no ranks");
    }

    return ranks.map((item) => candidateToGame(String(item.appid), `Steam App ${item.appid}`));
  } catch {
    return fallbackPopular.map((item) => candidateToGame(item.appid, item.title));
  }
}

async function enrichCandidates(candidates: Game[], fetchImpl: typeof fetch): Promise<Game[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const steamId = candidate.sourceIds.find((source) => source.provider === "steam")?.externalId;
      if (!steamId) {
        return candidate;
      }

      const metadata = await fetchSteamMetadata(steamId, fetchImpl);
      return {
        ...candidate,
        coverUrl: metadata.coverUrl,
        backgroundUrl: metadata.backgroundUrl,
        genres: metadata.genres ?? [],
        tags: metadata.tags ?? [],
        developers: metadata.developers ?? [],
        publishers: metadata.publishers ?? [],
        releaseDate: metadata.releaseDate,
        metadataStatus: metadata.metadataStatus ?? "partial"
      };
    })
  );
}

function rankRecommended(localGames: Game[], candidates: Game[]): Game[] {
  const ownedIds = new Set(localGames.flatMap((game) => game.sourceIds.map((source) => `${source.provider}:${source.externalId}`)));
  const genreWeights = new Map<string, number>();
  for (const game of localGames) {
    const weight = Math.max(1, Math.log10((game.playtimeMinutes ?? 0) + 10));
    for (const genre of [...game.genres, ...game.tags]) {
      genreWeights.set(genre, (genreWeights.get(genre) ?? 0) + weight);
    }
  }

  return candidates
    .filter((candidate) => !ownedIds.has(candidate.id))
    .map((candidate, index) => {
      const tasteScore = [...candidate.genres, ...candidate.tags].reduce((score, genre) => score + (genreWeights.get(genre) ?? 0), 0);
      return { candidate, score: tasteScore + (candidates.length - index) * 0.01 };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.candidate);
}

export async function buildHomeModel(localGames: Game[], fetchImpl: typeof fetch = fetch): Promise<HomeModel> {
  const popular = await enrichCandidates(await popularSteamCandidates(fetchImpl), fetchImpl);
  const continuePlaying = [...localGames]
    .filter((game) => game.installState === "installed")
    .sort((a, b) => (Date.parse(b.lastPlayedAt ?? "") || b.playtimeMinutes || 0) - (Date.parse(a.lastPlayedAt ?? "") || a.playtimeMinutes || 0))
    .slice(0, 8);

  return {
    continuePlaying,
    popularNow: popular.slice(0, 8),
    recommended: rankRecommended(localGames, popular).slice(0, 8),
    newAndNotable: [...popular].reverse().slice(0, 8),
    generatedAt: new Date().toISOString(),
    stale: false
  };
}

