import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalImportService } from "./localImportService";
import type { NativeBridge } from "./nativeBridge";

const tempRoots: string[] = [];

describe("LocalImportService", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it("skips unchanged cached candidates before PE lookup and metadata refresh", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "hynite-local-import-"));
    tempRoots.push(tempRoot);
    const gamesRoot = join(tempRoot, "games");
    const gameDir = join(gamesRoot, "Example");
    const exePath = join(gameDir, "Example.exe");
    await mkdir(gameDir, { recursive: true });
    await writeFile(exePath, "");

    const repository = {
      upsertImportedGame: vi.fn((game) => ({ id: `local:${game.externalId}`, ...game })),
      attachSecondarySource: vi.fn(),
      applyMetadata: vi.fn()
    };
    const nativeBridge = {
      getFileVersionInfo: vi.fn(async (paths: string[]) => paths.map((path) => ({
        path,
        exists: true,
        size: 1,
        productName: "Example"
      })))
    };
    const service = new LocalImportService(
      join(tempRoot, "local-scan-cache.json"),
      repository as never,
      nativeBridge as unknown as NativeBridge
    );

    const first = await service.run({
      roots: [{ path: gamesRoot, depth: 1 }],
      excludePatterns: [],
      skipUnchanged: true
    });
    const second = await service.run({
      roots: [{ path: gamesRoot, depth: 1 }],
      excludePatterns: [],
      skipUnchanged: true
    });

    expect(first).toMatchObject({ scanned: 1, skipped: 0, imported: 1 });
    expect(second).toMatchObject({ scanned: 1, skipped: 1, imported: 0 });
    expect(nativeBridge.getFileVersionInfo).toHaveBeenCalledTimes(1);
    expect(repository.upsertImportedGame).toHaveBeenCalledTimes(1);
    expect(repository.applyMetadata).toHaveBeenCalledTimes(1);
  });

  it("persists local scan issues across service instances until cleared", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "hynite-local-import-"));
    tempRoots.push(tempRoot);
    const gamesRoot = join(tempRoot, "games");
    const gameDir = join(gamesRoot, "Unknown");
    const exePath = join(gameDir, "Unknown.exe");
    const cachePath = join(tempRoot, "local-scan-cache.json");
    await mkdir(gameDir, { recursive: true });
    await writeFile(exePath, "");

    const repository = {
      upsertImportedGame: vi.fn((game) => ({ id: `local:${game.externalId}`, ...game })),
      attachSecondarySource: vi.fn(),
      applyMetadata: vi.fn()
    };
    const nativeBridge = {
      getFileVersionInfo: vi.fn(async (paths: string[]) => paths.map((path) => ({
        path,
        exists: true,
        size: 1
      })))
    };

    const service = new LocalImportService(cachePath, repository as never, nativeBridge as unknown as NativeBridge);
    const result = await service.run({
      roots: [{ path: gamesRoot, depth: 1 }],
      excludePatterns: [],
      searchSteamStore: async () => []
    });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toBe("unmatched");

    const restarted = new LocalImportService(cachePath, repository as never, nativeBridge as unknown as NativeBridge);
    expect(await restarted.getIssues()).toEqual([
      expect.objectContaining({ candidateId: result.issues[0]?.candidateId, reason: "unmatched" })
    ]);

    await restarted.run({
      roots: [{ path: join(tempRoot, "missing-root"), depth: 1 }],
      excludePatterns: []
    });
    expect(await restarted.getIssues()).toEqual([
      expect.objectContaining({ candidateId: result.issues[0]?.candidateId, reason: "unmatched" })
    ]);

    await restarted.clearIssue(result.issues[0]!.candidateId);
    const reopened = new LocalImportService(cachePath, repository as never, nativeBridge as unknown as NativeBridge);
    expect(await reopened.getIssues()).toEqual([]);
  });
});
