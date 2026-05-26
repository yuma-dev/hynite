import type {
  SpotlightCommand,
  SpotlightCommandIcon,
  SpotlightCommandResult,
  SpotlightGame,
  SpotlightGameResult,
  SpotlightSearchOptions,
  SpotlightSearchResult
} from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";

type IndexedSpotlightGame = SpotlightGame & {
  normalizedTitle: string;
  normalizedTokens: string[];
};

type CommandDescriptor = {
  id: string;
  title: string;
  subtitle?: string;
  icon: SpotlightCommandIcon;
  keywords: string[];
  command: SpotlightCommand;
};

export type SpotlightSteamAccount = {
  steamId: string;
  accountName: string;
  personaName?: string;
};

export type SpotlightCommandContext = {
  steamAccounts: SpotlightSteamAccount[];
  activeSteamId?: string;
};

const RESULT_LIMIT = 30;
const MAX_RESULT_LIMIT = 200;

export function normalizeSpotlightText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
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

function scoreKeywords(keywords: string[], normalizedQuery: string): number {
  if (!normalizedQuery) return 0;
  let best = 0;
  for (const keyword of keywords) {
    const normalized = normalizeSpotlightText(keyword);
    if (!normalized) continue;
    if (normalized === normalizedQuery) best = Math.max(best, 950);
    else if (normalized.startsWith(normalizedQuery)) best = Math.max(best, 850);
    else if (normalized.includes(normalizedQuery)) best = Math.max(best, 700);
  }
  return best;
}

function activityTime(game: SpotlightGame): number {
  return Date.parse(game.activityAt ?? "") || 0;
}

function compareGames(a: SpotlightGame, b: SpotlightGame): number {
  const activity = activityTime(b) - activityTime(a);
  return activity || a.sortTitle.localeCompare(b.sortTitle);
}

function compareResults(a: SpotlightSearchResult, b: SpotlightSearchResult): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.kind === "game" && b.kind === "game") return compareGames(a, b);
  if (a.kind === "command" && b.kind === "command") return a.title.localeCompare(b.title);
  return a.kind === "game" ? -1 : 1;
}

const STATIC_MUSIC_COMMANDS: CommandDescriptor[] = [
  {
    id: "command:music-toggle-mute",
    title: "Toggle mute",
    subtitle: "Music",
    icon: "mute",
    keywords: ["mute", "unmute", "music", "silence"],
    command: { type: "music-toggle-mute" }
  },
  {
    id: "command:music-play-pause",
    title: "Play / Pause music",
    subtitle: "Music",
    icon: "play-pause",
    keywords: ["pause", "play", "resume", "music"],
    command: { type: "music-play-pause" }
  },
  {
    id: "command:music-skip",
    title: "Skip music track",
    subtitle: "Music",
    icon: "skip",
    keywords: ["skip", "next", "track", "song", "music", "ost"],
    command: { type: "music-skip" }
  }
];

export class SpotlightService {
  private index: IndexedSpotlightGame[] | undefined;
  private commandContext: SpotlightCommandContext = { steamAccounts: [] };

  constructor(private readonly repository: HyniteRepository) {}

  setCommandContext(context: SpotlightCommandContext): void {
    this.commandContext = context;
  }

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

  private buildCommandDescriptors(): CommandDescriptor[] {
    const list: CommandDescriptor[] = [...STATIC_MUSIC_COMMANDS];
    const { steamAccounts, activeSteamId } = this.commandContext;
    for (const account of steamAccounts) {
      if (!account.accountName) continue;
      if (activeSteamId && account.steamId === activeSteamId) continue;
      const display = account.personaName?.trim() || account.accountName;
      list.push({
        id: `command:steam-switch:${account.steamId}`,
        title: `Switch Steam account to ${display}`,
        subtitle: account.personaName && account.personaName !== account.accountName
          ? `Steam · ${account.accountName}`
          : "Steam account",
        icon: "steam",
        keywords: ["switch", "account", "steam", "login", display, account.accountName],
        command: { type: "steam-switch", steamId: account.steamId, accountName: account.accountName, personaName: account.personaName }
      });
    }
    return list;
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
      const sorted = [...games].sort(compareGames);
      return sorted.slice(offset, offset + limit).map((game): SpotlightGameResult => {
        const { normalizedTitle: _normalizedTitle, normalizedTokens: _normalizedTokens, ...rest } = game;
        return { kind: "game", ...rest, score: 1 };
      });
    }

    const gameResults = games.flatMap((game): SpotlightGameResult[] => {
      const score = scoreGame(game, normalizedQuery);
      if (score <= 0) return [];
      return [{
        kind: "game",
        id: game.id,
        title: game.title,
        sortTitle: game.sortTitle,
        installState: game.installState,
        launchable: game.launchable,
        iconUrl: game.iconUrl,
        logoUrl: game.logoUrl,
        ownership: game.ownership,
        sourceLabels: game.sourceLabels,
        activityAt: game.activityAt,
        score,
        matchRanges: titleMatchRange(game.title, query)
      }];
    });

    const commandResults = this.buildCommandDescriptors().flatMap((descriptor): SpotlightCommandResult[] => {
      const score = scoreKeywords(descriptor.keywords, normalizedQuery);
      if (score <= 0) return [];
      return [{
        kind: "command",
        id: descriptor.id,
        title: descriptor.title,
        subtitle: descriptor.subtitle,
        icon: descriptor.icon,
        score,
        matchRanges: titleMatchRange(descriptor.title, query),
        command: descriptor.command
      }];
    });

    return [...gameResults, ...commandResults]
      .sort(compareResults)
      .slice(offset, offset + limit);
  }
}
