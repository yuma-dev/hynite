import { describe, expect, it } from "vitest";
import { resolveLaunchableSteamAccounts, type Game, type SteamAccountSettings } from "../src";

function game(sourceIds: Game["sourceIds"]): Game {
  return {
    id: "steam:10",
    title: "Test Game",
    sortTitle: "test game",
    sourceIds,
    installState: "unknown",
    screenshots: [],
    contentDescriptors: [],
    genres: [],
    tags: [],
    playerModes: [],
    developers: [],
    publishers: [],
    metadataStatus: "none"
  };
}

const accounts: SteamAccountSettings[] = [
  { steamId: "owner-a", personaName: "Owner A", pairedAt: "2026-01-01T00:00:00.000Z", localUsername: "ownera" },
  { steamId: "family-b", personaName: "Family B", pairedAt: "2026-01-01T00:00:00.000Z", localUsername: "familyb" },
  { steamId: "owner-c", personaName: "Owner C", pairedAt: "2026-01-01T00:00:00.000Z" }
];

describe("resolveLaunchableSteamAccounts", () => {
  it("returns direct owners as owner options", () => {
    expect(resolveLaunchableSteamAccounts(game([
      { provider: "steam", externalId: "10", shareType: "owned", ownerSteamid: "owner-a" }
    ]), accounts)).toEqual([
      { steamId: "owner-a", personaName: "Owner A", localUsername: "ownera", kind: "owner" }
    ]);
  });

  it("returns family importers as family options", () => {
    expect(resolveLaunchableSteamAccounts(game([
      { provider: "steam", externalId: "10", shareType: "family", ownerSteamid: "family-b" }
    ]), accounts)).toEqual([
      { steamId: "family-b", personaName: "Family B", localUsername: "familyb", kind: "family" }
    ]);
  });

  it("treats paired family lenders as owners", () => {
    expect(resolveLaunchableSteamAccounts(game([
      {
        provider: "steam",
        externalId: "10",
        shareType: "family",
        ownerSteamid: "family-b",
        familyOwnerSteamIds: ["owner-a"]
      }
    ]), accounts)).toEqual([
      { steamId: "owner-a", personaName: "Owner A", localUsername: "ownera", kind: "owner" },
      { steamId: "family-b", personaName: "Family B", localUsername: "familyb", kind: "family" }
    ]);
  });

  it("dedupes accounts and promotes owners ahead of family options", () => {
    expect(resolveLaunchableSteamAccounts(game([
      { provider: "steam", externalId: "10", shareType: "family", ownerSteamid: "family-b", familyOwnerSteamIds: ["owner-c"] },
      { provider: "steam", externalId: "10", shareType: "owned", ownerSteamid: "family-b" },
      { provider: "steam", externalId: "10", shareType: "owned", ownerSteamid: "owner-a" }
    ]), accounts)).toEqual([
      { steamId: "owner-c", personaName: "Owner C", localUsername: undefined, kind: "owner" },
      { steamId: "family-b", personaName: "Family B", localUsername: "familyb", kind: "owner" },
      { steamId: "owner-a", personaName: "Owner A", localUsername: "ownera", kind: "owner" }
    ]);
  });
});
