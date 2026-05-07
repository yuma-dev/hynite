import type { SourceImportInput, SourceImportResult, SourceMatch } from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";
import { findSourceMatches, prepareSourceImport } from "@hynite/source-search";

const sourceUrlHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
};

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
        screenshots: [],
        genres: [],
        tags: [],
        developers: [],
        publishers: [],
        contentDescriptors: [],
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

    const response = await fetch(parsed, {
      headers: sourceUrlHeaders,
      redirect: "follow"
    });
    if (!response.ok) {
      throw new Error(`Source URL returned ${response.status}.`);
    }

    return response.text();
  }
}
