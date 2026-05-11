import { afterEach, describe, expect, it, vi } from "vitest";
import { SteamImporterProvider, type SteamFamilyScanStatus } from "../src/steam/provider";

const callerSteamId = "76561198000000000";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSteamFetch(statusByPath: Record<string, Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    for (const [path, response] of Object.entries(statusByPath)) {
      if (url.includes(path)) {
        return response;
      }
    }
    throw new Error(`Unexpected Steam request: ${url}`);
  }));
}

describe("SteamImporterProvider family scan status", () => {
  it("reports complete when family-shared games were scanned", async () => {
    const statuses: SteamFamilyScanStatus[] = [];
    stubSteamFetch({
      "IPlayerService/GetOwnedGames": new Response(JSON.stringify({ response: { games: [] } }), { status: 200 }),
      "IFamilyGroupsService/GetFamilyGroupForUser": new Response(JSON.stringify({ response: { family_groupid: "12345" } }), { status: 200 }),
      "IFamilyGroupsService/GetSharedLibraryApps": new Response(JSON.stringify({
        response: {
          apps: [{ appid: 10, name: "Shared Game", owner_steamids: ["owner"], exclude_reason: 0 }]
        }
      }), { status: 200 })
    });

    const result = await new SteamImporterProvider({
      account: { steamId: callerSteamId, webApiKey: "key", familyAccessToken: "token" },
      familyScanResult: (entry) => statuses.push(entry.status)
    }).scan();

    expect(statuses).toEqual(["complete"]);
    expect(result.map((game) => game.externalId)).toEqual(["10"]);
  });

  it("reports auth-error and keeps owned games when the family token is rejected", async () => {
    const statuses: SteamFamilyScanStatus[] = [];
    stubSteamFetch({
      "IPlayerService/GetOwnedGames": new Response(JSON.stringify({
        response: { games: [{ appid: 20, name: "Owned Game" }] }
      }), { status: 200 }),
      "IFamilyGroupsService/GetFamilyGroupForUser": new Response("forbidden", { status: 403 })
    });

    const result = await new SteamImporterProvider({
      account: { steamId: callerSteamId, webApiKey: "key", familyAccessToken: "stale" },
      familyScanResult: (entry) => statuses.push(entry.status)
    }).scan();

    expect(statuses).toEqual(["auth-error"]);
    expect(result.map((game) => game.externalId)).toEqual(["20"]);
  });
});
