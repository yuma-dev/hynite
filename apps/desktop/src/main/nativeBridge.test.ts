import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBridge } from "./nativeBridge";

describe("NativeBridge", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns empty running-process results when the bridge request fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bridge = new NativeBridge() as any;
    bridge.request = async () => {
      throw new Error("bridge unavailable");
    };

    await expect((bridge as NativeBridge).getRunningProcesses(["C:\\Games\\Example\\game.exe"])).resolves.toEqual([]);
  });
});
