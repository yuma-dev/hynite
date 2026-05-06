import { z } from "zod";

export const providerIdSchema = z.enum(["steam", "epic", "gog", "manual"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const installStateSchema = z.enum(["installed", "not_installed", "unknown"]);
export type InstallState = z.infer<typeof installStateSchema>;

export const metadataStatusSchema = z.enum(["none", "partial", "complete", "failed"]);
export type MetadataStatus = z.infer<typeof metadataStatusSchema>;

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
  genres: z.array(z.string()),
  tags: z.array(z.string()),
  developers: z.array(z.string()),
  publishers: z.array(z.string()),
  releaseDate: z.string().optional(),
  playtimeMinutes: z.number().int().nonnegative().optional(),
  lastPlayedAt: z.string().optional(),
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
};

export type GameMetadataPatch = Partial<
  Pick<
    Game,
    | "coverUrl"
    | "backgroundUrl"
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
};

export type SyncResult = {
  providerId: ProviderId;
  scanned: number;
  upserted: number;
  warnings: string[];
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

export type HomeModel = {
  continuePlaying: Game[];
  popularNow: Game[];
  recommended: Game[];
  newAndNotable: Game[];
  generatedAt: string;
  stale: boolean;
};

export type AppSettings = {
  steamLibraryRoots: string[];
  cacheTtlHours: number;
  reduceMotion: boolean;
};

export type SteamInstallLocation = {
  path: string;
  source: "registry" | "common-path" | "manual";
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

