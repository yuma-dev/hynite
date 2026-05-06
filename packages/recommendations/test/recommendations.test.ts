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
      generatedAt: "2026-05-06T00:00:00.000Z",
      stale: false
    });

    expect(home.popularNow[0]?.coverUrl).toBe("cached-cover.jpg");
  });
});
