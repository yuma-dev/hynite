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

  it("disposes an idle bridge process after the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new NativeBridge({ idleTimeoutMs: 1_000 }) as any;
      const kill = vi.fn();
      bridge.process = { killed: false, kill };

      bridge.scheduleIdleDispose();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(kill).toHaveBeenCalled();
      expect((bridge as NativeBridge).getProcessInfo().running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
