import { describe, expect, it } from "vitest";
import type { Game } from "@hynite/core";
import { buildHomeModel } from "../src";

function game(id: string, title: string): Game {
  return {
    id,
    title,
    sortTitle: title.toLocaleLowerCase(),
    sourceIds: [{ provider: "steam", externalId: id.replace("steam:", "") }],
    installState: "installed",
    genres: ["RPG"],
    tags: ["Story Rich"],
    developers: [],
    publishers: [],
    playtimeMinutes: 120,
    metadataStatus: "complete"
  };
}

describe("recommendations", () => {
  it("builds a deterministic empty-library fallback", async () => {
    const fetchMock = async () => ({ ok: false, status: 500 }) as Response;
    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow.length).toBeGreaterThan(0);
    expect(home.continuePlaying).toEqual([]);
  });

  it("excludes owned games from recommendations", async () => {
    const fetchMock = async () => ({ ok: false, status: 500 }) as Response;
    const home = await buildHomeModel([game("steam:730", "Counter-Strike 2")], fetchMock as typeof fetch);

    expect(home.recommended.some((item) => item.id === "steam:730")).toBe(false);
  });
});

