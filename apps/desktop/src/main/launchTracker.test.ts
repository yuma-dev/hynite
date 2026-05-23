import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HyniteRepository } from "@hynite/db";

const spawnMock = vi.hoisted(() => vi.fn());
const openPathMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

vi.mock("electron", () => ({
  shell: {
    openPath: openPathMock
  }
}));

import { LaunchTracker } from "./launchTracker";

class FakeChildProcess extends EventEmitter {
  pid = 1234;
  unref = vi.fn();
}

function repositoryMock(): HyniteRepository {
  return {
    addPlaytime: vi.fn()
  } as unknown as HyniteRepository;
}

describe("LaunchTracker", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    openPathMock.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("rejects spawn errors before marking a local game as launched", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const repository = repositoryMock();
    const tracker = new LaunchTracker(repository);
    const promise = tracker.spawnAndTrack("local:1", "C:\\Games\\Denied\\game.exe");
    const error = Object.assign(new Error("spawn C:\\Games\\Denied\\game.exe EACCES"), {
      code: "EACCES",
      path: "C:\\Games\\Denied\\game.exe"
    });

    child.emit("error", error);

    await expect(promise).rejects.toMatchObject({ code: "EACCES" });
    expect(repository.addPlaytime).not.toHaveBeenCalled();
  });

  it("marks a local game as launched only after the spawn event", async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const repository = repositoryMock();
    const tracker = new LaunchTracker(repository);
    const promise = tracker.spawnAndTrack("local:1", "C:\\Games\\Ok\\game.exe");

    expect(repository.addPlaytime).not.toHaveBeenCalled();
    child.emit("spawn");
    const session = await promise;

    expect(session.pid).toBe(1234);
    expect(repository.addPlaytime).toHaveBeenCalledWith("local:1", 0, session.startedAt);
  });

  it("converts shell openPath failures into launch errors", async () => {
    openPathMock.mockResolvedValue("Access is denied.");
    const repository = repositoryMock();
    const tracker = new LaunchTracker(repository);

    await expect(tracker.spawnAndTrack("local:1", "C:\\Games\\Denied\\game.lnk"))
      .rejects.toMatchObject({
        code: "EOPENPATH",
        path: "C:\\Games\\Denied\\game.lnk"
      });
    expect(repository.addPlaytime).not.toHaveBeenCalled();
  });
});
