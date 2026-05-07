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
    screenshots: [],
    genres: ["RPG"],
    tags: ["Story Rich"],
    developers: [],
    publishers: [],
    contentDescriptors: [],
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

  it("builds named discovery candidates from Steam sources", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [
                {
                  id: 123,
                  type: 0,
                  name: "Named Game",
                  discount_percent: 10,
                  original_price: 1999,
                  final_price: 1799,
                  currency: "USD",
                  header_image: "header.jpg"
                }
              ]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(
          JSON.stringify({
            featured_win: []
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          "123": {
            success: true,
            data: {
              name: "Named Game",
              genres: [{ id: "1", description: "Action" }],
              categories: [{ id: 2, description: "Single-player" }]
            }
          }
        }),
        { status: 200 }
      );
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow[0]?.title).toBe("Named Game");
    expect(home.popularNow[0]?.title).not.toMatch(/^Steam App/);
    expect(home.popularNow[0]?.discovery?.sources).toContain("featured:top_sellers");
    expect(home.popularNow[0]?.discovery?.priceText).toBe("$17.99");
    expect(home.popularNow[0]?.discovery?.storeCategory).toBe("Top Sellers");
  });

  it("uses Steam Store featured content for the hero set instead of SteamSpy", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(JSON.stringify({ status: 1 }), { status: 200 });
      }

      if (url.includes("/api/featured/")) {
        return new Response(
          JSON.stringify({
            featured_win: [{ id: 2769240, type: 0, name: "Store Featured Game", final_price: 1274, currency: "USD", header_image: "header.jpg" }]
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          "2769240": { success: true, data: { name: "Store Featured Game" } }
        }),
        { status: 200 }
      );
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow[0]?.title).toBe("Store Featured Game");
    expect(home.popularNow[0]?.discovery?.sources).toContain("store-featured:featured_win");
  });

  it("builds categorized trending rows from chart, SteamSpy, and Store category feeds", async () => {
    const names: Record<string, string> = {
      "111": "SteamSpy Top Game",
      "123": "Top Seller Game",
      "222": "Fresh Trend Game",
      "456": "New Release Game",
      "789": "Chart Rank Game"
    };
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [{ id: 123, type: 0, name: names["123"], final_price: 1999, currency: "USD", header_image: "top.jpg" }]
            },
            new_releases: {
              id: "cat_newreleases",
              name: "New Releases",
              items: [{ id: 456, type: 0, name: names["456"], final_price: 2999, currency: "USD", header_image: "new.jpg" }]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      if (url.includes("ISteamChartsService")) {
        return new Response(JSON.stringify({ response: { ranks: [{ rank: 1, appid: 789, peak_in_game: 50000 }] } }), { status: 200 });
      }

      if (url.includes("top100in2weeks")) {
        return new Response(
          JSON.stringify({
            "111": { appid: 111, name: names["111"], ccu: 25000, owners: "1,000,000 .. 2,000,000", positive: 900, negative: 100 }
          }),
          { status: 200 }
        );
      }

      if (url === "https://steamspy.com/") {
        return new Response(
          '<table id="trendinggames"><tbody><tr><a href=/app/222><img src="fresh.jpg">Fresh Trend Game</a><td data-order="2026-05-01"></td><td data-order="1499"></td><td data-order="100000"></td></tr></tbody></table>',
          { status: 200 }
        );
      }

      const appid = new URL(url).searchParams.get("appids") ?? "";
      return new Response(
        JSON.stringify({
          [appid]: {
            success: true,
            data: {
              name: names[appid],
              short_description: `${names[appid]} description`
            }
          }
        }),
        { status: 200 }
      );
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.trendingRows.find((row) => row.id === "most-played-now")?.games[0]?.title).toBe("Chart Rank Game");
    expect(home.trendingRows.find((row) => row.id === "top-two-weeks")?.games[0]?.title).toBe("SteamSpy Top Game");
    expect(home.trendingRows.find((row) => row.id === "rising-recently")?.games[0]?.title).toBe("Fresh Trend Game");
    expect(home.trendingRows.find((row) => row.id === "top-sellers")?.games[0]?.title).toBe("Top Seller Game");
    expect(home.trendingRows.find((row) => row.id === "new-releases")?.games[0]?.title).toBe("New Release Game");
  });

  it("reuses cached discovery metadata instead of refetching appdetails", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "top_sellers",
              items: [{ id: 123, type: 0, name: "Named Game", header_image: "header.jpg" }]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      throw new Error(`Unexpected metadata fetch: ${url}`);
    };

    const cached = game("steam:123", "Named Game");
    cached.libraryCapsuleUrl = "cached-cover.jpg";
    cached.coverUrl = "cached-cover.jpg";
    const home = await buildHomeModel([], fetchMock as typeof fetch, {
      recentActivity: [],
      continuePlaying: [],
      mostPlayed: [],
      popularNow: [cached],
      recommended: [],
      newAndNotable: [],
      trendingRows: [],
      generatedAt: "2026-05-06T00:00:00.000Z",
      stale: false
    });

    expect(home.popularNow[0]?.coverUrl).toBe("cached-cover.jpg");
  });

  it("returns enough local row items for lazy Home row loading", async () => {
    const fetchMock = async () => ({ ok: false, status: 500 }) as Response;
    const localGames = Array.from({ length: 15 }, (_, index) => ({
      ...game(`steam:${index + 1}`, `Game ${index + 1}`),
      lastPlayedAt: new Date(Date.UTC(2026, 4, index + 1)).toISOString(),
      playtimeMinutes: index + 1
    }));

    const home = await buildHomeModel(localGames, fetchMock as typeof fetch);

    expect(home.continuePlaying).toHaveLength(15);
    expect(home.mostPlayed).toHaveLength(15);
    expect(home.continuePlaying[0]?.title).toBe("Game 15");
    expect(home.mostPlayed[0]?.title).toBe("Game 15");
  });
});
