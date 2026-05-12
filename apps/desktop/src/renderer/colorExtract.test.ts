import { describe, expect, it } from "vitest";
import { expandPaletteToSlots, extractPaletteFromPixels } from "./colorExtract";

function rgbaPixels(colors: Array<[number, number, number, number?]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(colors.length * 4);
  colors.forEach(([r, g, b, a = 255], i) => {
    const offset = i * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = a;
  });
  return data;
}

describe("colorExtract", () => {
  it("keeps the dominant cover color dominant over saturated detail colors", () => {
    const pixels = rgbaPixels([
      ...Array.from({ length: 72 }, () => [246, 33, 34] as [number, number, number]),
      ...Array.from({ length: 10 }, () => [236, 198, 62] as [number, number, number]),
      ...Array.from({ length: 8 }, () => [96, 166, 205] as [number, number, number]),
      ...Array.from({ length: 5 }, () => [10, 10, 10] as [number, number, number]),
      ...Array.from({ length: 5 }, () => [250, 250, 250] as [number, number, number])
    ]);

    const palette = extractPaletteFromPixels(pixels);

    expect(palette?.colors[0]?.hex).toBe("#ef2829");
    expect(palette?.colors[0]?.weight).toBeGreaterThan(0.75);
  });

  it("ignores black and white cover space when choosing art colors", () => {
    const pixels = rgbaPixels([
      ...Array.from({ length: 60 }, () => [5, 5, 7] as [number, number, number]),
      ...Array.from({ length: 28 }, () => [246, 246, 242] as [number, number, number]),
      ...Array.from({ length: 8 }, () => [42, 166, 83] as [number, number, number]),
      ...Array.from({ length: 4 }, () => [221, 96, 30] as [number, number, number])
    ]);

    const palette = extractPaletteFromPixels(pixels);

    expect(palette?.colors.map((c) => c.hex)).toEqual(["#2aa653", "#dd601e"]);
  });

  it("allocates all shader slots according to normalized weights", () => {
    const slots = expandPaletteToSlots(
      {
        colors: [
          { hex: "#ff0000", weight: 0.72 },
          { hex: "#ffff00", weight: 0.18 },
          { hex: "#0066cc", weight: 0.1 }
        ]
      },
      8
    );

    expect(slots).toHaveLength(8);
    expect(slots.filter((slot) => slot === "#ff0000")).toHaveLength(6);
    expect(slots.filter((slot) => slot === "#ffff00")).toHaveLength(1);
    expect(slots.filter((slot) => slot === "#0066cc")).toHaveLength(1);
  });
});
