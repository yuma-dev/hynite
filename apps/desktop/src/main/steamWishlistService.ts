import type { GameMetadataPatch, ImportedGame, SteamAccountSettings, SteamWishlistItem, SyncResult, WishlistCalendarQuery, WishlistListQuery, WishlistReleasePrecision } from "@hynite/core";
import { makeSortTitle } from "@hynite/core";
import type { HyniteRepository, SteamWishlistUpsertItem } from "@hynite/db";
import { fetchSteamWishlist, type ImportedSteamWishlistItem } from "@hynite/importers";
import { refreshFusedMetadata, type MetadataLogger } from "@hynite/metadata";
import type { SettingsService } from "./settingsService";
import type { SourceService } from "./sourceService";
import type { SyncStatusService } from "./syncStatusService";

type WishlistServiceOptions = {
  repository: HyniteRepository;
  settingsService: SettingsService;
  sourceService: SourceService;
  syncStatusService: SyncStatusService;
  cacheMetadataAssets: (patch: GameMetadataPatch, refresh?: boolean) => Promise<GameMetadataPatch>;
  steamAppInfoProvider?: (game: ImportedGame) => Promise<GameMetadataPatch | undefined>;
  metadataLogger?: MetadataLogger;
  signal?: AbortSignal;
};

type SyncOptions = {
  refreshStaleMetadata?: boolean;
  signal?: AbortSignal;
};

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Steam wishlist sync cancelled.");
  }
}

function importedGame(appid: string, title: string): ImportedGame {
  return {
    provider: "steam",
    externalId: appid,
    title,
    installState: "unknown",
    launchCommand: `steam://rungameid/${appid}`
  };
}

function releaseInfoFromMetadata(metadata: GameMetadataPatch): {
  releaseDate?: string;
  releaseDateText?: string;
  releasePrecision: WishlistReleasePrecision;
} {
  if (metadata.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(metadata.releaseDate)) {
    return {
      releaseDate: metadata.releaseDate,
      releaseDateText: metadata.releaseDate,
      releasePrecision: "exact"
    };
  }
  return { releasePrecision: "unknown" };
}

function mergeWishlistMetadata(base: SteamWishlistUpsertItem, metadata: GameMetadataPatch): SteamWishlistUpsertItem {
  const release = releaseInfoFromMetadata(metadata);
  return {
    ...base,
    title: metadata.title ?? base.title,
    sortTitle: makeSortTitle(metadata.title ?? base.title),
    coverUrl: metadata.coverUrl ?? base.coverUrl,
    libraryCapsuleUrl: metadata.libraryCapsuleUrl ?? base.libraryCapsuleUrl,
    headerUrl: metadata.headerUrl ?? base.headerUrl,
    backgroundUrl: metadata.backgroundUrl ?? base.backgroundUrl,
    logoUrl: metadata.logoUrl ?? base.logoUrl,
    communityIconUrl: metadata.communityIconUrl ?? base.communityIconUrl,
    releaseDate: release.releaseDate ?? base.releaseDate,
    releaseDateText: release.releaseDateText ?? base.releaseDateText,
    releasePrecision: release.releasePrecision !== "unknown" ? release.releasePrecision : base.releasePrecision,
    metadataStatus: metadata.metadataStatus ?? base.metadataStatus
  };
}

function isFutureWishlistRelease(item: Pick<SteamWishlistUpsertItem, "releaseDate" | "releasePrecision">): boolean {
  if (item.releasePrecision !== "exact" || !item.releaseDate) return false;
  const releaseMs = Date.parse(`${item.releaseDate}T00:00:00.000Z`);
  const today = new Date();
  const todayMs = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Number.isFinite(releaseMs) && releaseMs > todayMs;
}

function withSourceMatches(sourceService: SourceService, item: SteamWishlistUpsertItem): SteamWishlistItem {
  return {
    ...item,
    sourceMatches: isFutureWishlistRelease(item) ? [] : sourceService.exactTitleMatches(item.title)
  };
}

export class SteamWishlistService {
  constructor(private readonly options: WishlistServiceOptions) {}

  list(query: WishlistListQuery = {}): SteamWishlistItem[] {
    let items = this.options.repository.querySteamWishlist(query);
    const needsSourceMatches = query.sourceAvailability === "available" || query.sourceAvailability === "missing";
    if (!needsSourceMatches) {
      return items.map((item) => ({ ...item, sourceMatches: [] }));
    }
    let matchedItems = items.map((item) => withSourceMatches(this.options.sourceService, item));
    if (query.sourceAvailability === "available") {
      matchedItems = matchedItems.filter((item) => item.sourceMatches.length > 0);
    } else if (query.sourceAvailability === "missing") {
      matchedItems = matchedItems.filter((item) => !isFutureWishlistRelease(item) && item.sourceMatches.length === 0);
    }
    return matchedItems;
  }

  count(): number {
    return this.options.repository.countSteamWishlist();
  }

  calendar(query: WishlistCalendarQuery): SteamWishlistItem[] {
    return this.options.repository.querySteamWishlistCalendar(query).map((item) => withSourceMatches(this.options.sourceService, item));
  }

  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const settings = await this.options.settingsService.get();
    const accounts = settings.steamAccounts;
    const warnings: string[] = [];
    if (accounts.length === 0) {
      return { providerId: "steam", scanned: 0, upserted: 0, warnings: ["Wishlist sync skipped: no paired Steam accounts."] };
    }

    let scanned = 0;
    let upserted = 0;
    const existingByAppid = new Map(this.options.repository.querySteamWishlist({}).map((item) => [item.appid, item]));

    for (const account of accounts) {
      throwIfCancelled(options.signal);
      this.options.syncStatusService.progress("steam:wishlist-fetch", `Fetching Steam wishlist for ${account.personaName ?? account.steamId}`);
      let fetched: ImportedSteamWishlistItem[];
      try {
        fetched = await fetchSteamWishlist({ steamId: account.steamId, signal: options.signal });
      } catch (error) {
        const message = `Steam wishlist refresh failed for ${account.personaName ?? account.steamId}; preserving cached wishlist rows.`;
        const details = { account: account.steamId, error: error instanceof Error ? error.message : String(error) };
        this.options.syncStatusService.log("warning", "steam:wishlist-fetch", message, details);
        warnings.push(message);
        continue;
      }

      scanned += fetched.length;
      const accountItems: SteamWishlistUpsertItem[] = [];
      for (let index = 0; index < fetched.length; index += 1) {
        throwIfCancelled(options.signal);
        const fetchedItem = fetched[index]!;
        const existing = existingByAppid.get(fetchedItem.appid);
        const refreshedAt = new Date().toISOString();
        let item: SteamWishlistUpsertItem = {
          appid: fetchedItem.appid,
          title: existing?.title && existing.title !== `App ${fetchedItem.appid}` ? existing.title : `App ${fetchedItem.appid}`,
          sortTitle: existing?.sortTitle ?? makeSortTitle(existing?.title ?? `App ${fetchedItem.appid}`),
          accounts: [accountRef(account, fetchedItem)],
          coverUrl: existing?.coverUrl,
          libraryCapsuleUrl: existing?.libraryCapsuleUrl,
          headerUrl: existing?.headerUrl,
          backgroundUrl: existing?.backgroundUrl,
          logoUrl: existing?.logoUrl,
          communityIconUrl: existing?.communityIconUrl,
          releaseDate: existing?.releaseDate,
          releaseDateText: existing?.releaseDateText,
          releasePrecision: existing?.releasePrecision ?? "unknown",
          metadataStatus: existing?.metadataStatus ?? "none",
          refreshedAt
        };

        const shouldRefreshMetadata = options.refreshStaleMetadata !== false || item.metadataStatus === "none";
        if (shouldRefreshMetadata) {
          const label = existing?.title && existing.title !== `App ${fetchedItem.appid}` ? existing.title : fetchedItem.appid;
          this.options.syncStatusService.progress("steam:wishlist-metadata", `Fetching SteamKit wishlist metadata for ${label}`, index + 1, fetched.length, {
            appid: item.appid,
            account: account.steamId
          });
          try {
            const fastMetadata = await refreshFusedMetadata(importedGame(item.appid, item.title), {
              mode: "fast",
              steamAppInfoProvider: this.options.steamAppInfoProvider,
              logger: this.options.metadataLogger
            });
            item = mergeWishlistMetadata(item, await this.options.cacheMetadataAssets(fastMetadata, options.refreshStaleMetadata !== false));
          } catch (error) {
            const message = `Wishlist metadata failed for ${item.title}`;
            warnings.push(message);
            this.options.syncStatusService.log("warning", "steam:wishlist-metadata", message, {
              appid: item.appid,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        accountItems.push(item);
        existingByAppid.set(item.appid, item);
      }

      this.options.syncStatusService.progress("steam:wishlist-upsert", `Saving Steam wishlist for ${account.personaName ?? account.steamId}`, undefined, undefined, {
        account: account.steamId,
        items: accountItems.length
      });
      this.options.repository.replaceSteamWishlistForAccount(account.steamId, accountItems);
      upserted += accountItems.length;
    }

    return { providerId: "steam", scanned, upserted, warnings };
  }
}

function accountRef(account: SteamAccountSettings, item: ImportedSteamWishlistItem) {
  return {
    steamId: account.steamId,
    personaName: account.personaName,
    priority: item.priority,
    addedAt: item.addedAt
  };
}
