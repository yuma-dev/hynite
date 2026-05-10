import type { ExeFileInfo, IdentifyCandidate, IdentifyResult, LocalGameCandidate } from "./types";

/**
 * Strip release-group / repack / version markers from a folder or product name
 * before fuzzy-searching catalogues.
 */
export function normalizeTitle(raw: string): string {
  let value = raw;

  // [FitGirl Repack], [DODI Repack], [GOG], [Bonus] etc.
  value = value.replace(/\[[^\]]*\]/g, " ");
  // (v1.2.3), (Update 5), (Build 12345)
  value = value.replace(/\((?:v|build|update|patch|rev|hotfix)[^)]*\)/gi, " ");
  // (2017), (2024)
  value = value.replace(/\(\s*(\d{4})\s*\)/g, " ");
  // Bare version suffix: .v1.2.3, .v10.12.2023, _v2.0, etc. Anchored at end OR before a space.
  value = value.replace(/[._-]v\d+(?:[._]\d+)*(?=\s|$)/gi, " ");
  // Trailing scene/repack group: -CODEX, -OFME, -FLT, -SKIDROW, etc. — case-insensitive, may have digits.
  value = value.replace(
    /\s*[-_]\s*(CODEX|RUNE|FLT|SKIDROW|PLAZA|EMPRESS|RAZOR1911|RELOADED|TENOKE|GOLDBERG|HOODLUM|DARKSiDERS|RAZOR|FCKDRM|0xdeadc0de|FAIRLIGHT|TiNYiSO|P2P|ANOMALY|CPY|REPACK|OFME|ONLINE|ONLINEFIX)+\s*$/gi,
    ""
  );
  // Standalone "Online Fix" / "OnlineFix" markers.
  value = value.replace(/\b(?:online[ _-]?fix|repack)\b/gi, " ");
  // Replace dot/underscore separators with spaces, collapse runs.
  value = value.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return value;
}

/** Split CamelCase / PascalCase tokens. "EnterTheGungeon" → "Enter The Gungeon". */
function splitCamelCase(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

export function extractYearHint(raw: string): number | undefined {
  const match = raw.match(/\b(19[7-9]\d|20[0-4]\d)\b/);
  return match ? Number(match[1]) : undefined;
}

export type SteamSearchProvider = (query: string) => Promise<IdentifyCandidate[]>;
export type IgdbSearchProvider = (query: string) => Promise<IdentifyCandidate[]>;
export type IgdbExternalLookup = (
  externalId: string,
  category: "gog" | "steam"
) => Promise<IdentifyCandidate | undefined>;

export type IdentifyOptions = {
  steamSearch?: SteamSearchProvider;
  igdbSearch?: IgdbSearchProvider;
  igdbExternalLookup?: IgdbExternalLookup;
};

const AUTO_ACCEPT_THRESHOLD = 0.85;
const NEEDS_REVIEW_THRESHOLD = 0.6;

function scoreCandidate(
  candidate: IdentifyCandidate,
  query: { title: string; productName?: string; yearHint?: number },
  rank: number
): number {
  const titleSim = Math.max(
    tokenJaccard(candidate.title, query.title),
    query.productName ? tokenJaccard(candidate.title, query.productName) : 0
  );
  let score = titleSim;

  if (query.yearHint && candidate.releaseDate) {
    const candYear = Number(candidate.releaseDate.slice(0, 4));
    if (Number.isFinite(candYear)) {
      if (candYear === query.yearHint) score += 0.1;
      else if (Math.abs(candYear - query.yearHint) <= 1) score += 0.05;
      else score -= 0.05;
    }
  }

  // Rank in the search response is a popularity proxy.
  score -= rank * 0.02;

  // Penalise DLC / soundtrack / expansion candidates when the folder doesn't ask for them.
  const folderHints = `${query.title} ${query.productName ?? ""}`.toLowerCase();
  const candidateLower = candidate.title.toLowerCase();
  const dlcMarkers = ["soundtrack", "ost", "dlc", "season pass", "expansion", "bonus", "deluxe edition", "art book"];
  for (const marker of dlcMarkers) {
    if (candidateLower.includes(marker) && !folderHints.includes(marker)) {
      score -= 0.3;
      break;
    }
  }

  return Math.max(0, Math.min(1, score));
}

function tokenJaccard(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}

function tokenize(value: string): string[] {
  return splitCamelCase(value)
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

export async function identifyCandidate(
  candidate: LocalGameCandidate,
  chosenExe: ExeFileInfo | undefined,
  options: IdentifyOptions
): Promise<IdentifyResult> {
  // 1. Steam appid.txt — direct hit.
  if (candidate.siblingMarkers.steamAppidTxt) {
    return {
      kind: "match",
      match: {
        provider: "steam",
        externalId: candidate.siblingMarkers.steamAppidTxt.appid,
        title: chosenExe?.productName ?? candidate.folderName,
        confidence: 1,
        reason: "steam_appid_txt"
      }
    };
  }

  // 2. Steam appmanifest .acf inside folder.
  if (candidate.siblingMarkers.steamAppManifestAppid) {
    return {
      kind: "match",
      match: {
        provider: "steam",
        externalId: candidate.siblingMarkers.steamAppManifestAppid,
        title: chosenExe?.productName ?? candidate.folderName,
        confidence: 1,
        reason: "steam_appmanifest"
      }
    };
  }

  // 3. GOG manifest → IGDB external lookup.
  if (candidate.siblingMarkers.gogManifests?.length && options.igdbExternalLookup) {
    for (const manifest of candidate.siblingMarkers.gogManifests) {
      const match = await safeCall(() => options.igdbExternalLookup!(manifest.gameId, "gog"));
      if (match) {
        return {
          kind: "match",
          match: { ...match, confidence: 0.95, reason: "gog_manifest" }
        };
      }
    }
  }

  // 4. Search waterfall.
  const normalizedFolder = normalizeTitle(candidate.folderName);
  const yearHint = extractYearHint(candidate.folderName);
  const productName = chosenExe?.productName ? normalizeTitle(chosenExe.productName) : undefined;

  const queries = [productName, normalizedFolder].filter((value): value is string => Boolean(value && value.length >= 2));

  const merged = new Map<string, IdentifyCandidate & { _score: number }>();
  for (const query of queries) {
    const [steamResults, igdbResults] = await Promise.all([
      options.steamSearch ? safeCall(() => options.steamSearch!(query)).then((value) => value ?? []) : Promise.resolve([]),
      options.igdbSearch ? safeCall(() => options.igdbSearch!(query)).then((value) => value ?? []) : Promise.resolve([])
    ]);

    [...steamResults, ...igdbResults].forEach((candidateMatch, rank) => {
      const score = scoreCandidate(candidateMatch, { title: query, productName, yearHint }, rank);
      const key = `${candidateMatch.provider}:${candidateMatch.externalId}`;
      const prior = merged.get(key);
      if (!prior || prior._score < score) {
        merged.set(key, { ...candidateMatch, _score: score, confidence: score });
      }
    });
  }

  const ranked = [...merged.values()].sort((a, b) => b._score - a._score);
  const top = ranked[0];
  if (!top) {
    return { kind: "unmatched", reason: "no_search_results" };
  }

  if (top._score >= NEEDS_REVIEW_THRESHOLD) {
    return {
      kind: "match",
      match: stripScore(top)
    };
  }

  return {
    kind: "ambiguous",
    candidates: ranked.slice(0, 5).map((entry) => stripScore(entry)),
    topConfidence: top._score
  };
}

function stripScore(value: IdentifyCandidate & { _score: number }): IdentifyCandidate {
  const { _score, ...rest } = value;
  void _score;
  return rest;
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    console.warn("Local importer search call failed", error);
    return undefined;
  }
}
