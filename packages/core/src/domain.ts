import { z } from "zod";

export const providerIdSchema = z.enum(["steam", "epic", "gog", "manual", "local", "igdb"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const installStateSchema = z.enum(["installed", "not_installed", "unknown"]);
export type InstallState = z.infer<typeof installStateSchema>;

export const metadataStatusSchema = z.enum(["none", "partial", "complete", "failed"]);
export type MetadataStatus = z.infer<typeof metadataStatusSchema>;

export const gameScreenshotSchema = z.object({
  thumbnailUrl: z.string().min(1),
  fullUrl: z.string().min(1)
});
export type GameScreenshot = z.infer<typeof gameScreenshotSchema>;

export const gamePlatformsSchema = z.object({
  windows: z.boolean(),
  mac: z.boolean(),
  linux: z.boolean()
});
export type GamePlatforms = z.infer<typeof gamePlatformsSchema>;

export const gameDiscoverySchema = z.object({
  score: z.number(),
  signal: z.string().min(1),
  priceText: z.string().optional(),
  originalPriceText: z.string().optional(),
  discountPercent: z.number().int().nonnegative().optional(),
  storeCategory: z.string().optional(),
  storeUrl: z.string().optional(),
  sources: z.array(z.string())
});
export type GameDiscovery = z.infer<typeof gameDiscoverySchema>;

export const shareTypeSchema = z.enum(["owned", "family"]);
export type ShareType = z.infer<typeof shareTypeSchema>;

export const playerModeSchema = z.enum([
  "single_player",
  "multi_player",
  "local_coop",
  "online_coop",
  "local_multiplayer"
]);
export type PlayerMode = z.infer<typeof playerModeSchema>;

/** Map a Steam category description (e.g. "Local Co-op") to one or more normalized player modes. */
export function steamCategoryToPlayerModes(description: string | undefined | null): PlayerMode[] {
  if (!description) return [];
  const value = description.trim().toLocaleLowerCase();
  const modes: PlayerMode[] = [];
  if (value === "single-player" || value === "singleplayer") modes.push("single_player");
  if (value === "multi-player" || value === "multiplayer") modes.push("multi_player");
  if (value === "local co-op" || value === "shared/split screen co-op") modes.push("local_coop");
  if (value === "online co-op") {
    modes.push("online_coop");
    modes.push("multi_player");
  }
  if (value === "co-op") modes.push("multi_player");
  if (value === "local multi-player" || value === "shared/split screen") modes.push("local_multiplayer");
  if (value === "cross-platform multiplayer") modes.push("multi_player");
  return modes;
}

export function playerModesFromSteamCategories(
  categories: ReadonlyArray<{ description?: string | null } | string | null | undefined> | undefined
): PlayerMode[] {
  if (!categories) return [];
  const set = new Set<PlayerMode>();
  for (const entry of categories) {
    const description = typeof entry === "string" ? entry : entry?.description;
    for (const mode of steamCategoryToPlayerModes(description)) {
      set.add(mode);
    }
  }
  return [...set];
}

export const sourceIdentitySchema = z.object({
  provider: providerIdSchema,
  externalId: z.string().min(1),
  shareType: shareTypeSchema.optional(),
  familyOwnerSteamIds: z.array(z.string()).optional(),
  ownerSteamid: z.string().optional()
});
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

export const gameSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sortTitle: z.string().min(1),
  sourceIds: z.array(sourceIdentitySchema),
  installState: installStateSchema,
  installDirectory: z.string().optional(),
  executablePath: z.string().optional(),
  coverUrl: z.string().optional(),
  backgroundUrl: z.string().optional(),
  logoUrl: z.string().optional(),
  communityIconUrl: z.string().optional(),
  libraryCapsuleUrl: z.string().optional(),
  headerUrl: z.string().optional(),
  trailerUrl: z.string().optional(),
  trailerPosterUrl: z.string().optional(),
  screenshots: z.array(gameScreenshotSchema),
  shortDescription: z.string().optional(),
  aboutText: z.string().optional(),
  websiteUrl: z.string().optional(),
  supportUrl: z.string().optional(),
  platforms: gamePlatformsSchema.optional(),
  achievementCount: z.number().int().nonnegative().optional(),
  recommendationCount: z.number().int().nonnegative().optional(),
  contentDescriptors: z.array(z.string()),
  discovery: gameDiscoverySchema.optional(),
  genres: z.array(z.string()),
  tags: z.array(z.string()),
  playerModes: z.array(playerModeSchema).default([]),
  developers: z.array(z.string()),
  publishers: z.array(z.string()),
  releaseDate: z.string().optional(),
  playtimeMinutes: z.number().int().nonnegative().optional(),
  lastPlayedAt: z.string().optional(),
  addedAt: z.string().optional(),
  importedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  metadataStatus: metadataStatusSchema
});
export type Game = z.infer<typeof gameSchema>;

export type ImportedGame = {
  provider: Exclude<ProviderId, "manual" | "igdb">;
  externalId: string;
  title: string;
  installState: InstallState;
  installDirectory?: string;
  executablePath?: string;
  launchCommand?: string;
  playtimeMinutes?: number;
  lastPlayedAt?: string;
  addedAt?: string;
  communityIconUrl?: string;
  shareType?: ShareType;
  familyOwnerSteamIds?: string[];
  ownerSteamid?: string;
};

export type GameMetadataPatch = Partial<
  Pick<
    Game,
    | "title"
    | "sortTitle"
    | "coverUrl"
    | "backgroundUrl"
    | "logoUrl"
    | "communityIconUrl"
    | "libraryCapsuleUrl"
    | "headerUrl"
    | "trailerUrl"
    | "trailerPosterUrl"
    | "screenshots"
    | "shortDescription"
    | "aboutText"
    | "websiteUrl"
    | "supportUrl"
    | "platforms"
    | "achievementCount"
    | "recommendationCount"
    | "contentDescriptors"
    | "discovery"
    | "genres"
    | "tags"
    | "playerModes"
    | "developers"
    | "publishers"
    | "releaseDate"
    | "metadataStatus"
  >
>;

export type GameAssetKind = "grid" | "hero" | "logo" | "icon" | "header" | "poster";
export type GameAssetProvider = "current" | "steam" | "steamgriddb" | "igdb" | "custom";

export type GameAssetCandidate = {
  id: string;
  provider: GameAssetProvider;
  kind: GameAssetKind;
  label: string;
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  score?: number;
  nsfw?: boolean;
  humor?: boolean;
  source?: string;
};

export type GameAssetCandidateResult = {
  candidates: GameAssetCandidate[];
  warnings: string[];
};

export type GameAssetUpdate = Partial<Record<GameAssetKind, string | null>> & {
  title?: string;
};

export type ImporterProvider = {
  id: Exclude<ProviderId, "manual" | "igdb">;
  label: string;
  scan(): Promise<ImportedGame[]>;
  refreshMetadata(game: ImportedGame): Promise<GameMetadataPatch>;
};

export type LibrarySortField = "recent" | "title" | "playtime" | "release" | "added";
export type LibrarySortDirection = "asc" | "desc";
export type LibraryOwnership = "all" | "owned" | "family";
export type LibraryDateFilter = "any" | "recently_added" | "recently_played" | "never_played";

export type LibraryFilters = {
  installState?: InstallState | "all";
  ownership?: LibraryOwnership;
  sources?: ProviderId[];
  genres?: string[];
  tags?: string[];
  playerModes?: PlayerMode[];
  dateFilter?: LibraryDateFilter;
};

export type LibrarySort = {
  field: LibrarySortField;
  direction: LibrarySortDirection;
};

export type LibraryQuery = LibraryFilters & {
  search?: string;
  sort?: LibrarySortField;
  sortDirection?: LibrarySortDirection;
  gameIds?: string[];
};

export type LibraryView = {
  filters: LibraryFilters;
  sort: LibrarySort;
};

export const defaultLibraryView: LibraryView = {
  filters: {
    installState: "all",
    ownership: "all",
    sources: [],
    genres: [],
    tags: [],
    playerModes: [],
    dateFilter: "any"
  },
  sort: { field: "title", direction: "asc" }
};

export type GameGroupKind = "manual" | "smart";

export type ManualGameGroup = {
  id: string;
  kind: "manual";
  name: string;
  gameIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SmartGameGroup = {
  id: string;
  kind: "smart";
  name: string;
  search?: string;
  view: LibraryView;
  createdAt: string;
  updatedAt: string;
};

export type GameGroup = ManualGameGroup | SmartGameGroup;

export type SyncResult = {
  providerId: ProviderId;
  scanned: number;
  upserted: number;
  warnings: string[];
};

export type SyncLogLevel = "info" | "warning" | "error";

export type SyncLogEntry = {
  id: string;
  timestamp: string;
  level: SyncLogLevel;
  phase: string;
  message: string;
  details?: Record<string, unknown>;
};

export type SyncStatus = {
  active: boolean;
  phase: string;
  message: string;
  providerId?: ProviderId;
  startedAt?: string;
  finishedAt?: string;
  lastSuccessAt?: string;
  current?: number;
  total?: number;
  backgroundActive?: boolean;
  backgroundPhase?: string;
  backgroundMessage?: string;
  backgroundCurrent?: number;
  backgroundTotal?: number;
  history: SyncLogEntry[];
};

export type SourceImportInput =
  | { kind: "json"; value: string; url?: string };

export type SourceImportResult = {
  sourceId: string;
  name: string;
  importedEntries: number;
  skippedEntries: number;
};

export type DownloadSourceInfo = {
  id: string;
  name: string;
  url?: string;
  entryCount: number;
  importedAt: string;
  lastFetchedAt?: string;
};

export type SourceMatchConfidence = "high" | "medium" | "low";

export type SourceSearchOptions = {
  limit?: number;
};

export type SourceExactMatch = {
  sourceId: string;
  sourceName: string;
  count: number;
};

export type SourceExactMatchBatch = {
  title: string;
  matches: SourceExactMatch[];
};

export type SourceMatch = {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  fileSize?: string;
  uploadDate?: string;
  uris: string[];
  confidence: SourceMatchConfidence;
  score: number;
};

export type WishlistReleasePrecision = "exact" | "month" | "year" | "unknown";

export type SteamWishlistAccountRef = {
  steamId: string;
  personaName?: string;
  priority?: number;
  addedAt?: string;
};

export type SteamWishlistItem = {
  appid: string;
  title: string;
  sortTitle: string;
  accounts: SteamWishlistAccountRef[];
  coverUrl?: string;
  libraryCapsuleUrl?: string;
  headerUrl?: string;
  backgroundUrl?: string;
  logoUrl?: string;
  communityIconUrl?: string;
  releaseDate?: string;
  releaseDateText?: string;
  releasePrecision: WishlistReleasePrecision;
  sourceMatches: SourceExactMatch[];
  refreshedAt: string;
  metadataStatus: MetadataStatus;
};

export type WishlistViewMode = "list" | "calendar";

export type WishlistSortField = "title" | "release" | "added" | "account";

export type WishlistView = {
  sort: {
    field: WishlistSortField;
    direction: "asc" | "desc";
  };
};

export const defaultWishlistView: WishlistView = {
  sort: {
    field: "added",
    direction: "desc"
  }
};

export type WishlistListQuery = {
  search?: string;
  sort?: WishlistSortField;
  sortDirection?: "asc" | "desc";
  accountSteamIds?: string[];
  sourceAvailability?: "all" | "available" | "missing";
};

export type WishlistCalendarQuery = {
  startDate: string;
  months: number;
  accountSteamIds?: string[];
};

export type GameDetail = Game & {
  sourceMatches: SourceMatch[];
};

export type HomeModel = {
  recentActivity: Game[];
  continuePlaying: Game[];
  mostPlayed: Game[];
  popularNow: Game[];
  recommended: Game[];
  newAndNotable: Game[];
  generatedAt: string;
  stale: boolean;
  cacheVersion?: number;
};

export type HomeModelRowKey =
  | "continuePlaying"
  | "mostPlayed"
  | "popularNow"
  | "recommended"
  | "newAndNotable"
  | "recentActivity";

export type HomeModuleVisual = "hero" | "scroller" | "grid";

export type HomeModuleSource =
  | { kind: "homeModel"; row: HomeModelRowKey }
  | { kind: "wishlist" }
  | { kind: "wishlistUpcoming" }
  | { kind: "neverPlayed" }
  | { kind: "recentlyAdded" }
  | { kind: "installed" }
  | { kind: "random"; count?: number }
  | { kind: "group"; groupId: string };

export type HomeModuleSortField =
  | "default"
  | "title"
  | "playtime"
  | "lastPlayed"
  | "releaseDate"
  | "addedAt"
  | "shuffle";

export type HomeModuleSort = {
  field: HomeModuleSortField;
  direction: "asc" | "desc";
};

export type HomeModuleCardSize = "compact" | "default" | "large";

export type HomeModule = {
  id: string;
  title: string;
  visual: HomeModuleVisual;
  source: HomeModuleSource;
  gridRows?: 1 | 2 | 3 | 4;
  /** Hide the section title above the module body. Hero modules ignore this. */
  hideTitle?: boolean;
  /** Soft cap on the number of items rendered. */
  limit?: number;
  /** Optional override of source ordering. */
  sort?: HomeModuleSort;
  /** Card sizing for scroller and grid visuals. */
  cardSize?: HomeModuleCardSize;
};

export type HomeLayout = {
  modules: HomeModule[];
};

export const defaultHomeLayout: HomeLayout = {
  modules: [
    { id: "default-hero", title: "Popular now", visual: "hero", source: { kind: "homeModel", row: "popularNow" }, hideTitle: true },
    { id: "default-continue", title: "Recently played", visual: "scroller", source: { kind: "homeModel", row: "continuePlaying" } },
    { id: "default-most-played", title: "Most played", visual: "scroller", source: { kind: "homeModel", row: "mostPlayed" } }
  ]
};

export const HOME_MODULE_SOURCE_LABELS: Record<string, string> = {
  "homeModel:continuePlaying": "Recently played",
  "homeModel:mostPlayed": "Most played",
  "homeModel:popularNow": "Popular now",
  "homeModel:recommended": "Recommended",
  "homeModel:newAndNotable": "New & notable",
  "homeModel:recentActivity": "Recent activity",
  "wishlist": "Wishlist",
  "wishlistUpcoming": "Upcoming wishlist",
  "neverPlayed": "Never played",
  "recentlyAdded": "Recently added",
  "installed": "Installed only",
  "random": "Random picks",
  "group": "Group"
};

export function homeModuleSourceKey(source: HomeModuleSource): string {
  if (source.kind === "homeModel") return `homeModel:${source.row}`;
  if (source.kind === "group") return `group:${source.groupId}`;
  return source.kind;
}

export function defaultTitleForSource(
  source: HomeModuleSource,
  groups: ReadonlyArray<{ id: string; name: string }> = []
): string {
  if (source.kind === "group") {
    const found = groups.find((g) => g.id === source.groupId);
    return found?.name ?? "Group";
  }
  return HOME_MODULE_SOURCE_LABELS[homeModuleSourceKey(source)] ?? "Module";
}

export type SteamFamilySession = {
  accessToken: EncryptedSecret;
  steamId: string;
  expiresAt: string;
  connectedAt: string;
};

export type SteamAccountSettings = {
  steamId: string;
  personaName?: string;
  pairedAt: string;
  familySession?: SteamFamilySession;
  /** Local Steam account name (used for HKCU\Software\Valve\Steam\AutoLoginUser when switching). */
  localUsername?: string;
};

export type SteamLaunchAccountOption = {
  steamId: string;
  personaName?: string;
  localUsername?: string;
  kind: "owner" | "family";
};

export function resolveLaunchableSteamAccounts(
  game: Game,
  accounts: SteamAccountSettings[]
): SteamLaunchAccountOption[] {
  const accountById = new Map(accounts.map((account) => [account.steamId, account]));
  const owners = new Map<string, SteamLaunchAccountOption>();
  const family = new Map<string, SteamLaunchAccountOption>();

  function addAccount(account: SteamAccountSettings, kind: "owner" | "family"): void {
    const option: SteamLaunchAccountOption = {
      steamId: account.steamId,
      personaName: account.personaName,
      localUsername: account.localUsername,
      kind
    };
    if (kind === "owner") {
      owners.set(account.steamId, option);
      family.delete(account.steamId);
    } else if (!owners.has(account.steamId)) {
      family.set(account.steamId, option);
    }
  }

  for (const source of game.sourceIds) {
    if (source.provider !== "steam") continue;
    const importer = source.ownerSteamid ? accountById.get(source.ownerSteamid) : undefined;
    if (importer) {
      addAccount(importer, source.shareType === "family" ? "family" : "owner");
    }
    if (source.shareType === "family") {
      for (const ownerSteamId of source.familyOwnerSteamIds ?? []) {
        const owner = accountById.get(ownerSteamId);
        if (owner) addAccount(owner, "owner");
      }
    }
  }

  return [...owners.values(), ...family.values()];
}

export type SteamLocalAccount = {
  steamId: string;
  accountName: string;
  personaName?: string;
  mostRecent: boolean;
  timestamp?: number;
};

export type SteamActiveUser = {
  accountName?: string;
  steamId?: string;
  isRunning: boolean;
};

export type SteamLaunchPlan =
  | { kind: "ready"; targetSteamId?: string }
  | {
      kind: "requires-switch";
      gameId: string;
      gameTitle: string;
      currentAccountName?: string;
      target: { steamId: string; accountName: string; personaName?: string };
    }
  | { kind: "no-account"; reason: string };

export type SteamPairingResult = {
  steamId: string;
  pairedAt: string;
};

export type SteamFamilyAuthResult = {
  accessToken: string;
  steamId: string;
  expiresAt: string;
};

export type SteamStoreEmbedInfo =
  | {
      available: false;
      url: string;
      reason: "no-account";
    }
  | {
      available: true;
      url: string;
      partition: string;
      loggedIn: boolean;
      account: {
        steamId: string;
        personaName?: string;
        hasFamilySession: boolean;
      };
    };

export type LocalRoot = {
  path: string;
  /** 1..3 folder scan depth; onboarding saves new roots with depth 3. */
  depth: number;
};

export type IgdbCredentials = {
  clientId: EncryptedSecret;
  clientSecret: EncryptedSecret;
};

export const soundEffectIds = ["startup", "gameSelect", "gameLaunch", "bigPictureOpen", "navigation"] as const;

export type SoundEffectId = typeof soundEffectIds[number];

export type SoundEffectPlayback = "overlap" | "restart" | "fade";

export type SoundEffectSettings = {
  filePath?: string;
  volume?: number;
  enabled?: boolean;
  playback?: SoundEffectPlayback;
  source?: "bundled" | "custom";
};

export type SoundSettings = {
  masterVolume: number;
  muted?: boolean;
  effects?: Partial<Record<SoundEffectId, SoundEffectSettings>>;
};

export type MusicTrack = {
  filePath: string;
  title?: string;
  artist?: string;
  album?: string;
  copyright?: string;
  source?: "bundled" | "custom";
};

export type MusicSettings = {
  enabled?: boolean;
  volume?: number;
  tracks?: MusicTrack[];
  startupDelayEnabled?: boolean;
  startupDelayMs?: number;
  startupWithSoundEnabled?: boolean;
  startupWithSoundFadeInMs?: number;
  fadesEnabled?: boolean;
  trackFadeInMs?: number;
  pauseFadeOutMs?: number;
  resumeFadeInMs?: number;
  gameLaunchFadeOutMs?: number;
  pauseOnGameLaunch?: boolean;
  pauseOnFocusLoss?: boolean;
  pauseOnSystemAudio?: boolean;
  continuousPlay?: boolean;
  gapMinMs?: number;
  gapMaxMs?: number;
  osts?: OstSettings;
};

export type OstSourceMode = "lastPlayed" | "mostPlayed" | "random" | "favorites";

export type OstSettings = {
  enabled?: boolean;
  source?: OstSourceMode;
  favorites?: string[];
  queryTemplate?: string;
  rotateOnEachTrack?: boolean;
  ytdlpPath?: string | null;
  maxCacheBytes?: number;
  // Filtering / ranking
  filterRejectKeywords?: boolean;       // reject videos whose title contains gameplay/trailer/etc keywords
  preferLongUploads?: boolean;          // bonus longer videos (full albums)
  preferOfficialChannels?: boolean;     // bonus "Topic"/"Official" channels
  requireTitleWordMatch?: boolean;      // require at least one game-title word in the video title
  minDurationSeconds?: number;          // 0 = no minimum
  maxDurationSeconds?: number;          // 0 = no maximum
  customRejectKeywords?: string;        // comma-separated, lowercase substring match
  customBoostKeywords?: string;         // comma-separated, lowercase substring match
  searchResultLimit?: number;           // how many ytsearch results to fetch
  thoroughSearch?: boolean;             // fetch full metadata for each result (slower, includes view counts)
  audioQuality?: "best" | "standard" | "compact" | "low"; // download bitrate trade-off
  bigPictureReactive?: boolean;         // in Big Picture shelf view, follow the focused game's OST and loop it
};

export const DEFAULT_OST_SETTINGS: Required<Omit<OstSettings, "ytdlpPath">> & { ytdlpPath: string | null } = {
  enabled: false,
  source: "lastPlayed",
  favorites: [],
  queryTemplate: "{title} Game Original Soundtrack",
  rotateOnEachTrack: false,
  ytdlpPath: null,
  maxCacheBytes: 5 * 1024 * 1024 * 1024,
  filterRejectKeywords: false,
  preferLongUploads: false,
  preferOfficialChannels: true,
  requireTitleWordMatch: false,
  minDurationSeconds: 0,
  maxDurationSeconds: 0,
  customRejectKeywords: "",
  customBoostKeywords: "",
  searchResultLimit: 8,
  thoroughSearch: false,
  audioQuality: "low",
  bigPictureReactive: true
};

export type GameSoundtrack = {
  gameId: string;
  videoId: string;
  videoUrl: string;
  videoTitle?: string;
  channel?: string;
  durationSeconds?: number;
  localFilePath?: string;
  fileSizeBytes?: number;
  isManual: boolean;
  pickedAt: string;
  lastPlayedAt?: string;
};

export type YoutubeSearchResult = {
  videoId: string;
  url: string;
  title: string;
  channel?: string;
  durationSeconds?: number;
  viewCount?: number;
};

export type OstDownloadProgress = {
  gameId: string;
  videoId: string;
  phase: "searching" | "downloading" | "ready" | "error" | "diagnostic";
  percent?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  message?: string;
};

export type YtdlpStatus = {
  installed: boolean;
  path?: string;
  version?: string;
  installing?: boolean;
  error?: string;
};

export type OstResolveResult =
  | { kind: "ready"; gameId: string; gameTitle: string; soundtrack: GameSoundtrack }
  | { kind: "no-game"; reason: string }
  | { kind: "no-pick"; gameId: string; gameTitle: string; reason: string }
  | { kind: "error"; gameId?: string; gameTitle?: string; reason: string };

export type OstScoredResult = YoutubeSearchResult & {
  score: number;
  rejected: boolean;
  rejectReason?: string;
};

export type OstSearchPreview = {
  query: string;
  results: OstScoredResult[];
};

export type OnboardingSettings = {
  version: 1;
  completedAt?: string;
  skippedAt?: string;
};

export type OnboardingState = {
  shouldShow: boolean;
  firstRun: boolean;
  preview: boolean;
  completedAt?: string;
};

export type SpotlightSettings = {
  enabled: boolean;
  hotkey: string;
};

export type SpotlightGame = {
  id: string;
  title: string;
  sortTitle: string;
  installState: InstallState;
  launchable: boolean;
  iconUrl?: string;
  logoUrl?: string;
  activityAt?: string;
  ownership: LibraryOwnership;
  sourceLabels: ProviderId[];
};

export type SpotlightGameResult = SpotlightGame & {
  kind: "game";
  score: number;
  matchRanges?: Array<{ start: number; end: number }>;
};

export type SpotlightCommand =
  | { type: "music-toggle-mute" }
  | { type: "music-play-pause" }
  | { type: "music-skip" }
  | { type: "steam-switch"; steamId: string; accountName: string; personaName?: string };

export type SpotlightCommandIcon = "mute" | "play-pause" | "skip" | "steam";

export type SpotlightCommandResult = {
  kind: "command";
  id: string;
  title: string;
  subtitle?: string;
  icon: SpotlightCommandIcon;
  score: number;
  matchRanges?: Array<{ start: number; end: number }>;
  command: SpotlightCommand;
};

export type SpotlightSearchResult = SpotlightGameResult | SpotlightCommandResult;

export type SpotlightSearchOptions = {
  limit?: number;
  offset?: number;
};

export type SpotlightState = {
  enabled: boolean;
  hotkey: string;
  registered: boolean;
  registrationError?: string;
};

export type SpotlightPendingAction =
  | { kind: "details"; gameId: string }
  | { kind: "launch"; gameId: string };

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowState = {
  bounds?: WindowBounds;
  displayId?: number;
  isMaximized?: boolean;
};

export const controllerActionIds = [
  "focusBigPicture",
  "exitBigPicture",
  "moveUp",
  "moveDown",
  "moveLeft",
  "moveRight",
  "previousGroup",
  "nextGroup",
  "play",
  "details",
  "filters",
  "back",
  "toggleGrid",
  "favoriteTab"
] as const;

export type ControllerActionId = typeof controllerActionIds[number];

export type ControllerButtonBinding = {
  buttons: number[];
};

export type ControllerSettings = {
  enabled: boolean;
  backgroundInput: boolean;
  bindings: Partial<Record<ControllerActionId, ControllerButtonBinding>>;
};

export type BackgroundWorkload = "minimum" | "balanced" | "max";

export type AppSettings = {
  steamAccounts: SteamAccountSettings[];
  /** Single Steam Web API key shared by every paired account (one key fetches any public profile). */
  steamWebApiKey?: EncryptedSecret;
  steamGridDbApiKey?: EncryptedSecret;
  cacheTtlHours: number;
  reduceMotion: boolean;
  /** Shows a game launch handoff before minimizing Hynite after successful launches. */
  autoHideAfterLaunch: boolean;
  /** Register packaged Windows app to start as tray-only background host at user login. */
  startWithWindows: boolean;
  /** Close/destroy renderer to tray instead of quitting the main process. */
  closeToTray: boolean;
  /** Allows scheduled background sync/activity work while Hynite is in tray. */
  backgroundUpdatesEnabled: boolean;
  /** Controls how much scheduled tray work Hynite performs. */
  backgroundWorkload: BackgroundWorkload;
  /** Tracks known local game executables while Hynite is in the background. */
  backgroundPlaytimeTracking: boolean;
  /** Sends scrubbed crash/error reports to the self-hosted diagnostics server. */
  crashReportingEnabled: boolean;
  /** Target number of game cards shown across Home rows and Library grid at desktop widths. */
  cardsPerRow?: number;
  libraryView?: LibraryView;
  /** Wishlist list filters/sort persisted separately from Library ownership. */
  wishlistView?: WishlistView;
  /** Per-game preferred paired Steam account used when launching from details/library/recent. */
  launchAccountPreferences?: Record<string, string>;
  /** User-defined library groups. Manual groups pin game ids; smart groups store a library filter view. */
  gameGroups?: GameGroup[];
  /** Folders scanned for non-Steam local games. */
  localRoots?: LocalRoot[];
  /** Folder-name regex patterns to skip during local scan. Falls back to defaults if undefined. */
  localExcludePatterns?: string[];
  /** Folder paths the user has explicitly chosen to ignore (won't be re-imported on scan). */
  localIgnoredPaths?: string[];
  /** Twitch app credentials for IGDB metadata (client-credentials OAuth). */
  igdb?: IgdbCredentials;
  /** Local UI sound effects decoded by the renderer and served through main's sound protocol. */
  sound?: SoundSettings;
  /** Background music tracks played during launcher use. */
  music?: MusicSettings;
  /** First-run onboarding completion marker. Absence alone does not force existing users through onboarding. */
  onboarding?: OnboardingSettings;
  /** Last normal window placement restored by the Electron main process on startup. */
  windowState?: WindowState;
  /** Big Picture controller navigation and background focus shortcut bindings. */
  controller?: ControllerSettings;
  /** Global local-only command palette for launching/opening library games. */
  spotlight?: SpotlightSettings;
  /** Tab ID to open by default when entering Big Picture mode. */
  bigPictureDefaultTabId?: string;
  /** Grayscale non-focused game covers in Big Picture shelf mode. */
  bigPictureGrayscaleCovers?: boolean;
  /** User-defined modular layout for the home page. When absent, the default layout is used. */
  home?: HomeLayout;
};

export type SettingsBackupInfo = {
  id: string;
  createdAt: string;
  fileName: string;
  restoreCommand: string;
};

export type SettingsHealthWarning = {
  kind: "clean-slate-reset";
  message: string;
  backups: SettingsBackupInfo[];
};

export type ExecutableInfo = {
  path: string;
  exists: boolean;
};

export type LaunchGameRequest = {
  gameId: string;
  provider: ProviderId;
  externalId: string;
  command?: string;
  executablePath?: string;
  workingDirectory?: string;
};

export type LaunchSession = {
  id: string;
  pid?: number;
  startedAt: string;
};

export type ProcessEvent = {
  pid: number;
  type: "started" | "exited";
  exitCode?: number;
};

export type SteamSearchResult = {
  appId: string;
  title: string;
  capsuleUrl: string;
  price?: string;
  reviewSummary?: string;
  releaseDate?: string;
};

export type SecretInput = {
  value: string;
  scope: "current-user";
};

export type EncryptedSecret = {
  cipherText: string;
  scope: "current-user";
};

export function makeGameId(provider: ProviderId, externalId: string): string {
  return `${provider}:${externalId}`;
}

export function makeSortTitle(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, "").toLocaleLowerCase();
}

export function gameActivityTime(game: Pick<Game, "lastPlayedAt" | "addedAt">): number {
  return Math.max(Date.parse(game.lastPlayedAt ?? "") || 0, Date.parse(game.addedAt ?? "") || 0);
}
