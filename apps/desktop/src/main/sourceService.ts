import type { SourceImportInput, SourceImportResult, SourceMatch } from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";
import { findSourceMatches, prepareSourceImport } from "@hynite/source-search";

export class SourceService {
  constructor(private readonly repository: HyniteRepository) {}

  async import(input: SourceImportInput): Promise<SourceImportResult> {
    const json = input.kind === "url" ? await this.fetchUrl(input.value) : input.value;
    const prepared = prepareSourceImport(json);
    this.repository.saveDownloadSource(prepared);

    return {
      sourceId: prepared.id,
      name: prepared.name,
      importedEntries: prepared.importedEntries,
      skippedEntries: prepared.skippedEntries
    };
  }

  search(gameId: string): SourceMatch[] {
    const game = this.repository.getGame(gameId);
    if (!game) {
      return [];
    }

    return findSourceMatches(game, this.repository.listDownloadEntries());
  }

  searchTitle(title: string): SourceMatch[] {
    const trimmed = title.trim();
    if (!trimmed) {
      return [];
    }

    return findSourceMatches(
      {
        id: `manual:${trimmed}`,
        title: trimmed,
        sortTitle: trimmed.toLocaleLowerCase(),
        sourceIds: [{ provider: "manual", externalId: trimmed }],
        installState: "unknown",
        genres: [],
        tags: [],
        developers: [],
        publishers: [],
        metadataStatus: "none"
      },
      this.repository.listDownloadEntries()
    );
  }

  private async fetchUrl(url: string): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Only HTTPS source URLs are supported.");
    }

    const response = await fetch(parsed);
    if (!response.ok) {
      throw new Error(`Source URL returned ${response.status}.`);
    }

    return response.text();
  }
}
