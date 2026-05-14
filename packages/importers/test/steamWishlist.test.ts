import { describe, expect, it } from "vitest";
import { fetchSteamWishlist } from "../src/steam/wishlist";

describe("fetchSteamWishlist", () => {
  it("parses wishlist items from Steam response wrappers", async () => {
    const fetchMock = async (url: string) => {
      expect(url).toContain("IWishlistService/GetWishlist");
      expect(url).toContain("steamid=76561198000000000");
      return new Response(
        JSON.stringify({
          response: {
            items: [
              { appid: 123, priority: 2, date_added: 1700000000 },
              { appid: "456", time_added: "2024-01-02T03:04:05.000Z" }
            ]
          }
        }),
        { status: 200 }
      );
    };

    await expect(fetchSteamWishlist({ steamId: "76561198000000000", fetchImpl: fetchMock as typeof fetch })).resolves.toEqual([
      { appid: "123", priority: 2, addedAt: "2023-11-14T22:13:20.000Z" },
      { appid: "456", addedAt: "2024-01-02T03:04:05.000Z" }
    ]);
  });

  it("handles empty wishlist arrays", async () => {
    const fetchMock = async () => new Response(JSON.stringify({ response: { items: [] } }), { status: 200 });

    await expect(fetchSteamWishlist({ steamId: "76561198000000000", fetchImpl: fetchMock as typeof fetch })).resolves.toEqual([]);
  });

  it("rejects malformed wishlist responses", async () => {
    const fetchMock = async () => new Response(JSON.stringify({ response: { nope: true } }), { status: 200 });

    await expect(fetchSteamWishlist({ steamId: "76561198000000000", fetchImpl: fetchMock as typeof fetch })).rejects.toThrow("parseable");
  });

  it("propagates non-OK Steam responses", async () => {
    const fetchMock = async () => new Response("Forbidden", { status: 403 });

    await expect(fetchSteamWishlist({ steamId: "76561198000000000", fetchImpl: fetchMock as typeof fetch })).rejects.toThrow("403");
  });
});
