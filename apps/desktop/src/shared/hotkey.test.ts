import { describe, expect, it } from "vitest";
import { acceleratorFromHotkeyInput, normalizeAcceleratorText } from "./hotkey";

describe("hotkey accelerator helpers", () => {
  it("captures Windows/Super space chords", () => {
    expect(acceleratorFromHotkeyInput({ key: " ", code: "Space", metaKey: true })).toBe("Super+Space");
  });

  it("captures documented Electron numpad and media accelerator names", () => {
    expect(acceleratorFromHotkeyInput({ key: "+", code: "NumpadAdd", altKey: true })).toBe("Alt+numadd");
    expect(acceleratorFromHotkeyInput({ key: "AudioVolumeUp", ctrlKey: true })).toBe("Ctrl+VolumeUp");
  });

  it("normalizes typed accelerator text", () => {
    expect(normalizeAcceleratorText("Windows + Space")).toBe("Super+Space");
    expect(normalizeAcceleratorText("Ctrl + numadd")).toBe("Ctrl+numadd");
    expect(normalizeAcceleratorText("Ctrl + VolumeUp")).toBe("Ctrl+VolumeUp");
  });
});
