import { unixSecondsToIso } from "./shared";

export type ImportedSteamWishlistItem = {
  appid: string;
  priority?: number;
  addedAt?: string;
};

export type SteamWishlistOptions = {
  steamId: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

type WishlistCandidate = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function candidateArrays(value: unknown): unknown[][] {
  const record = asRecord(value);
  if (!record) return [];
  const arrays: unknown[][] = [];
  for (const key of ["items", "wishlist", "apps", "rgWishlist", "games"]) {
    const child = record[key];
    if (Array.isArray(child)) arrays.push(child);
  }
  for (const key of ["response", "data"]) {
    arrays.push(...candidateArrays(record[key]));
  }
  return arrays;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function appidValue(value: unknown): string | undefined {
  const record = asRecord(value);
  const raw = record?.appid ?? record?.app_id ?? record?.appID;
  const appid = numberValue(raw);
  return appid && appid > 0 ? String(Math.trunc(appid)) : undefined;
}

function addedAtValue(value: WishlistCandidate): string | undefined {
  const raw = value.date_added ?? value.added_at ?? value.time_added ?? value.added;
  const seconds = numberValue(raw);
  if (seconds && seconds > 0) return unixSecondsToIso(seconds);
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

function parseWishlistItems(json: unknown): ImportedSteamWishlistItem[] {
  for (const array of candidateArrays(json)) {
    const items: ImportedSteamWishlistItem[] = array
      .map((entry): ImportedSteamWishlistItem | undefined => {
        const record = asRecord(entry);
        const appid = appidValue(entry);
        if (!record || !appid) return undefined;
        const priority = numberValue(record.priority);
        const addedAt = addedAtValue(record);
        return {
          appid,
          ...(priority === undefined ? {} : { priority }),
          ...(addedAt === undefined ? {} : { addedAt })
        };
      })
      .filter((entry): entry is ImportedSteamWishlistItem => Boolean(entry));
    if (items.length > 0 || array.length === 0) {
      return items;
    }
  }
  throw new Error("Steam returned no parseable wishlist items.");
}

export async function fetchSteamWishlist(options: SteamWishlistOptions): Promise<ImportedSteamWishlistItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    steamid: options.steamId,
    format: "json"
  });
  const response = await fetchImpl(`https://api.steampowered.com/IWishlistService/GetWishlist/v1/?${params.toString()}`, {
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`Steam wishlist request failed with ${response.status}.`);
  }

  return parseWishlistItems(await response.json());
}
