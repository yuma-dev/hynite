import { describe, expect, it, vi } from "vitest";
import { searchSteamStore } from "./steamSearchService";

function response(items: unknown[], ok = true) {
  return {
    ok,
    json: async () => ({ items })
  };
}

describe("searchSteamStore", () => {
  it("maps Steam StoreSearch JSON to search results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([
      {
        type: "app",
        id: 1091500,
        name: "Cyberpunk 2077",
        tiny_image: "capsule.jpg",
        metascore: "86",
        price: { final: 5999 }
      }
    ]));

    await expect(searchSteamStore("cyberpunk", fetchMock)).resolves.toEqual([
      {
        appId: "1091500",
        title: "Cyberpunk 2077",
        capsuleUrl: "capsule.jpg",
        price: "$59.99",
        reviewSummary: "Metascore 86"
      }
    ]);
  });

  it("dedupes fallback app ids and keeps full-query results first", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([
        { type: "app", id: 1, name: "Cyber Punk Runner", price: { final: 0 } }
      ]))
      .mockResolvedValueOnce(response([
        { type: "app", id: 1, name: "Cyber Punk Runner", price: { final: 0 } },
        { type: "app", id: 2, name: "Cyberpunk 2077", price: { final: 5999 } }
      ]))
      .mockResolvedValue(response([]));

    const results = await searchSteamStore("cyber punk", fetchMock);

    expect(results.map((result) => result.appId)).toEqual(["1", "2"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://store.steampowered.com/api/storesearch/?term=cyber%20punk&l=english&cc=us",
      expect.any(Object)
    );
  });

  it("returns an empty array when Steam returns a failed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([], false));

    await expect(searchSteamStore("cyberpunk", fetchMock)).resolves.toEqual([]);
  });
});
