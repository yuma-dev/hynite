import type { Game, SourceMatch, SourceMatchConfidence } from "@hynite/core";
import { normalizeTitle } from "./normalize";

export type SearchableDownloadEntry = {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  normalizedTitle: string;
  fileSize?: string;
  uploadDate?: string;
  uris: string[];
};

function levenshtein(a: string, b: string): number {
  // Early exit for very different lengths — distance can't be < |len_a - len_b|
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) {
    return Math.max(a.length, b.length);
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost
      );
    }
  }

  return matrix[a.length]![b.length]!;
}

function scoreTitles(gameTitle: string, entryTitle: string): number {
  const game = normalizeTitle(gameTitle);
  const entry = normalizeTitle(entryTitle);
  if (!game || !entry) {
    return 0;
  }
  if (game === entry) {
    return 1;
  }

  // Substring containment (fast path — no allocation)
  if (entry.includes(game) || game.includes(entry)) {
    return 0.9;
  }

  // Word-set containment: all significant game words appear in the entry
  const gameWords = game.split(" ").filter((w) => w.length >= 2);
  if (gameWords.length > 0) {
    const entryWords = new Set(entry.split(" "));
    const matched = gameWords.filter((w) => entryWords.has(w)).length;
    const fraction = matched / gameWords.length;
    if (fraction === 1) {
      return 0.88;
    }
    if (fraction >= 0.75) {
      return fraction * 0.82;
    }
  }

  // Levenshtein as fallback for fuzzy catches (typos, minor variations)
  const distance = levenshtein(game, entry);
  const longest = Math.max(game.length, entry.length);
  return Math.max(0, 1 - distance / longest);
}

function confidenceFor(score: number): SourceMatchConfidence {
  if (score >= 0.88) {
    return "high";
  }
  if (score >= 0.7) {
    return "medium";
  }
  return "low";
}

function uploadTime(value?: string): number {
  if (!value) {
    return 0;
  }
  return Date.parse(value) || 0;
}

export function findSourceMatches(game: Game, entries: SearchableDownloadEntry[], limit = 20): SourceMatch[] {
  return entries
    .map((entry) => {
      const score = scoreTitles(game.title, entry.title);
      return {
        id: entry.id,
        sourceId: entry.sourceId,
        sourceName: entry.sourceName,
        title: entry.title,
        fileSize: entry.fileSize,
        uploadDate: entry.uploadDate,
        uris: entry.uris,
        confidence: confidenceFor(score),
        score
      } satisfies SourceMatch;
    })
    .filter((match) => match.score >= 0.58)
    .sort((a, b) => uploadTime(b.uploadDate) - uploadTime(a.uploadDate) || b.score - a.score || a.sourceName.localeCompare(b.sourceName) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export { normalizeTitle };
