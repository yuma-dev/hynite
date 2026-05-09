import type { ImportedGame } from "@hynite/core";
import { communityIconUrl, unixSecondsToIso } from "./shared";

const familyEndpoint = "https://api.steampowered.com/IFamilyGroupsService";

export type SteamFamilyAuth = {
  accessToken: string;
  steamId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

type GetFamilyGroupForUserResponse = {
  response?: {
    family_groupid?: string | number;
    is_not_member_of_any_family?: boolean;
  };
};

type SharedAppRow = {
  appid?: number;
  name?: string;
  owner_steamids?: string[];
  img_icon_hash?: string;
  exclude_reason?: number;
  rt_time_acquired?: number;
  rt_last_played?: number;
  rt_playtime?: number;
};

type GetSharedLibraryAppsResponse = {
  response?: {
    apps?: SharedAppRow[];
  };
};

export async function fetchFamilyGroupId(auth: SteamFamilyAuth): Promise<string | undefined> {
  const fetchImpl = auth.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    access_token: auth.accessToken,
    steamid: auth.steamId,
    format: "json"
  });

  const response = await fetchImpl(`${familyEndpoint}/GetFamilyGroupForUser/v1/?${params.toString()}`, { signal: auth.signal });
  if (response.status === 401 || response.status === 403) {
    throw new SteamFamilyAuthError("Steam family access token is invalid or expired.");
  }
  if (!response.ok) {
    throw new Error(`Steam family group lookup failed with ${response.status}.`);
  }

  const json = (await response.json()) as GetFamilyGroupForUserResponse;
  if (json.response?.is_not_member_of_any_family) {
    return undefined;
  }

  const id = json.response?.family_groupid;
  return id ? String(id) : undefined;
}

export type FetchFamilySharedGamesOptions = SteamFamilyAuth & {
  familyGroupId: string;
};

export async function fetchFamilySharedGames(options: FetchFamilySharedGamesOptions): Promise<ImportedGame[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    access_token: options.accessToken,
    family_groupid: options.familyGroupId,
    include_own: "false",
    include_excluded: "false",
    language: "english",
    format: "json"
  });

  const response = await fetchImpl(`${familyEndpoint}/GetSharedLibraryApps/v1/?${params.toString()}`, { signal: options.signal });
  if (response.status === 401 || response.status === 403) {
    throw new SteamFamilyAuthError("Steam family access token is invalid or expired.");
  }
  if (!response.ok) {
    throw new Error(`Steam shared library request failed with ${response.status}.`);
  }

  const json = (await response.json()) as GetSharedLibraryAppsResponse;
  const apps = json.response?.apps;
  if (!Array.isArray(apps)) {
    return [];
  }

  return apps
    .filter((app): app is SharedAppRow & Required<Pick<SharedAppRow, "appid" | "name">> => Boolean(app.appid && app.name))
    .filter((app) => (app.exclude_reason ?? 0) === 0)
    .filter((app) => !(app.owner_steamids ?? []).includes(options.steamId))
    .map((app) => ({
      provider: "steam" as const,
      externalId: String(app.appid),
      title: app.name,
      installState: "unknown" as const,
      launchCommand: `steam://rungameid/${app.appid}`,
      playtimeMinutes: typeof app.rt_playtime === "number" ? Math.round(app.rt_playtime / 60) : undefined,
      lastPlayedAt: unixSecondsToIso(app.rt_last_played),
      addedAt: unixSecondsToIso(app.rt_time_acquired),
      communityIconUrl: communityIconUrl(app.appid, app.img_icon_hash),
      shareType: "family" as const,
      familyOwnerSteamIds: app.owner_steamids ?? [],
      ownerSteamid: options.steamId
    }));
}

export class SteamFamilyAuthError extends Error {
  readonly code = "STEAM_FAMILY_AUTH" as const;

  constructor(message: string) {
    super(message);
    this.name = "SteamFamilyAuthError";
  }
}
