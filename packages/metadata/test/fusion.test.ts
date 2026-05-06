import { afterEach, describe, expect, it, vi } from "vitest";
import { createSteamGridDbArtworkProvider, refreshFusedMetadata, steamCdnArtworkProvider, type MetadataProvider } from "../src/fusion";

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

  it("uses Steam CDN vertical library capsule artwork", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 }))
    );

    await expect(steamCdnArtworkProvider.refresh(game)).resolves.toMatchObject({
      coverUrl: "https://steamcdn-a.akamaihd.net/steam/apps/1086940/library_600x900_2x.jpg",
      libraryCapsuleUrl: "https://steamcdn-a.akamaihd.net/steam/apps/1086940/library_600x900_2x.jpg",
      backgroundUrl: "https://steamcdn-a.akamaihd.net/steam/apps/1086940/library_hero.jpg"
    });
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
});
