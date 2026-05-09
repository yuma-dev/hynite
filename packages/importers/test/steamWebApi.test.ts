import { describe, expect, it } from "vitest";
import { fetchOwnedSteamGames } from "../src/steam/webApi";

describe("fetchOwnedSteamGames", () => {
  it("normalizes owned Steam games", async () => {
    const fetchMock = async (url: string) => {
      expect(url).toContain("include_appinfo=true");
      expect(url).toContain("include_played_free_games=true");

      return new Response(
        JSON.stringify({
          response: {
            games: [
              {
                  appid: 1086940,
                  name: "Baldur's Gate 3",
                  img_icon_url: "iconhash",
                  playtime_forever: 4200,
                  rtime_last_played: 1700000000
              }
            ]
          }
        }),
        { status: 200 }
      );
    };

    await expect(fetchOwnedSteamGames({ steamId: "76561198000000000", webApiKey: "key", fetchImpl: fetchMock as typeof fetch })).resolves.toEqual([
      {
        provider: "steam",
        externalId: "1086940",
        title: "Baldur's Gate 3",
        installState: "unknown",
        launchCommand: "steam://rungameid/1086940",
        playtimeMinutes: 4200,
        lastPlayedAt: "2023-11-14T22:13:20.000Z",
        communityIconUrl: "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/1086940/iconhash.jpg",
        ownerSteamid: "76561198000000000"
      }
    ]);
  });
});
