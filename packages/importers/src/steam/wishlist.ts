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

function wishlistSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Steam wishlist sync cancelled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Steam wishlist sync cancelled."));
      },
      { once: true }
    );
  });
}

export async function fetchSteamWishlist(options: SteamWishlistOptions): Promise<ImportedSteamWishlistItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    steamid: options.steamId,
    format: "json"
  });
  const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?${params.toString()}`;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, { signal: options.signal });
    if (response.ok) {
      return parseWishlistItems(await response.json());
    }

    // Steam rate-limits this endpoint with 429; back off (honouring Retry-After)
    // and retry rather than failing the whole sync on a transient throttle.
    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
      await wishlistSleep(Math.min(backoffMs, 30000), options.signal);
      continue;
    }

    if (response.status === 429) {
      throw new Error("Steam is rate-limiting wishlist requests (HTTP 429). Your cached wishlist is kept; try again in a few minutes.");
    }
    throw new Error(`Steam wishlist request failed with ${response.status}.`);
  }

  throw new Error("Steam wishlist request failed after repeated rate-limiting (HTTP 429).");
}
