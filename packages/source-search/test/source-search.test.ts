import { describe, expect, it } from "vitest";
import type { Game } from "@hynite/core";
import { findSourceMatches, normalizeTitle, prepareSourceImport } from "../src";

const game: Game = {
  id: "steam:1086940",
  title: "Baldur's Gate 3",
  sortTitle: "baldurs gate 3",
  sourceIds: [{ provider: "steam", externalId: "1086940" }],
  installState: "installed",
  genres: [],
  tags: [],
  playerModes: [],
  developers: [],
  publishers: [],
  metadataStatus: "complete"
};

describe("source search", () => {
  it("normalizes edition suffixes", () => {
    expect(normalizeTitle("Baldur's Gate 3 - Deluxe Edition [PC]")).toBe("baldurs gate 3");
  });

  it("filters unsupported uri schemes during import", () => {
    const prepared = prepareSourceImport(
      JSON.stringify({
        name: "Local",
        downloads: [
          {
            title: "Baldur's Gate 3",
            fileSize: "100 GB",
            uris: ["magnet:?xt=urn:btih:test", "ftp://example.invalid/file"]
          }
        ]
      })
    );

    expect(prepared.importedEntries).toBe(1);
    expect(prepared.entries[0]?.uris).toEqual(["magnet:?xt=urn:btih:test"]);
  });

  it("scores exact source matches as high confidence", () => {
    const matches = findSourceMatches(game, [
      {
        id: "entry-1",
        sourceId: "source-1",
        sourceName: "Local",
        title: "Baldurs Gate 3",
        normalizedTitle: "baldurs gate 3",
        uris: ["magnet:?xt=urn:btih:test"]
      }
    ]);

    expect(matches[0]?.confidence).toBe("high");
    expect(matches[0]?.sourceId).toBe("source-1");
  });

  it("scores partial source title matches without requiring exact titles", () => {
    const matches = findSourceMatches(game, [
      {
        id: "entry-1",
        sourceId: "source-1",
        sourceName: "Local",
        title: "Baldurs Gate III Complete",
        normalizedTitle: "baldurs gate iii",
        uris: ["magnet:?xt=urn:btih:test"]
      }
    ]);

    expect(matches[0]?.confidence).toMatch(/high|medium/);
  });

  it("lists newest uploaded source matches first", () => {
    const matches = findSourceMatches(game, [
      {
        id: "entry-old",
        sourceId: "source-1",
        sourceName: "Local",
        title: "Baldur's Gate 3",
        normalizedTitle: "baldurs gate 3",
        uploadDate: "2026-05-07T01:39:32.000Z",
        uris: ["magnet:?xt=urn:btih:old"]
      },
      {
        id: "entry-new",
        sourceId: "source-1",
        sourceName: "Local",
        title: "Baldur's Gate 3",
        normalizedTitle: "baldurs gate 3",
        uploadDate: "2026-05-08T01:39:32.000Z",
        uris: ["magnet:?xt=urn:btih:new"]
      },
      {
        id: "entry-undated",
        sourceId: "source-1",
        sourceName: "Local",
        title: "Baldur's Gate 3",
        normalizedTitle: "baldurs gate 3",
        uris: ["magnet:?xt=urn:btih:undated"]
      }
    ]);

    expect(matches.map((match) => match.id)).toEqual(["entry-new", "entry-old", "entry-undated"]);
  });
});
