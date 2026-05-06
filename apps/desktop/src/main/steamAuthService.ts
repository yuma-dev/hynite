import { BrowserWindow } from "electron";
import type { SteamPairingResult } from "@hynite/core";

const steamOpenIdEndpoint = "https://steamcommunity.com/openid/login";
const returnTo = "https://hynite.local/steam-auth";
const realm = "https://hynite.local/";

function buildSteamLoginUrl(): string {
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": realm,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select"
  });

  return `${steamOpenIdEndpoint}?${params.toString()}`;
}

function steamIdFromOpenIdUrl(url: string): string | undefined {
  const claimedId = new URL(url).searchParams.get("openid.claimed_id");
  return claimedId?.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/)?.[1];
}

async function verifySteamOpenId(url: string): Promise<boolean> {
  const params = new URL(url).searchParams;
  params.set("openid.mode", "check_authentication");

  const response = await fetch(steamOpenIdEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!response.ok) {
    return false;
  }

  return (await response.text()).includes("is_valid:true");
}

export function pairSteamAccount(parent?: BrowserWindow): Promise<SteamPairingResult> {
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 960,
      height: 720,
      minWidth: 720,
      minHeight: 560,
      parent,
      modal: Boolean(parent),
      title: "Pair Steam account",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    let settled = false;

    async function finish(url: string): Promise<void> {
      if (settled || !url.startsWith(returnTo)) {
        return;
      }

      settled = true;
      try {
        const steamId = steamIdFromOpenIdUrl(url);
        if (!steamId) {
          throw new Error("Steam did not return a SteamID.");
        }
        if (!(await verifySteamOpenId(url))) {
          throw new Error("Steam login response could not be verified.");
        }

        resolve({ steamId, pairedAt: new Date().toISOString() });
        authWindow.close();
      } catch (error) {
        reject(error);
        authWindow.close();
      }
    }

    authWindow.webContents.on("will-redirect", (_event, url) => void finish(url));
    authWindow.webContents.on("will-navigate", (_event, url) => void finish(url));
    authWindow.on("closed", () => {
      if (!settled) {
        reject(new Error("Steam pairing was cancelled."));
      }
    });

    void authWindow.loadURL(buildSteamLoginUrl());
  });
}
