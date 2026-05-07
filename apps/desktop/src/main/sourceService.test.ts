import { afterEach, describe, expect, it, vi } from "vitest";
import type { HyniteRepository } from "@hynite/db";
import { SourceService } from "./sourceService";

function makeRepository() {
  return {
    saveDownloadSource: vi.fn(),
    getGame: vi.fn(),
    listDownloadEntries: vi.fn(() => [])
  } as unknown as HyniteRepository;
}

describe("SourceService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches remote sources with browser-compatible headers", async () => {
    const repository = makeRepository();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "Remote",
          downloads: []
        }),
        { status: 200 }
      )
    );

    await new SourceService(repository).import({ kind: "url", value: "https://example.com/source.json" });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://example.com/source.json"),
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "application/json, text/plain, */*",
          "user-agent": expect.stringContaining("Mozilla/5.0")
        }),
        redirect: "follow"
      })
    );
    expect(repository.saveDownloadSource).toHaveBeenCalledWith(expect.objectContaining({ name: "Remote" }));
  });
});
