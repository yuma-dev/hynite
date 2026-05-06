import { describe, expect, it } from "vitest";
import { parseVdf } from "../src/steam/vdf";

describe("parseVdf", () => {
  it("parses nested Steam library folders", () => {
    const parsed = parseVdf(`
      "libraryfolders"
      {
        "0"
        {
          "path" "C:\\\\Program Files (x86)\\\\Steam"
          "label" ""
        }
        "1"
        {
          "path" "D:\\\\SteamLibrary"
        }
      }
    `);

    expect(parsed).toEqual({
      libraryfolders: {
        "0": {
          path: "C:\\Program Files (x86)\\Steam",
          label: ""
        },
        "1": {
          path: "D:\\SteamLibrary"
        }
      }
    });
  });
});

