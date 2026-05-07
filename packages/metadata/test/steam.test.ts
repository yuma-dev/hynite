import { describe, expect, it } from "vitest";
import { fetchSteamAppInfoMetadata, fetchSteamMetadata } from "../src/steam";

describe("fetchSteamMetadata", () => {
  it("extracts rich Steam appdetails metadata", async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          "730": {
            success: true,
            data: {
              name: "Counter-Strike 2",
              short_description: "Tactical action.",
              about_the_game: "<p>Play rounds.<br>Win matches.</p>",
              header_image: "header.jpg",
              background_raw: "background.jpg",
              developers: ["Valve"],
              publishers: ["Valve"],
              genres: [{ id: "1", description: "Action" }],
              categories: [{ id: 2, description: "Multiplayer" }],
              screenshots: [{ id: 1, path_thumbnail: "thumb.jpg", path_full: "full.jpg" }],
              movies: [{ id: 1, thumbnail: "poster.jpg", hls_h264: "trailer.m3u8", mp4: { "480": "trailer-480.mp4", max: "trailer.mp4" }, highlight: true }],
              recommendations: { total: 1000 },
              achievements: { total: 12 },
              platforms: { windows: true, mac: false, linux: true },
              website: "https://example.test",
              support_info: { url: "https://support.example.test" },
              content_descriptors: { notes: "Violence" },
              release_date: { date: "Aug 21, 2012" }
            }
          }
        }),
        { status: 200 }
      );

    await expect(fetchSteamMetadata("730", fetchMock as typeof fetch)).resolves.toMatchObject({
      title: "Counter-Strike 2",
      shortDescription: "Tactical action.",
      aboutText: "<p>Play rounds.<br>Win matches.</p>",
      headerUrl: "header.jpg",
      backgroundUrl: "background.jpg",
      trailerUrl: "trailer.mp4",
      trailerPosterUrl: "poster.jpg",
      screenshots: [{ thumbnailUrl: "thumb.jpg", fullUrl: "full.jpg" }],
      platforms: { windows: true, mac: false, linux: true },
      achievementCount: 12,
      recommendationCount: 1000,
      contentDescriptors: ["Violence"],
      genres: ["Action"],
      tags: ["Multiplayer"],
      releaseDate: "2012-08-21"
    });
  });

  it("extracts hashed library assets from Steam appinfo", async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          data: {
            "3743800": {
              common: {
                name: "Hozy Playtest",
                steam_release_date: "1764547200",
                associations: {
                  0: { name: "Studio A", type: "developer" },
                  1: { name: "Publisher B", type: "publisher" }
                },
                clienticon: "client-icon-hash",
                icon: "icon-hash",
                header_image: { english: "header-hash/header.jpg" },
                library_assets_full: {
                  library_capsule: {
                    image: { english: "capsule-hash/library_600x900.jpg" },
                    image2x: { english: "capsule-hash/library_600x900_2x.jpg" }
                  },
                  library_hero: {
                    image: { english: "hero-hash/library_hero.jpg" }
                  }
                }
              },
              extended: {
                homepage: "https://example.test"
              }
            }
          }
        }),
        { status: 200 }
      );

    await expect(fetchSteamAppInfoMetadata("3743800", fetchMock as typeof fetch)).resolves.toMatchObject({
      title: "Hozy Playtest",
      coverUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3743800/capsule-hash/library_600x900.jpg",
      libraryCapsuleUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3743800/capsule-hash/library_600x900.jpg",
      backgroundUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3743800/hero-hash/library_hero.jpg",
      headerUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3743800/header-hash/header.jpg",
      communityIconUrl: "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/3743800/client-icon-hash.ico",
      developers: ["Studio A"],
      publishers: ["Publisher B"],
      releaseDate: "2025-12-01",
      websiteUrl: "https://example.test"
    });
  });

  it("falls back to reachable non-2x appinfo library capsule assets", async () => {
    const fetchMock = async () => {
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
                  },
                  library_hero: {
                    image: { english: "library_hero.jpg" }
                  }
                }
              }
            }
          }
        }),
        { status: 200 }
      );
    };

    await expect(fetchSteamAppInfoMetadata("346110", fetchMock as typeof fetch)).resolves.toMatchObject({
      coverUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/346110/library_600x900.jpg",
      libraryCapsuleUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/346110/library_600x900.jpg",
      backgroundUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/346110/library_hero.jpg"
    });
  });

  it("uses appinfo header artwork instead of unverified CDN library cover when no library capsule exists", async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          data: {
            "407530": {
              common: {
                name: "ARK: Survival Of The Fittest",
                header_image: { english: "header.jpg" },
                small_capsule: { english: "capsule_231x87.jpg" }
              }
            }
          }
        }),
        { status: 200 }
      );

    const patch = await fetchSteamAppInfoMetadata("407530", fetchMock as typeof fetch);
    expect(patch).toMatchObject({
      coverUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/407530/header.jpg",
      backgroundUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/407530/header.jpg",
      headerUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/407530/header.jpg"
    });
    expect(patch.libraryCapsuleUrl).toBeUndefined();
  });
});
