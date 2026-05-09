import { describe, expect, it } from "vitest";
import { fetchFamilyGroupId, fetchFamilySharedGames, SteamFamilyAuthError } from "../src/steam/familyApi";

const callerSteamId = "76561198000000000";
const ownerSteamId = "76561198000000001";

describe("fetchFamilyGroupId", () => {
  it("returns the family group id when the user is a member", async () => {
    const fetchMock = async (url: string) => {
      expect(url).toContain("/IFamilyGroupsService/GetFamilyGroupForUser/v1/");
      expect(url).toContain(`steamid=${callerSteamId}`);
      expect(url).toContain("access_token=token");
      return new Response(JSON.stringify({ response: { family_groupid: "12345" } }), { status: 200 });
    };

    await expect(
      fetchFamilyGroupId({ accessToken: "token", steamId: callerSteamId, fetchImpl: fetchMock as typeof fetch })
    ).resolves.toBe("12345");
  });

  it("returns undefined when the user is not in any family", async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ response: { is_not_member_of_any_family: true } }), { status: 200 });

    await expect(
      fetchFamilyGroupId({ accessToken: "token", steamId: callerSteamId, fetchImpl: fetchMock as typeof fetch })
    ).resolves.toBeUndefined();
  });

  it("throws SteamFamilyAuthError on 401", async () => {
    const fetchMock = async () => new Response("unauthorized", { status: 401 });

    await expect(
      fetchFamilyGroupId({ accessToken: "stale", steamId: callerSteamId, fetchImpl: fetchMock as typeof fetch })
    ).rejects.toBeInstanceOf(SteamFamilyAuthError);
  });
});

describe("fetchFamilySharedGames", () => {
  it("filters excluded apps and apps owned by the caller, then maps to ImportedGame", async () => {
    const fetchMock = async (url: string) => {
      expect(url).toContain("/IFamilyGroupsService/GetSharedLibraryApps/v1/");
      expect(url).toContain("family_groupid=12345");
      expect(url).toContain("include_own=false");
      expect(url).toContain("include_excluded=false");

      return new Response(
        JSON.stringify({
          response: {
            apps: [
              {
                appid: 1086940,
                name: "Baldur's Gate 3",
                owner_steamids: [ownerSteamId],
                img_icon_hash: "iconhash",
                exclude_reason: 0,
                rt_time_acquired: 1_700_000_000,
                rt_last_played: 1_705_000_000,
                rt_playtime: 7_200
              },
              {
                appid: 999,
                name: "Excluded Game",
                owner_steamids: [ownerSteamId],
                exclude_reason: 1
              },
              {
                appid: 730,
                name: "Owned by caller",
                owner_steamids: [callerSteamId],
                exclude_reason: 0
              }
            ]
          }
        }),
        { status: 200 }
      );
    };

    const result = await fetchFamilySharedGames({
      accessToken: "token",
      steamId: callerSteamId,
      familyGroupId: "12345",
      fetchImpl: fetchMock as typeof fetch
    });

    expect(result).toEqual([
      {
        provider: "steam",
        externalId: "1086940",
        title: "Baldur's Gate 3",
        installState: "unknown",
        launchCommand: "steam://rungameid/1086940",
        playtimeMinutes: 120,
        lastPlayedAt: new Date(1_705_000_000 * 1000).toISOString(),
        addedAt: new Date(1_700_000_000 * 1000).toISOString(),
        communityIconUrl: "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/1086940/iconhash.jpg",
        shareType: "family",
        familyOwnerSteamIds: [ownerSteamId]
      }
    ]);
  });

  it("returns an empty array when the response has no apps", async () => {
    const fetchMock = async () => new Response(JSON.stringify({ response: {} }), { status: 200 });

    await expect(
      fetchFamilySharedGames({
        accessToken: "token",
        steamId: callerSteamId,
        familyGroupId: "12345",
        fetchImpl: fetchMock as typeof fetch
      })
    ).resolves.toEqual([]);
  });

  it("throws SteamFamilyAuthError on 403", async () => {
    const fetchMock = async () => new Response("forbidden", { status: 403 });

    await expect(
      fetchFamilySharedGames({
        accessToken: "stale",
        steamId: callerSteamId,
        familyGroupId: "12345",
        fetchImpl: fetchMock as typeof fetch
      })
    ).rejects.toBeInstanceOf(SteamFamilyAuthError);
  });
});
