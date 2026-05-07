import { z } from "zod";

export const providerIdSchema = z.enum(["steam", "epic", "gog", "manual"]);
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
  ccu: z.number().int().nonnegative().optional(),
  owners: z.string().optional(),
  reviewScore: z.number().optional(),
  rankDelta: z.number().optional(),
  priceText: z.string().optional(),
  originalPriceText: z.string().optional(),
  discountPercent: z.number().int().nonnegative().optional(),
  storeCategory: z.string().optional(),
  storeUrl: z.string().optional(),
  sources: z.array(z.string())
});
export type GameDiscovery = z.infer<typeof gameDiscoverySchema>;

export const sourceIdentitySchema = z.object({
  provider: providerIdSchema,
  externalId: z.string().min(1)
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
  provider: Exclude<ProviderId, "manual">;
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
};

export type GameMetadataPatch = Partial<
  Pick<
    Game,
    | "title"
    | "sortTitle"
    | "coverUrl"
    | "backgroundUrl"
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
    | "developers"
    | "publishers"
    | "releaseDate"
    | "metadataStatus"
  >
>;

export type ImporterProvider = {
  id: Exclude<ProviderId, "manual">;
  label: string;
  scan(): Promise<ImportedGame[]>;
  refreshMetadata(game: ImportedGame): Promise<GameMetadataPatch>;
};

export type LibraryQuery = {
  search?: string;
  installState?: InstallState | "all";
  sort?: "recent" | "title" | "playtime" | "release";
  sortDirection?: "asc" | "desc";
};

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
  | { kind: "json"; value: string }
  | { kind: "url"; value: string };

export type SourceImportResult = {
  sourceId: string;
  name: string;
  importedEntries: number;
  skippedEntries: number;
};

export type SourceMatchConfidence = "high" | "medium" | "low";

export type SourceMatch = {
  id: string;
  sourceName: string;
  title: string;
  fileSize?: string;
  uploadDate?: string;
  uris: string[];
  confidence: SourceMatchConfidence;
  score: number;
};

export type GameDetail = Game & {
  sourceMatches: SourceMatch[];
};

export type HomeTrendRow = {
  id: string;
  title: string;
  description: string;
  games: Game[];
};

export type HomeModel = {
  recentActivity: Game[];
  continuePlaying: Game[];
  mostPlayed: Game[];
  popularNow: Game[];
  recommended: Game[];
  newAndNotable: Game[];
  trendingRows: HomeTrendRow[];
  generatedAt: string;
  stale: boolean;
};

export type SteamAccountSettings = {
  steamId: string;
  personaName?: string;
  pairedAt: string;
  webApiKey?: EncryptedSecret;
};

export type SteamPairingResult = {
  steamId: string;
  pairedAt: string;
};

export type AppSettings = {
  steamAccount?: SteamAccountSettings;
  steamGridDbApiKey?: EncryptedSecret;
  cacheTtlHours: number;
  reduceMotion: boolean;
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
