export type LocalRootConfig = {
  path: string;
  /** How many directory levels deep to enumerate as candidate games. 1 = subfolders of root. */
  depth: number;
};

export type LocalScanConfig = {
  roots: LocalRootConfig[];
  /** Folder name regex patterns to skip (e.g. ^_redist$, ^Tools$). */
  excludePatterns: string[];
  /** Absolute folder paths the user has chosen to ignore. */
  ignoredPaths?: string[];
};

export type SiblingMarkers = {
  steamAppidTxt?: { path: string; appid: string };
  gogManifests?: Array<{ path: string; gameId: string }>;
  steamApi64Dll?: string;
  steamEmuIni?: string;
  steamAppManifestAppid?: string;
};

export type LocalGameCandidate = {
  /** Stable identity for this candidate (hash of folder path). */
  id: string;
  folderPath: string;
  folderName: string;
  /** All exe paths discovered (after hard-exclude). Capped. */
  exeFiles: string[];
  siblingMarkers: SiblingMarkers;
  /** Folder mtime in ms — used by the rescan cache to skip unchanged folders. */
  mtimeMs: number;
  /** Filesystem birth time in ms for the candidate at this path; used as provider added activity. */
  addedAtMs?: number;
};

export type ExeFileInfo = {
  path: string;
  size: number;
  productName?: string;
  fileDescription?: string;
  companyName?: string;
};

export type ExeSelection = {
  chosen: ExeFileInfo;
  score: number;
  ambiguous: boolean;
  runnerUp?: { exe: ExeFileInfo; score: number };
  scored: Array<{ exe: ExeFileInfo; score: number; reasons: string[] }>;
};

export type IdentifyMatch = {
  provider: "steam" | "igdb";
  externalId: string;
  title: string;
  confidence: number;
  reason: "steam_appid_txt" | "gog_manifest" | "steam_appmanifest" | "search";
  releaseDate?: string;
};

export type IdentifyCandidate = IdentifyMatch & {
  coverUrl?: string;
  developer?: string;
};

export type IdentifyResult =
  | { kind: "match"; match: IdentifyMatch }
  | { kind: "ambiguous"; candidates: IdentifyCandidate[]; topConfidence: number }
  | { kind: "unmatched"; reason: string };

export type LocalScanCacheEntry = {
  folderPath: string;
  mtimeMs: number;
  candidateId: string;
};

export type LocalScanCache = {
  entries: Record<string, LocalScanCacheEntry>;
};
