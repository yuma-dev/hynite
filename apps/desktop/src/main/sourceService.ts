import { createHash } from "node:crypto";
import type { DownloadSourceInfo, SourceExactMatch, SourceImportInput, SourceImportResult, SourceMatch, SourceSearchOptions } from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";
import { findSourceMatches, normalizeTitle, prepareSourceImport } from "@hynite/source-search";

function sourceIdFromUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function searchWords(title: string): string[] {
  return normalizeTitle(title)
    .split(" ")
    .filter((w) => w.length >= 3);
}

function searchLimit(options?: SourceSearchOptions): number {
  return Math.max(1, Math.min(options?.limit ?? 300, 1_000));
}

export class SourceService {
  constructor(private readonly repository: HyniteRepository) {}

  async import(input: SourceImportInput): Promise<SourceImportResult> {
    const stableId = input.url ? sourceIdFromUrl(input.url) : undefined;
    const prepared = prepareSourceImport(input.value, stableId);
    this.repository.saveDownloadSource({ ...prepared, url: input.url });
    return {
      sourceId: prepared.id,
      name: prepared.name,
      importedEntries: prepared.importedEntries,
      skippedEntries: prepared.skippedEntries
    };
  }

  list(): DownloadSourceInfo[] {
    return this.repository.listSources();
  }

  remove(id: string): void {
    this.repository.removeSource(id);
  }

  refreshSource(id: string, json: string): SourceImportResult {
    const source = this.repository.listSources().find((s) => s.id === id);
    const prepared = prepareSourceImport(json, id);
    this.repository.saveDownloadSource({ ...prepared, url: source?.url });
    return {
      sourceId: prepared.id,
      name: prepared.name,
      importedEntries: prepared.importedEntries,
      skippedEntries: prepared.skippedEntries
    };
  }

  search(gameId: string, options?: SourceSearchOptions): SourceMatch[] {
    const game = this.repository.getGame(gameId);
    if (!game) {
      return [];
    }
    const words = searchWords(game.title);
    const entries = words.length > 0
      ? this.repository.searchDownloadEntries(words)
      : this.repository.listDownloadEntries();
    return findSourceMatches(game, entries, searchLimit(options));
  }

  searchTitle(title: string, options?: SourceSearchOptions): SourceMatch[] {
    const trimmed = title.trim();
    if (!trimmed) {
      return [];
    }
    const words = searchWords(trimmed);
    const entries = words.length > 0
      ? this.repository.searchDownloadEntries(words)
      : this.repository.listDownloadEntries();
    return findSourceMatches(
      {
        id: `manual:${trimmed}`,
        title: trimmed,
        sortTitle: trimmed.toLocaleLowerCase(),
        sourceIds: [{ provider: "manual", externalId: trimmed }],
        installState: "unknown",
        screenshots: [],
        genres: [],
        tags: [],
        playerModes: [],
        developers: [],
        publishers: [],
        contentDescriptors: [],
        metadataStatus: "none"
      },
      entries,
      searchLimit(options)
    );
  }

  exactTitleMatches(title: string): SourceExactMatch[] {
    const normalizedTitle = normalizeTitle(title);
    return this.repository.exactDownloadTitleMatches(normalizedTitle);
  }
}
