import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyniteRepository } from "@hynite/db";
import { SourceService } from "./sourceService";

function makeRepository() {
  return {
    saveDownloadSource: vi.fn(),
    getGame: vi.fn(),
    listSources: vi.fn(() => []),
    listDownloadEntries: vi.fn(() => []),
    searchDownloadEntries: vi.fn(() => []),
    exactDownloadTitleMatches: vi.fn(() => []),
    exactDownloadTitleMatchesBatch: vi.fn(() => new Map())
  } as unknown as HyniteRepository;
}

describe("SourceService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("imports pasted JSON without a URL", async () => {
    const repository = makeRepository();
    const json = JSON.stringify({ name: "Local", downloads: [] });

    await new SourceService(repository).import({ kind: "json", value: json });

    expect(repository.saveDownloadSource).toHaveBeenCalledWith(expect.objectContaining({ name: "Local", url: undefined }));
  });

  it("imports pasted JSON and persists the source URL", async () => {
    const repository = makeRepository();
    const json = JSON.stringify({ name: "Remote", downloads: [] });

    await new SourceService(repository).import({ kind: "json", value: json, url: "https://example.com/source.json" });

    expect(repository.saveDownloadSource).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Remote", url: "https://example.com/source.json" })
    );
  });

  it("refreshSource re-saves with the existing url", () => {
    const repository = makeRepository();
    (repository.listSources as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "abc123", url: "https://example.com/source.json" }
    ]);
    const json = JSON.stringify({ name: "Remote", downloads: [] });

    new SourceService(repository).refreshSource("abc123", json);

    expect(repository.saveDownloadSource).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/source.json" })
    );
  });

  it("looks up exact title matches with normalized titles", () => {
    const repository = makeRepository();
    new SourceService(repository).exactTitleMatches("Baldur's Gate 3 Deluxe Edition");

    expect(repository.exactDownloadTitleMatches).toHaveBeenCalledWith("baldurs gate 3");
  });

  it("looks up exact title matches in a normalized batch", () => {
    const repository = makeRepository();
    const matches = [{ sourceId: "source-1", sourceName: "Source A", count: 2 }];
    (repository.exactDownloadTitleMatchesBatch as ReturnType<typeof vi.fn>).mockReturnValue(new Map([
      ["baldurs gate 3", matches]
    ]));

    expect(new SourceService(repository).exactTitleMatchesBatch(["Baldur's Gate 3", "Baldur's Gate 3", ""])).toEqual([
      { title: "Baldur's Gate 3", matches }
    ]);
    expect(repository.exactDownloadTitleMatchesBatch).toHaveBeenCalledWith(["baldurs gate 3"]);
  });
});
