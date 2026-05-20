import { describe, expect, it } from "vitest";
import type { Game } from "@hynite/core";
import { SteamRateLimitError } from "@hynite/metadata";
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
    playerModes: [],
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

  it("falls back when discovery sources hang", async () => {
    const sourceUrls = [
      "featuredcategories",
      "/api/featured/",
      "ISteamChartsService",
      "steamspy.com/api.php",
      "steamspy.com/"
    ];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (sourceUrls.some((sourceUrl) => href.includes(sourceUrl))) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }

      return new Response("{}", { status: 500 });
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch, undefined, { discoverySourceFetchTimeoutMs: 5 });

    expect(home.popularNow.length).toBeGreaterThan(0);
    expect(home.popularNow[0]?.discovery?.sources).toContain("fallback");
    expect(home.stale).toBe(false);
  });

  it("excludes owned games from recommendations", async () => {
    const fetchMock = async () => ({ ok: false, status: 500 }) as Response;
    const home = await buildHomeModel([game("steam:730", "Counter-Strike 2")], fetchMock as typeof fetch);

    expect(home.recommended.some((item) => item.id === "steam:730")).toBe(false);
  });

  it("builds named discovery candidates from Steam sources", async () => {
    const requestedUrls: string[] = [];
    const fetchMock = async (url: string) => {
      requestedUrls.push(url);
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

    expect(requestedUrls.find((url) => url.includes("featuredcategories"))).toContain("cc=DE");
    expect(requestedUrls.find((url) => url.includes("/api/featured/"))).toContain("cc=DE");
    expect(home.popularNow[0]?.title).toBe("Named Game");
    expect(home.popularNow[0]?.title).not.toMatch(/^Steam App/);
    expect(home.popularNow[0]?.discovery?.sources).toContain("featured:top_sellers");
    expect(home.popularNow[0]?.discovery?.priceText).toBe("$17.99");
    expect(home.popularNow[0]?.discovery?.storeCategory).toBe("Top Sellers");
    expect(home.popularNow[0]?.coverUrl).toBeUndefined();
    expect(home.popularNow[0]?.headerUrl).toBeTruthy();
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
    expect(home.popularNow[0]?.coverUrl).toBeUndefined();
  });

  it("filters NSFW games from the Home hero while keeping them in Trending rows", async () => {
    const names: Record<string, string> = {
      "101": "Explicit Trend Game",
      "102": "Safe Trend Game"
    };
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [
                { id: 101, type: 0, name: names["101"], final_price: 1999, currency: "USD", header_image: "explicit.jpg" },
                { id: 102, type: 0, name: names["102"], final_price: 1999, currency: "USD", header_image: "safe.jpg" }
              ]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      if (url.includes("api.steamcmd.net")) {
        const appid = url.split("/").pop() ?? "";
        return new Response(
          JSON.stringify({
            data: {
              [appid]: {
                common: {
                  name: names[appid]
                }
              }
            }
          }),
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
              content_descriptors: {
                notes: appid === "101" ? "Nudity or Sexual Content" : "Violence"
              }
            }
          }
        }),
        { status: 200 }
      );
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow.map((item) => item.title)).toEqual(["Safe Trend Game"]);
    expect(home.trendingRows.find((row) => row.id === "top-sellers")?.games.map((item) => item.title)).toEqual([
      "Explicit Trend Game",
      "Safe Trend Game"
    ]);
  });

  it("filters explicit Store feed titles from the Home hero before rich descriptors load", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [
                { id: 201, type: 0, name: "Horny Hentai Porn Game", final_price: 1999, currency: "USD", header_image: "explicit.jpg" },
                { id: 202, type: 0, name: "Space Factory", final_price: 1999, currency: "USD", header_image: "safe.jpg" }
              ]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      return new Response("", { status: 500 });
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow.map((item) => item.title)).toEqual(["Space Factory"]);
    expect(home.trendingRows.find((row) => row.id === "top-sellers")?.games.map((item) => item.title)).toEqual([
      "Horny Hentai Porn Game",
      "Space Factory"
    ]);
  });

  it("filters adult-marker titles with non-word symbols from the Home hero", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [
                { id: 211, type: 0, name: "18+ Secret Room", final_price: 1999, currency: "USD", header_image: "explicit.jpg" },
                { id: 212, type: 0, name: "Garden Builder", final_price: 1999, currency: "USD", header_image: "safe.jpg" }
              ]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      return new Response("", { status: 500 });
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow.map((item) => item.title)).toEqual(["Garden Builder"]);
  });

  it("filters adult Store descriptions from the Home hero when titles are clean", async () => {
    const names: Record<string, string> = {
      "221": "Midnight Academy",
      "222": "Orchard Quest"
    };
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [
                { id: 221, type: 0, name: names["221"], final_price: 1999, currency: "USD", header_image: "explicit.jpg" },
                { id: 222, type: 0, name: names["222"], final_price: 1999, currency: "USD", header_image: "safe.jpg" }
              ]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      if (url.includes("api.steamcmd.net")) {
        const appid = url.split("/").pop() ?? "";
        return new Response(
          JSON.stringify({
            data: {
              [appid]: {
                common: {
                  name: names[appid]
                }
              }
            }
          }),
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
              short_description: appid === "221" ? "A visual novel with adult content and suggestive themes." : "A calm farming adventure.",
              genres: [{ id: "1", description: "Adventure" }]
            }
          }
        }),
        { status: 200 }
      );
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow.map((item) => item.title)).toEqual(["Orchard Quest"]);
  });

  it("filters Steam appinfo adult user tags from the Home hero", async () => {
    const names: Record<string, string> = {
      "231": "Crystal Venture",
      "232": "Meadow Trails"
    };
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [
                { id: 231, type: 0, name: names["231"], final_price: 1999, currency: "USD", header_image: "tagged.jpg" },
                { id: 232, type: 0, name: names["232"], final_price: 1999, currency: "USD", header_image: "safe.jpg" }
              ]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      if (url.includes("api.steamcmd.net")) {
        const appid = url.split("/").pop() ?? "";
        return new Response(
          JSON.stringify({
            data: {
              [appid]: {
                common: {
                  name: names[appid],
                  store_tags: appid === "231" ? { 0: "Sexual Content", 1: "2D", 2: "Hentai", 3: "Anime" } : { 0: "Adventure" }
                }
              }
            }
          }),
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
              genres: [{ id: "1", description: "Adventure" }]
            }
          }
        }),
        { status: 200 }
      );
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.popularNow.map((item) => item.title)).toEqual(["Meadow Trails"]);
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

      if (url.includes("api.steamcmd.net")) {
        const appid = url.split("/").pop() ?? "";
        return new Response(
          JSON.stringify({
            data: {
              [appid]: {
                common: {
                  name: names[appid]
                }
              }
            }
          }),
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
    expect(home.trendingRows.find((row) => row.id === "most-played-now")?.games[0]?.headerUrl).toBe("https://cdn.akamai.steamstatic.com/steam/apps/789/header.jpg");
    expect(home.trendingRows.find((row) => row.id === "top-two-weeks")?.games[0]?.title).toBe("SteamSpy Top Game");
    expect(home.trendingRows.find((row) => row.id === "top-two-weeks")?.games[0]?.headerUrl).toBe("https://cdn.akamai.steamstatic.com/steam/apps/111/header.jpg");
    expect(home.trendingRows.find((row) => row.id === "rising-recently")?.games[0]?.title).toBe("Fresh Trend Game");
    expect(home.trendingRows.find((row) => row.id === "rising-recently")?.games[0]?.coverUrl).toBeUndefined();
    expect(home.trendingRows.find((row) => row.id === "rising-recently")?.games[0]?.headerUrl).toBe("https://cdn.akamai.steamstatic.com/steam/apps/222/header.jpg");
    expect(home.trendingRows.find((row) => row.id === "top-sellers")?.games[0]?.title).toBe("Top Seller Game");
    expect(home.trendingRows.find((row) => row.id === "new-releases")?.games[0]?.title).toBe("New Release Game");
  });

  it("enriches discovery games with Steam appinfo covers instead of unverified deterministic covers", async () => {
    const fetchMock = async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response("", { status: url.includes("library_600x900.jpg") ? 200 : 404 });
      }

      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "cat_topsellers",
              name: "Top Sellers",
              items: [{ id: 346110, type: 0, name: "ARK: Survival Evolved", header_image: "store-header.jpg" }]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      if (url.includes("api.steamcmd.net")) {
        return new Response(
          JSON.stringify({
            data: {
              "346110": {
                common: {
                  name: "ARK: Survival Evolved",
                  library_assets_full: {
                    library_capsule: {
                      image: { english: "library_600x900.jpg" },
                      image2x: { english: "library_600x900_2x.jpg" }
                    }
                  }
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          "346110": {
            success: true,
            data: {
              name: "ARK: Survival Evolved",
              short_description: "Dinosaur survival."
            }
          }
        }),
        { status: 200 }
      );
    };

    const home = await buildHomeModel([], fetchMock as typeof fetch);

    expect(home.trendingRows.find((row) => row.id === "top-sellers")?.games[0]?.libraryCapsuleUrl).toBe(
      "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/346110/library_600x900.jpg"
    );
  });

  it("aborts discovery rebuilds when Steam rate limits source fetches", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("steampowered.com") || url.includes("ISteamChartsService")) {
        throw new SteamRateLimitError("Steam returned 429 Too Many Requests", 5000);
      }

      return new Response("", { status: 500 });
    };

    await expect(buildHomeModel([], fetchMock as typeof fetch)).rejects.toThrow("Steam returned 429");
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

  it("re-enriches cached chart discovery when metadata had no vertical capsule", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(JSON.stringify({ status: 1 }), { status: 200 });
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      if (url.includes("ISteamChartsService")) {
        return new Response(JSON.stringify({ response: { ranks: [{ rank: 1, appid: 123, peak_in_game: 50000 }] } }), { status: 200 });
      }

      if (url.includes("api.steamcmd.net")) {
        return new Response(
          JSON.stringify({
            data: {
              "123": {
                common: {
                  name: "Named Game",
                  library_assets_full: {
                    library_capsule: {
                      image: { english: "hash/library_capsule.jpg" }
                    }
                  }
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      return new Response("", { status: 500 });
    };

    const cached = game("steam:123", "Named Game");
    cached.coverUrl = "stale-header.jpg";
    cached.libraryCapsuleUrl = undefined;
    cached.headerUrl = "stale-header.jpg";
    const home = await buildHomeModel([], fetchMock as typeof fetch, {
      recentActivity: [],
      continuePlaying: [],
      mostPlayed: [],
      popularNow: [],
      recommended: [],
      newAndNotable: [],
      trendingRows: [{ id: "most-played-now", title: "Most played now", description: "", games: [cached] }],
      generatedAt: "2026-05-06T00:00:00.000Z",
      stale: false
    });

    const chartGame = home.trendingRows.find((row) => row.id === "most-played-now")?.games[0];
    expect(chartGame?.libraryCapsuleUrl).toBe("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/123/hash/library_capsule.jpg");
    expect(chartGame?.coverUrl).toBe("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/123/hash/library_capsule.jpg");
  });

  it("ignores legacy guessed cached library capsules for discovery rows", async () => {
    const fetchMock = async (url: string) => {
      if (url.includes("featuredcategories")) {
        return new Response(
          JSON.stringify({
            top_sellers: {
              id: "top_sellers",
              items: [{ id: 3405690, type: 0, name: "EA SPORTS FC™ 26", header_image: "fc-header.jpg" }]
            }
          }),
          { status: 200 }
        );
      }

      if (url.includes("/api/featured/")) {
        return new Response(JSON.stringify({ featured_win: [] }), { status: 200 });
      }

      if (url.includes("api.steamcmd.net")) {
        return new Response(
          JSON.stringify({
            data: {
              "3405690": {
                common: {
                  name: "EA SPORTS FC™ 26",
                  library_assets_full: {
                    library_capsule: {
                      image: { english: "hash/library_capsule.jpg" }
                    }
                  }
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      return new Response("", { status: 500 });
    };

    const cached = game("steam:3405690", "EA SPORTS FC™ 26");
    cached.coverUrl = "https://cdn.akamai.steamstatic.com/steam/apps/3405690/library_600x900.jpg";
    cached.libraryCapsuleUrl = "https://cdn.akamai.steamstatic.com/steam/apps/3405690/library_600x900.jpg";
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

    expect(home.popularNow[0]?.libraryCapsuleUrl).toBe("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3405690/hash/library_capsule.jpg");
    expect(home.popularNow[0]?.coverUrl).toBe("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3405690/hash/library_capsule.jpg");
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
