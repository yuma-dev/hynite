import { afterEach, describe, expect, it, vi } from "vitest";
import { createSteamGridDbArtworkProvider, defaultMetadataProviders, fetchSteamAppInfoMetadataWithNativeFallback, refreshFusedMetadata, steamCdnArtworkProvider, type MetadataProvider } from "../src/fusion";

const game = {
  provider: "steam" as const,
  externalId: "1086940",
  title: "Baldur's Gate 3",
  installState: "not_installed" as const
};

describe("refreshFusedMetadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fills missing fields from later providers", async () => {
    const providers: MetadataProvider[] = [
      {
        id: "steam-store",
        label: "Store",
        async refresh() {
          return { genres: ["RPG"], metadataStatus: "complete" };
        }
      },
      {
        id: "steam-cdn",
        label: "CDN",
        async refresh() {
          return { coverUrl: "cover.jpg", genres: ["Adventure"], metadataStatus: "partial" };
        }
      }
    ];

    await expect(refreshFusedMetadata(game, providers)).resolves.toEqual({
      coverUrl: "cover.jpg",
      genres: ["RPG"],
      metadataStatus: "complete"
    });
  });

  it("uses Steam CDN header artwork without unverified library artwork", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 }))
    );

    await expect(steamCdnArtworkProvider.refresh(game)).resolves.toMatchObject({
      coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1086940/header.jpg",
      backgroundUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1086940/header.jpg"
    });
  });

  it("skips Steam Store appdetails in fast metadata mode", () => {
    expect(defaultMetadataProviders({ mode: "fast" }).map((provider) => provider.id)).toEqual(["steam-appinfo", "steam-cdn"]);
  });

  it("fills missing native SteamKit capsules from HTTP appinfo", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            "1086940": {
              common: {
                name: "Baldur's Gate 3",
                library_assets_full: {
                  library_capsule: {
                    image: { english: "library_600x900.jpg" }
                  }
                }
              }
            }
          }
        }),
        { status: 200 }
      )
    );

    const patch = await fetchSteamAppInfoMetadataWithNativeFallback(game, fetchMock as unknown as typeof fetch, undefined, async () => ({
      title: "Baldur's Gate 3",
      headerUrl: "native-header.jpg",
      coverUrl: "native-header.jpg",
      metadataStatus: "partial"
    }));

    expect(patch).toMatchObject({
      title: "Baldur's Gate 3",
      headerUrl: "native-header.jpg",
      coverUrl: "native-header.jpg",
      libraryCapsuleUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1086940/library_600x900.jpg"
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.steamcmd.net/v1/info/1086940");
  });

  it("uses SteamGridDB bearer auth and picks a static 600x900 grid", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: [
            { url: "wide.jpg", width: 920, height: 430, score: 99 },
            { url: "cover.jpg", width: 600, height: 900, score: 10 }
          ]
        }),
        { status: 200 }
      )
    );
    const provider = createSteamGridDbArtworkProvider("secret", fetchMock as unknown as typeof fetch);

    await expect(provider.refresh(game)).resolves.toMatchObject({
      coverUrl: "cover.jpg",
      libraryCapsuleUrl: "cover.jpg"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.steamgriddb.com/api/v2/grids/steam/1086940?dimensions=600x900&types=static",
      { headers: { Authorization: "Bearer secret" } }
    );
  });

  it("falls back to title search and accepts static 300x450 grids from broad responses", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://www.steamgriddb.com/api/v2/grids/steam/")) {
        return new Response("", { status: 404, statusText: "Not Found" });
      }
      if (url === "https://www.steamgriddb.com/api/v2/search/autocomplete/Baldur's%20Gate%203") {
        return new Response(JSON.stringify({ success: true, data: [{ id: 17830, name: "Baldur's Gate 3" }] }), { status: 200 });
      }
      if (url === "https://www.steamgriddb.com/api/v2/grids/game/17830?dimensions=600x900&types=static") {
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      }
      if (url === "https://www.steamgriddb.com/api/v2/grids/game/17830?types=static") {
        return new Response(JSON.stringify({ success: true, data: [{ url: "cover-300x450.jpg", width: 300, height: 450, score: 4 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    });
    const provider = createSteamGridDbArtworkProvider("secret", fetchMock as unknown as typeof fetch);

    await expect(provider.refresh(game)).resolves.toMatchObject({
      coverUrl: "cover-300x450.jpg",
      libraryCapsuleUrl: "cover-300x450.jpg"
    });
  });
});
