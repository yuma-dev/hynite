import type { ImportedGame } from "@hynite/core";

type SteamOwnedGamesResponse = {
  response?: {
    game_count?: number;
    games?: SteamOwnedGame[];
  };
};

type SteamOwnedGame = {
  appid?: number;
  name?: string;
  img_icon_url?: string;
  playtime_forever?: number;
  rtime_last_played?: number;
};

export type SteamOwnedGamesOptions = {
  steamId: string;
  webApiKey: string;
  includePlayedFreeGames?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

function unixSecondsToIso(value: number | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return new Date(value * 1000).toISOString();
}

function communityIconUrl(appid: number, hash: string | undefined): string | undefined {
  if (!hash) {
    return undefined;
  }

  return `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${appid}/${hash}.jpg`;
}

export async function fetchOwnedSteamGames(options: SteamOwnedGamesOptions): Promise<ImportedGame[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    key: options.webApiKey,
    steamid: options.steamId,
    include_appinfo: "true",
    include_played_free_games: options.includePlayedFreeGames === false ? "false" : "true",
    format: "json"
  });

  const response = await fetchImpl(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?${params.toString()}`, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Steam owned games request failed with ${response.status}.`);
  }

  const json = (await response.json()) as SteamOwnedGamesResponse;
  const games = json.response?.games;
  if (!Array.isArray(games)) {
    throw new Error("Steam returned no owned games. Check account privacy and Web API key pairing.");
  }

  return games
    .filter((game): game is Required<Pick<SteamOwnedGame, "appid" | "name">> & SteamOwnedGame => Boolean(game.appid && game.name))
    .map((game) => ({
      provider: "steam",
      externalId: String(game.appid),
      title: game.name,
      installState: "unknown",
      launchCommand: `steam://rungameid/${game.appid}`,
      playtimeMinutes: game.playtime_forever,
      lastPlayedAt: unixSecondsToIso(game.rtime_last_played),
      communityIconUrl: communityIconUrl(game.appid, game.img_icon_url)
    }));
}
