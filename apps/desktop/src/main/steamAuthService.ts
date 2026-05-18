import { BrowserWindow, session } from "electron";
import type { SteamFamilyAuthResult, SteamPairingResult } from "@hynite/core";

const steamOpenIdEndpoint = "https://steamcommunity.com/openid/login";
const returnTo = "https://hynite.local/steam-auth";
const realm = "https://hynite.local/";
function familySessionPartition(steamId: string): string {
  return `persist:steam-family-${steamId}`;
}
const familyTokenEndpoint = "https://store.steampowered.com/pointssummary/ajaxgetasyncconfig";
const familyLoginEntry = "https://store.steampowered.com/login/";
const familyLoginRevealDelayMs = 15_000;

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

export type PairSteamAccountResult = {
  pairing: SteamPairingResult;
  familyResult?: SteamFamilyAuthResult;
};

export async function pairSteamAccount(parent?: BrowserWindow): Promise<PairSteamAccountResult> {
  // Each pairing uses its own in-memory partition so no previous account's
  // Steam cookies bleed in and force an unwanted auto-login.
  const tempPartition = `temp:steam-pair-${Date.now()}`;

  const pairing = await new Promise<SteamPairingResult>((resolve, reject) => {
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
        partition: tempPartition,
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

  // Copy the login session from the temp partition into the per-account family
  // partition so family share is automatically set up without a second login.
  let familyResult: SteamFamilyAuthResult | undefined;
  try {
    const tempSess = session.fromPartition(tempPartition);
    const familySess = session.fromPartition(familySessionPartition(pairing.steamId));
    const cookies = await tempSess.cookies.get({});
    await Promise.all(
      cookies.map(async (cookie) => {
        const domain = (cookie.domain ?? "").replace(/^\./, "");
        const url = `https://${domain}${cookie.path ?? "/"}`;
        try {
          await familySess.cookies.set({ url, ...cookie });
        } catch {
          // individual cookie may be rejected (e.g. secure flag mismatch); skip it
        }
      })
    );
    familyResult = asyncConfigToResult(await fetchAsyncConfigFromPartition(pairing.steamId)) ?? undefined;
  } catch (error) {
    console.warn("[steam:pair] could not capture family session from pairing login:", error);
  }

  return { pairing, familyResult };
}

type AsyncConfigResponse = {
  success?: number;
  data?: {
    webapi_token?: string;
    steamid?: string;
  };
};

function decodeJwtPayload(token: string): { exp?: number; sub?: string } | undefined {
  const segments = token.split(".");
  const payloadSegment = segments[1];
  if (!payloadSegment) {
    return undefined;
  }
  try {
    const payload = Buffer.from(payloadSegment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(payload) as { exp?: number; sub?: string };
  } catch {
    return undefined;
  }
}

async function fetchAsyncConfigFromPartition(steamId: string): Promise<AsyncConfigResponse | undefined> {
  const partition = session.fromPartition(familySessionPartition(steamId));
  try {
    const response = await partition.fetch(familyTokenEndpoint, { credentials: "include", redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      return undefined;
    }
    if (!response.ok) {
      return undefined;
    }
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) {
      return undefined;
    }
    return JSON.parse(trimmed) as AsyncConfigResponse;
  } catch {
    return undefined;
  }
}

async function readAsyncConfigFromBrowser(window: BrowserWindow): Promise<AsyncConfigResponse | undefined> {
  const script = `
    fetch(${JSON.stringify(familyTokenEndpoint)}, { credentials: 'include' })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        return { ok: true, text: text };
      })
      .catch(function (err) { return { ok: false, error: String(err) }; });
  `;
  try {
    const result = (await window.webContents.executeJavaScript(script, true)) as
      | { ok: true; text: string }
      | { ok: false; error: string };
    if (!result.ok) {
      console.warn("[steam:family] in-page fetch failed:", result.error);
      return undefined;
    }
    const trimmed = result.text.trim();
    console.info("[steam:family] raw response (first 300 chars):", trimmed.slice(0, 300));
    if (!trimmed.startsWith("{")) {
      console.warn("[steam:family] response not JSON");
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed) as AsyncConfigResponse;
      console.info("[steam:family] parsed keys:", Object.keys(parsed), "data keys:", parsed.data ? Object.keys(parsed.data) : "none");
      return parsed;
    } catch (error) {
      console.warn("[steam:family] JSON parse failed:", error);
      return undefined;
    }
  } catch (error) {
    console.warn("[steam:family] executeJavaScript failed:", error);
    return undefined;
  }
}

async function isSteamSessionLoggedIn(steamId: string): Promise<boolean> {
  const partition = session.fromPartition(familySessionPartition(steamId));
  const named = await partition.cookies.get({ name: "steamLoginSecure" });
  if (named.length > 0) {
    return true;
  }
  const all = await partition.cookies.get({});
  return all.some((cookie) => cookie.name === "steamLoginSecure");
}

function asyncConfigToResult(response: AsyncConfigResponse | undefined): SteamFamilyAuthResult | undefined {
  if (!response || response.success !== 1) {
    return undefined;
  }
  const token = response.data?.webapi_token;
  if (!token) {
    return undefined;
  }
  const payload = decodeJwtPayload(token);
  const steamId = response.data?.steamid ?? payload?.sub;
  if (!steamId) {
    return undefined;
  }
  const expiresAt = typeof payload?.exp === "number"
    ? new Date(payload.exp * 1000).toISOString()
    : new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
  return { accessToken: token, steamId, expiresAt };
}

export function authenticateSteamSession(parent: BrowserWindow | undefined, steamId: string): Promise<SteamFamilyAuthResult> {
  return new Promise((resolve, reject) => {
    const partition = familySessionPartition(steamId);
    const authWindow = new BrowserWindow({
      width: 960,
      height: 720,
      minWidth: 720,
      minHeight: 560,
      show: false,
      parent,
      modal: Boolean(parent),
      title: "Connect Steam family library",
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    let settled = false;
    let probing = false;
    const revealTimer = setTimeout(() => {
      if (settled || authWindow.isDestroyed()) {
        return;
      }
      authWindow.show();
      authWindow.focus();
    }, familyLoginRevealDelayMs);

    function settle(error: Error | undefined, result?: SteamFamilyAuthResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(revealTimer);
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
    }

    async function probeAfterLogin(): Promise<void> {
      if (settled || probing) {
        return;
      }
      probing = true;
      try {
        if (authWindow.isDestroyed()) {
          return;
        }

        const url = authWindow.webContents.getURL();
        console.info("[steam:family] probe tick @", url);
        if (!url.includes("steampowered.com") && !url.includes("steamcommunity.com")) {
          return;
        }
        const loggedIn = await isSteamSessionLoggedIn(steamId);
        if (!loggedIn) {
          const sess = session.fromPartition(familySessionPartition(steamId));
          const all = await sess.cookies.get({});
          console.info(
            "[steam:family] not logged in yet. cookie names:",
            all.map((cookie) => `${cookie.name}@${cookie.domain}`).slice(0, 20)
          );
          return;
        }
        console.info("[steam:family] login detected; attempting token extraction");
        const fromBrowser = asyncConfigToResult(await readAsyncConfigFromBrowser(authWindow));
        if (fromBrowser) {
          console.info("[steam:family] token extracted successfully");
          settle(undefined, fromBrowser);
        } else {
          console.warn("[steam:family] extraction returned no token");
        }
      } catch (error) {
        console.warn("[steam:family] probe failed", error);
      } finally {
        probing = false;
      }
    }

    authWindow.webContents.on("did-navigate", () => void probeAfterLogin());
    authWindow.webContents.on("did-frame-navigate", () => void probeAfterLogin());
    authWindow.webContents.on("did-finish-load", () => void probeAfterLogin());

    const pollInterval = setInterval(() => void probeAfterLogin(), 1500);

    authWindow.on("closed", () => {
      clearInterval(pollInterval);
      clearTimeout(revealTimer);
      if (!settled) {
        reject(new Error("Steam family login was cancelled."));
      }
    });

    void authWindow.loadURL(familyLoginEntry);
  });
}

export async function refreshSteamAccessToken(steamId: string): Promise<SteamFamilyAuthResult | undefined> {
  const config = await fetchAsyncConfigFromPartition(steamId);
  return asyncConfigToResult(config);
}

export async function disconnectSteamFamilySession(steamId: string): Promise<void> {
  const partition = session.fromPartition(familySessionPartition(steamId));
  await partition.clearStorageData();
}
