import { describe, expect, it } from "vitest";
import { clampIndex, getGridRenderCount, getShelfWindow } from "./bigPictureLayout";

describe("bigPictureLayout", () => {
  describe("clampIndex", () => {
    it("returns 0 for empty counts", () => {
      expect(clampIndex(12, 0)).toBe(0);
      expect(clampIndex(-4, -1)).toBe(0);
    });

    it("clamps indexes into the available range", () => {
      expect(clampIndex(-1, 5)).toBe(0);
      expect(clampIndex(2, 5)).toBe(2);
      expect(clampIndex(8, 5)).toBe(4);
    });
  });

  describe("getShelfWindow", () => {
    it("starts at 0 and includes after overscan for the first game", () => {
      expect(getShelfWindow({ focusedIndex: 0, count: 20, overscanBefore: 1, overscanAfter: 8 })).toEqual({
        start: 0,
        end: 9,
        focusOffset: 0
      });
    });

    it("includes before overscan, focus, and after overscan in the middle", () => {
      expect(getShelfWindow({ focusedIndex: 6, count: 20, overscanBefore: 1, overscanAfter: 8 })).toEqual({
        start: 5,
        end: 15,
        focusOffset: 1
      });
    });

    it("does not exceed count near the end", () => {
      expect(getShelfWindow({ focusedIndex: 19, count: 20, overscanBefore: 1, overscanAfter: 8 })).toEqual({
        start: 18,
        end: 20,
        focusOffset: 1
      });
    });

    it("sets focusOffset to focusedIndex minus start", () => {
      const window = getShelfWindow({ focusedIndex: 12, count: 30, overscanBefore: 3, overscanAfter: 4 });
      expect(window.focusOffset).toBe(12 - window.start);
    });
  });

  describe("getGridRenderCount", () => {
    it("renders the minimum rows initially", () => {
      expect(getGridRenderCount({
        count: 100,
        focusedIndex: 0,
        columns: 6,
        currentRenderCount: 0,
        minimumRows: 4,
        overscanRows: 2,
        batchRows: 3
      })).toBe(36);
    });

    it("grows to include a focused index beyond the current render count", () => {
      expect(getGridRenderCount({
        count: 100,
        focusedIndex: 47,
        columns: 6,
        currentRenderCount: 36,
        minimumRows: 4,
        overscanRows: 2,
        batchRows: 3
      })).toBe(72);
    });

    it("never exceeds total count", () => {
      expect(getGridRenderCount({
        count: 50,
        focusedIndex: 49,
        columns: 6,
        currentRenderCount: 48,
        minimumRows: 4,
        overscanRows: 2,
        batchRows: 3
      })).toBe(50);
    });

    it("preserves current render count when already sufficient", () => {
      expect(getGridRenderCount({
        count: 100,
        focusedIndex: 5,
        columns: 6,
        currentRenderCount: 54,
        minimumRows: 4,
        overscanRows: 2,
        batchRows: 3
      })).toBe(54);
    });
  });
});
