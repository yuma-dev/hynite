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
        sourceName: "Local",
        title: "Baldurs Gate 3",
        normalizedTitle: "baldurs gate 3",
        uris: ["magnet:?xt=urn:btih:test"]
      }
    ]);

    expect(matches[0]?.confidence).toBe("high");
  });
});

