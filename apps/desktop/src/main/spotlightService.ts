import type { SpotlightGame, SpotlightSearchOptions, SpotlightSearchResult } from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";

type IndexedSpotlightGame = SpotlightGame & {
  normalizedTitle: string;
  normalizedTokens: string[];
};

const RESULT_LIMIT = 30;
const MAX_RESULT_LIMIT = 200;

export function normalizeSpotlightText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleMatchRange(title: string, query: string): Array<{ start: number; end: number }> | undefined {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const index = title.toLocaleLowerCase().indexOf(needle);
  return index >= 0 ? [{ start: index, end: index + needle.length }] : undefined;
}

function scoreGame(game: IndexedSpotlightGame, normalizedQuery: string): number {
  if (!normalizedQuery) return 1;
  if (game.normalizedTitle === normalizedQuery) return 1000;
  if (game.normalizedTitle.startsWith(normalizedQuery)) return 900;
  if (game.normalizedTokens.some((token) => token === normalizedQuery)) return 850;
  if (game.normalizedTokens.some((token) => token.startsWith(normalizedQuery))) return 800;
  if (game.normalizedTitle.includes(normalizedQuery)) return 700;

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  if (queryTokens.length > 1 && queryTokens.every((token) => game.normalizedTitle.includes(token))) {
    return 600;
  }
  return 0;
}

function activityTime(game: SpotlightGame): number {
  return Date.parse(game.activityAt ?? "") || 0;
}

function compareSpotlightGames(a: SpotlightGame, b: SpotlightGame): number {
  const activity = activityTime(b) - activityTime(a);
  return activity || a.sortTitle.localeCompare(b.sortTitle);
}

export class SpotlightService {
  private index: IndexedSpotlightGame[] | undefined;

  constructor(private readonly repository: HyniteRepository) {}

  refresh(): void {
    this.index = this.repository.listSpotlightGames().map((game) => {
      const normalizedTitle = normalizeSpotlightText(game.title);
      return {
        ...game,
        normalizedTitle,
        normalizedTokens: normalizedTitle.split(" ").filter(Boolean)
      };
    });
  }

  search(query: string, options: SpotlightSearchOptions = {}): SpotlightSearchResult[] {
    if (!this.index) {
      this.refresh();
    }
    const offset = Math.max(0, Math.round(options.offset ?? 0));
    const limit = Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.round(options.limit ?? RESULT_LIMIT)));
    const normalizedQuery = normalizeSpotlightText(query);
    const games = this.index ?? [];
    if (!normalizedQuery) {
      return [...games].sort(compareSpotlightGames).slice(offset, offset + limit).map((game) => {
        const { normalizedTitle: _normalizedTitle, normalizedTokens: _normalizedTokens, ...result } = game;
        return { ...result, score: 1 };
      });
    }

    return games
      .flatMap((game): SpotlightSearchResult[] => {
        const score = scoreGame(game, normalizedQuery);
        if (score <= 0) return [];
        return [{
          id: game.id,
          title: game.title,
          sortTitle: game.sortTitle,
          installState: game.installState,
          launchable: game.launchable,
          iconUrl: game.iconUrl,
          sourceLabels: game.sourceLabels,
          score,
          matchRanges: titleMatchRange(game.title, query)
        }];
      })
      .sort((a, b) => b.score - a.score || compareSpotlightGames(a, b))
      .slice(offset, offset + limit);
  }
}
