import { describe, expect, it } from "vitest";
import { computeUpdatedLoginUsers, computeUpdatedSteamUserChooserConfig } from "../src/steam/loginUsers";
import type { VdfObject } from "../src/steam/vdf";

describe("Steam login user switching", () => {
  it("marks the selected account as recent and eligible for autologin", () => {
    const root: VdfObject = {
      users: {
        "111": {
          AccountName: "old",
          MostRecent: "1",
          Timestamp: "100",
          RememberPassword: "1",
          AllowAutoLogin: "1"
        },
        "222": {
          AccountName: "target",
          MostRecent: "0",
          Timestamp: "50",
          RememberPassword: "0",
          AllowAutoLogin: "0"
        }
      }
    };

    const updated = computeUpdatedLoginUsers(root, "222", 200);
    const users = updated.users as Record<string, Record<string, string>>;

    expect(users["111"]).toMatchObject({ MostRecent: "0" });
    expect(users["222"]).toMatchObject({
      MostRecent: "1",
      Timestamp: "200",
      RememberPassword: "1",
      AllowAutoLogin: "1"
    });
  });

  it("disables Steam's startup account chooser in config.vdf", () => {
    const root: VdfObject = {
      InstallConfigStore: {
        Software: {
          Valve: {
            Steam: {
              AlwaysShowUserChooser: "1",
              StartupPage: "1"
            }
          }
        }
      }
    };

    const updated = computeUpdatedSteamUserChooserConfig(root, false);
    const steam = (((updated.InstallConfigStore as VdfObject).Software as VdfObject).Valve as VdfObject).Steam as VdfObject;

    expect(steam.AlwaysShowUserChooser).toBe("0");
    expect(steam.StartupPage).toBe("1");
  });
});
