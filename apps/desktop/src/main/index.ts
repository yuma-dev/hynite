import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, screen, shell } from "electron";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { HyniteRepository } from "@hynite/db";
import { discoverInstalledSteamApps, readLoginUsers, SteamImporterProvider, type SteamFamilyScanStatus } from "@hynite/importers";
import type { IdentifyCandidate, LocalScanIssue } from "@hynite/importers";
import { LocalImportService } from "./localImportService";
import { LaunchTracker } from "./launchTracker";
import { makeGameId, resolveLaunchableSteamAccounts, type AppSettings, type EncryptedSecret, type Game, type GameAssetCandidate, type GameAssetCandidateResult, type GameAssetKind, type GameAssetUpdate, type GameMetadataPatch, type ImportedGame, type LaunchSession, type LibraryQuery, type ProfileSpanHandle, type ProviderId, type SourceImportInput, type SteamAccountSettings, type SteamLocalAccount, type SteamLaunchAccountOption, type SteamSearchResult, type SyncResult } from "@hynite/core";
import { getActiveSteamUser, switchSteamAccount } from "./steamSwitchService";
import { buildIgdbImageUrl, fetchSteamMetadata, IgdbClient, metadataFromSteamAppInfo, refreshFusedMetadata, type IgdbGame } from "@hynite/metadata";
import { DiagnosticLogService } from "./diagnosticLogService";
import { HomeService } from "./homeService";
import { NativeBridge } from "./nativeBridge";
import { SettingsService } from "./settingsService";
import { SoundFileService } from "./soundFileService";
import { SourceService } from "./sourceService";
import { searchSteamStore } from "./steamSearchService";
import { StartupProfileService } from "./startupProfileService";
import { SyncStatusService } from "./syncStatusService";
import { AssetCacheService } from "./assetCacheService";
import {
  authenticateSteamSession,
  disconnectSteamFamilySession,
  pairSteamAccount,
  refreshSteamAccessToken
} from "./steamAuthService";

let mainWindow: Electron.BrowserWindow | undefined;
let splashWindow: Electron.BrowserWindow | undefined;
let startupReadyTimeout: ReturnType<typeof setTimeout> | undefined;
let repository: HyniteRepository;
let settingsService: SettingsService;
let homeService: HomeService;
let sourceService: SourceService;
let nativeBridge: NativeBridge;
let syncStatusService: SyncStatusService;
let assetCacheService: AssetCacheService;
let soundFileService: SoundFileService;
let diagnosticLogService: DiagnosticLogService;
let localImportService: LocalImportService;
let launchTracker: LaunchTracker;
let activeLocalScan: { promise: Promise<unknown>; controller: AbortController } | undefined;
let startupProfileService: StartupProfileService | undefined;
let startupHeartbeatTimer: NodeJS.Timeout | undefined;
let rendererUnresponsiveAt: number | undefined;

const windowIconPath = join(__dirname, "../../assets/icons/app.ico");
const METADATA_REFRESH_CONCURRENCY = 4;
const RICH_METADATA_CONCURRENCY = 1;
const RICH_METADATA_STARTUP_LIMIT = Number.POSITIVE_INFINITY;
const STARTUP_BACKGROUND_DELAY_MS = 1_000;
const STARTUP_LOCAL_SCAN_DELAY_MS = 3_000;
const STEAM_SYNC_UPSERT_YIELD_INTERVAL = 25;
const STEAM_SYNC_MIN_UPSERT_YIELD_INTERVAL = 5;
protocol.registerSchemesAsPrivileged([
  { scheme: "hynite-asset", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "hynite-sound", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "hynite-music", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);
const richMetadataQueued = new Set<string>();
const richMetadataQueue: string[] = [];
const richMetadataInFlight = new Set<string>();
let richMetadataRunning = 0;
let richMetadataBackfillTotal = 0;
let richMetadataBackfillDone = 0;

const execFileAsync = promisify(execFile);
let systemAudioState = false;
let systemAudioMonitor: ChildProcessWithoutNullStreams | undefined;
let systemAudioMonitorRestartTimer: NodeJS.Timeout | undefined;
let systemAudioMonitorStopped = false;

// SMTC (System Media Transport Controls) — same API Windows uses for the
// volume HUD. Tracks "what media is playing on this system" regardless of
// which audio device routes it. Avoids WASAPI false positives from
// always-on services (nvcontainer, Elgato Wave Link, etc.).
const SMTC_PS_PRELUDE = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } |
  Select-Object -First 1)
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(5000); $task.Result }
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
`.trim();

function buildSystemAudioScript(): string {
  // Returns 'true' if any SMTC session reports PlaybackStatus=Playing(4).
  return `
${SMTC_PS_PRELUDE}
$result = 'false'
if ($mgr -ne $null) {
  foreach ($s in $mgr.GetSessions()) {
    if ([int]$s.GetPlaybackInfo().PlaybackStatus -eq 4) { $result = 'true'; break }
  }
}
Write-Output $result
`.trim();
}

function buildSystemAudioDebugScript(): string {
  return `
${SMTC_PS_PRELUDE}
if ($mgr -eq $null) { Write-Host 'SMTC manager unavailable'; return }
$sessions = @($mgr.GetSessions())
Write-Host ('Total media sessions: ' + $sessions.Count)
$anyPlaying = $false
foreach ($s in $sessions) {
  $info = $s.GetPlaybackInfo()
  $status = [int]$info.PlaybackStatus
  $name = switch ($status) { 0 {'Closed'} 1 {'Opened'} 2 {'Changing'} 3 {'Stopped'} 4 {'PLAYING'} 5 {'Paused'} default {"st$status"} }
  $tag = if ($status -eq 4) { 'COUNT' } else { 'skip' }
  Write-Host ("  [$tag] [$name] " + $s.SourceAppUserModelId)
  if ($status -eq 4) { $anyPlaying = $true }
}
$verdict = if ($anyPlaying) { 'true  -> music paused (external media playing)' } else { 'false -> music plays normally' }
Write-Host ('RESULT: ' + $verdict)
`.trim();
}

// Long-running PowerShell monitor: polls SMTC every 500ms and prints
// "true"/"false" to stdout ONLY when the value changes. Avoids per-check
// process spawn overhead (~500ms per startup) so the launcher reacts to
// play/pause events with ~500ms latency instead of 12s.
function buildSystemAudioMonitorScript(): string {
  return `
${SMTC_PS_PRELUDE}
$last = 'init'
while ($true) {
  $any = $false
  if ($mgr -ne $null) {
    foreach ($s in $mgr.GetSessions()) {
      if ([int]$s.GetPlaybackInfo().PlaybackStatus -eq 4) { $any = $true; break }
    }
  }
  $cur = if ($any) { 'true' } else { 'false' }
  if ($cur -ne $last) { Write-Output $cur; [Console]::Out.Flush(); $last = $cur }
  Start-Sleep -Milliseconds 500
}
`.trim();
}

function setSystemAudioState(value: boolean): void {
  if (systemAudioState === value) return;
  systemAudioState = value;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("music:systemAudioChanged", value);
  }
}

function startSystemAudioMonitor(): void {
  if (process.platform !== "win32" || systemAudioMonitor || systemAudioMonitorStopped) return;
  try {
    const script = buildSystemAudioMonitorScript();
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NonInteractive", "-NoProfile", "-EncodedCommand", encoded], { windowsHide: true });
    systemAudioMonitor = child;
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line === "true") setSystemAudioState(true);
        else if (line === "false") setSystemAudioState(false);
      }
    });
    child.on("exit", () => {
      systemAudioMonitor = undefined;
      if (systemAudioMonitorStopped) return;
      systemAudioMonitorRestartTimer = setTimeout(startSystemAudioMonitor, 5_000);
    });
    child.on("error", () => undefined);
  } catch {
    systemAudioMonitorRestartTimer = setTimeout(startSystemAudioMonitor, 5_000);
  }
}

function stopSystemAudioMonitor(): void {
  systemAudioMonitorStopped = true;
  if (systemAudioMonitorRestartTimer) {
    clearTimeout(systemAudioMonitorRestartTimer);
    systemAudioMonitorRestartTimer = undefined;
  }
  if (systemAudioMonitor) {
    try { systemAudioMonitor.kill(); } catch { /* ignore */ }
    systemAudioMonitor = undefined;
  }
}

function getSystemAudioActive(): boolean {
  return systemAudioState;
}
let activeSteamSync:
  | {
      controller: AbortController;
      promise: Promise<SyncResult>;
    }
  | undefined;
let steamSyncStartLock = Promise.resolve();

class SteamSyncCancelledError extends Error {
  constructor(message = "Steam sync cancelled") {
    super(message);
    this.name = "SteamSyncCancelledError";
  }
}

function profile(phase: string, message: string, details?: Record<string, unknown>): void {
  startupProfileService?.log({ scope: "main", phase, message, details });
}

function profilePoint(category: string, name: string, details?: Record<string, unknown>): void {
  startupProfileService?.point(category, name, details);
}

function profileSpan(category: string, name: string, details?: Record<string, unknown>): ProfileSpanHandle {
  return startupProfileService?.startSpan(category, name, details) ?? { id: "", end: () => undefined };
}

function roundDuration(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function summarizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value as Record<string, unknown>).slice(0, 20) };
  }
  return { type: typeof value };
}

function summarizeIpcArgs(args: unknown[]): unknown[] {
  return args.map(summarizeValue);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function profileIpc<T>(channel: string, task: () => T | Promise<T>): T | Promise<T> {
  const startedAt = performance.now();
  const ipcCallId = randomUUID();
  const span = profileSpan("ipc", "ipc:call", { channel, ipcCallId });

  try {
    const result = task();
    if (result && typeof (result as Promise<T>).then === "function") {
      return (result as Promise<T>)
        .then((value) => {
          span.end("ok", { channel, ipcCallId, durationMs: roundDuration(startedAt), result: summarizeValue(value) });
          return value;
        })
        .catch((error: unknown) => {
          span.end("error", {
            channel,
            ipcCallId,
            durationMs: roundDuration(startedAt),
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        });
    }

    span.end("ok", { channel, ipcCallId, durationMs: roundDuration(startedAt), result: summarizeValue(result) });
    return result;
  } catch (error) {
    span.end("error", {
      channel,
      ipcCallId,
      durationMs: roundDuration(startedAt),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function handleIpc(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    profilePoint("ipc", "ipc:invoke", { channel, args: summarizeIpcArgs(args) });
    return profileIpc(channel, () => listener(event, ...args));
  });
}

function startStartupHeartbeat(): void {
  if (!startupProfileService?.enabled || startupHeartbeatTimer) {
    return;
  }

  let lastBeatAt = performance.now();
  let lastElu = performance.eventLoopUtilization?.();
  startupHeartbeatTimer = setInterval(() => {
    const now = performance.now();
    const driftMs = Math.round((now - lastBeatAt - 500) * 10) / 10;
    lastBeatAt = now;
    const nextElu = performance.eventLoopUtilization?.();
    const utilization = lastElu && nextElu ? performance.eventLoopUtilization(nextElu, lastElu).utilization : undefined;
    lastElu = nextElu;
    if (driftMs > 150) {
      startupProfileService?.metric("event-loop", "main:event-loop-drift", driftMs, { utilization }, "main");
      startupProfileService?.recordFreeze("main", driftMs, "heartbeat", { utilization });
    }
  }, 500);
  startupHeartbeatTimer.unref?.();
}

function isSteamSyncCancelledError(error: unknown): error is SteamSyncCancelledError {
  return error instanceof SteamSyncCancelledError || (error instanceof Error && error.name === "AbortError");
}

function throwIfSteamSyncCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SteamSyncCancelledError(typeof signal.reason === "string" ? signal.reason : "Steam sync cancelled");
  }
}

async function cancelActiveSteamSync(reason = "Steam sync cancelled"): Promise<void> {
  const active = activeSteamSync;
  if (!active) {
    return;
  }

  active.controller.abort(reason);
  await active.promise.catch(() => undefined);
}

async function withSteamSyncStartLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = steamSyncStartLock;
  let release: () => void = () => undefined;
  steamSyncStartLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
}

const FAMILY_TOKEN_REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

async function resolveFamilyAccessTokenForAccount(account: SteamAccountSettings): Promise<string | undefined> {
  const session = account.familySession;
  if (!session) {
    return undefined;
  }

  const expiresAt = Date.parse(session.expiresAt);
  const now = Date.now();
  const hasUsableExpiry = Number.isFinite(expiresAt);
  const isExpired = !hasUsableExpiry || expiresAt <= now;
  const isExpiringSoon = !hasUsableExpiry || expiresAt - now < FAMILY_TOKEN_REFRESH_THRESHOLD_MS;

  if (!isExpiringSoon) {
    try {
      return await nativeBridge.decryptSecret(session.accessToken);
    } catch (error) {
      console.warn("Failed to decrypt Steam family access token", error);
    }
  }

  try {
    const refreshed = await refreshSteamAccessToken();
    if (refreshed && refreshed.steamId === account.steamId) {
      const encrypted = await nativeBridge.encryptSecret({ value: refreshed.accessToken, scope: "current-user" });
      await settingsService.patchSteamAccount(account.steamId, {
        familySession: {
          accessToken: encrypted,
          steamId: refreshed.steamId,
          expiresAt: refreshed.expiresAt,
          connectedAt: session.connectedAt
        }
      });
      return refreshed.accessToken;
    }
  } catch (error) {
    console.warn("Steam family access token refresh failed", error);
  }

  if (!isExpired) {
    try {
      return await nativeBridge.decryptSecret(session.accessToken);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function hasAnyCachedMetadata(game: { metadataStatus: string }): boolean {
  return game.metadataStatus !== "none";
}

function saveSteamRawMetadata(gameId: string, externalId: string, source: string, raw: unknown): void {
  try {
    repository.saveRawGameMetadata({
      gameId,
      provider: "steam",
      externalId,
      source,
      raw
    });
  } catch (error) {
    diagnosticLogService?.log({
      level: "warning",
      phase: "metadata:raw",
      message: `Raw Steam metadata cache write failed for ${externalId}`,
      details: { source, error: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function cacheMetadataAssets(patch: GameMetadataPatch, refresh = false): Promise<GameMetadataPatch> {
  return assetCacheService ? assetCacheService.cacheMetadataPatch(patch, { refresh }) : patch;
}

async function fetchNativeSteamAppInfoMetadata(game: ImportedGame) {
  const span = profileSpan("native-bridge", "steam-appinfo:native", { appid: game.externalId, title: game.title });
  try {
    const appInfo = await nativeBridge.getSteamAppInfo(game.externalId);
    if (appInfo) {
      saveSteamRawMetadata(makeGameId(game.provider, game.externalId), game.externalId, "steam_appinfo", appInfo.raw ?? appInfo);
    }
    const patch = metadataFromSteamAppInfo(
      game.externalId,
      appInfo
        ? {
            name: appInfo.name,
            type: appInfo.type,
            parent: appInfo.parent,
            clienticon: appInfo.clienticon,
            icon: appInfo.icon,
            steamReleaseDate: appInfo.steamReleaseDate,
            headerImage: appInfo.headerImage,
            smallCapsule: appInfo.smallCapsule,
            associations: appInfo.associations,
            libraryAssetsFull: appInfo.libraryAssetsFull,
            libraryAssets: appInfo.libraryAssets,
            extended: appInfo.extended
          }
        : undefined,
      undefined,
      game.title
    );
    span.end("ok", {
      appid: game.externalId,
      title: game.title,
      returned: Boolean(appInfo),
      fields: Object.keys(patch)
    });
    return patch;
  } catch (error) {
    span.end("error", { appid: game.externalId, title: game.title, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await mapper(items[currentIndex] as T, currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

function steamImportedGameFromGame(game: Game): ImportedGame | undefined {
  const steamSource = game.sourceIds.find((source) => source.provider === "steam");
  if (!steamSource) {
    return undefined;
  }

  return {
    provider: "steam",
    externalId: steamSource.externalId,
    title: game.title,
    installState: game.installState,
    installDirectory: game.installDirectory,
    executablePath: game.executablePath,
    playtimeMinutes: game.playtimeMinutes,
    lastPlayedAt: game.lastPlayedAt,
    addedAt: game.addedAt,
    communityIconUrl: game.communityIconUrl
  };
}

type SteamGridDbAsset = {
  id?: number;
  url?: string;
  thumb?: string;
  width?: number;
  height?: number;
  score?: number;
  nsfw?: boolean;
  humor?: boolean;
};

type SteamGridDbGame = {
  id?: number;
  name?: string;
};

type SteamGridDbListResponse<T> = {
  success?: boolean;
  data?: T[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function localizedAssetEntries(value: unknown): Array<{ label: string; path: string }> {
  if (typeof value === "string" && value) {
    return [{ label: "default", path: value }];
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]))
    .map(([label, path]) => ({ label, path }));
}

function steamAssetUrl(appid: string, path: string): string {
  return /^https?:\/\//i.test(path)
    ? path
    : `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${encodeURIComponent(appid)}/${path}`;
}

function assetUpdateToPatch(update: GameAssetUpdate): GameMetadataPatch {
  const patch: GameMetadataPatch = {};
  if (Object.prototype.hasOwnProperty.call(update, "grid")) {
    patch.coverUrl = update.grid ?? undefined;
    patch.libraryCapsuleUrl = update.grid ?? undefined;
  }
  if (Object.prototype.hasOwnProperty.call(update, "hero")) patch.backgroundUrl = update.hero ?? undefined;
  if (Object.prototype.hasOwnProperty.call(update, "logo")) patch.logoUrl = update.logo ?? undefined;
  if (Object.prototype.hasOwnProperty.call(update, "icon")) patch.communityIconUrl = update.icon ?? undefined;
  if (Object.prototype.hasOwnProperty.call(update, "header")) patch.headerUrl = update.header ?? undefined;
  if (Object.prototype.hasOwnProperty.call(update, "poster")) patch.trailerPosterUrl = update.poster ?? undefined;
  return patch;
}

function patchToAssetUpdate(patch: GameMetadataPatch, original: GameAssetUpdate): GameAssetUpdate {
  const update: GameAssetUpdate = {};
  if (Object.prototype.hasOwnProperty.call(original, "grid")) update.grid = patch.libraryCapsuleUrl ?? patch.coverUrl ?? null;
  if (Object.prototype.hasOwnProperty.call(original, "hero")) update.hero = patch.backgroundUrl ?? null;
  if (Object.prototype.hasOwnProperty.call(original, "logo")) update.logo = patch.logoUrl ?? null;
  if (Object.prototype.hasOwnProperty.call(original, "icon")) update.icon = patch.communityIconUrl ?? null;
  if (Object.prototype.hasOwnProperty.call(original, "header")) update.header = patch.headerUrl ?? null;
  if (Object.prototype.hasOwnProperty.call(original, "poster")) update.poster = patch.trailerPosterUrl ?? null;
  return update;
}

function isLocalGame(game: Game): boolean {
  return game.sourceIds.some((source) => source.provider === "local");
}

function addAssetCandidate(
  candidates: GameAssetCandidate[],
  seen: Set<string>,
  candidate: Omit<GameAssetCandidate, "id">
): void {
  if (!candidate.url) return;
  const key = `${candidate.kind}\u0000${candidate.url}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({
    ...candidate,
    id: `${candidate.provider}:${candidate.kind}:${candidates.length}`
  });
}

function addCurrentAssetCandidates(game: Game, candidates: GameAssetCandidate[], seen: Set<string>): void {
  const current: Array<{ kind: GameAssetKind; label: string; url?: string }> = [
    { kind: "grid", label: "Current cover", url: game.libraryCapsuleUrl ?? game.coverUrl },
    { kind: "hero", label: "Current hero", url: game.backgroundUrl },
    { kind: "logo", label: "Current logo", url: game.logoUrl },
    { kind: "icon", label: "Current icon", url: game.communityIconUrl },
    { kind: "header", label: "Current header", url: game.headerUrl },
    { kind: "poster", label: "Current trailer poster", url: game.trailerPosterUrl }
  ];
  for (const entry of current) {
    if (entry.url) {
      addAssetCandidate(candidates, seen, {
        provider: "current",
        kind: entry.kind,
        label: entry.label,
        url: entry.url,
        source: "Saved"
      });
    }
  }
}

function addSteamAppInfoAssetCandidates(
  appid: string,
  raw: unknown,
  candidates: GameAssetCandidate[],
  seen: Set<string>
): void {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data[appid] : undefined;
  const common = isRecord(data) && isRecord(data.common) ? data.common : isRecord(raw) && isRecord(raw.common) ? raw.common : undefined;
  if (!isRecord(common)) return;
  const libraryAssets = isRecord(common.library_assets_full)
    ? common.library_assets_full
    : isRecord(common.libraryAssetsFull)
      ? common.libraryAssetsFull
      : undefined;

  const assets: Array<{ kind: GameAssetKind; label: string; entry: unknown; camelEntry?: unknown }> = [
    { kind: "grid", label: "Steam library grid", entry: libraryAssets?.library_capsule, camelEntry: libraryAssets?.libraryCapsule },
    { kind: "hero", label: "Steam library hero", entry: libraryAssets?.library_hero, camelEntry: libraryAssets?.libraryHero },
    { kind: "logo", label: "Steam logo", entry: libraryAssets?.library_logo, camelEntry: libraryAssets?.libraryLogo }
  ];

  for (const asset of assets) {
    const value = isRecord(asset.entry) ? asset.entry : isRecord(asset.camelEntry) ? asset.camelEntry : undefined;
    if (!value) continue;
    for (const scale of ["image", "image2x"] as const) {
      for (const entry of localizedAssetEntries(value[scale])) {
        addAssetCandidate(candidates, seen, {
          provider: "steam",
          kind: asset.kind,
          label: `${asset.label} (${entry.label}${scale === "image2x" ? ", 2x" : ""})`,
          url: steamAssetUrl(appid, entry.path),
          source: "Steam appinfo"
        });
      }
    }
  }

  for (const entry of localizedAssetEntries(common.header_image ?? common.headerImage)) {
    addAssetCandidate(candidates, seen, {
      provider: "steam",
      kind: "header",
      label: `Steam header (${entry.label})`,
      url: steamAssetUrl(appid, entry.path),
      source: "Steam appinfo"
    });
  }
  for (const entry of localizedAssetEntries(common.small_capsule ?? common.smallCapsule)) {
    addAssetCandidate(candidates, seen, {
      provider: "steam",
      kind: "header",
      label: `Steam small capsule (${entry.label})`,
      url: steamAssetUrl(appid, entry.path),
      source: "Steam appinfo"
    });
  }

  const clientIcon = stringValue(common.clienticon);
  const icon = stringValue(common.icon);
  if (clientIcon) {
    addAssetCandidate(candidates, seen, {
      provider: "steam",
      kind: "icon",
      label: "Steam community icon",
      url: `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${encodeURIComponent(appid)}/${clientIcon}.ico`,
      source: "Steam appinfo"
    });
  }
  if (icon) {
    addAssetCandidate(candidates, seen, {
      provider: "steam",
      kind: "icon",
      label: "Steam community image",
      url: `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${encodeURIComponent(appid)}/${icon}.jpg`,
      source: "Steam appinfo"
    });
  }
}

function addSteamStoreAssetCandidates(appid: string, raw: unknown, candidates: GameAssetCandidate[], seen: Set<string>): void {
  const details = isRecord(raw) ? raw[appid] : undefined;
  const data = isRecord(details) && isRecord(details.data) ? details.data : undefined;
  if (!data) return;
  const storeAssets: Array<{ kind: GameAssetKind; field: string; label: string }> = [
    { kind: "header", field: "header_image", label: "Steam Store header" },
    { kind: "header", field: "capsule_image", label: "Steam Store capsule" },
    { kind: "header", field: "capsule_imagev5", label: "Steam Store capsule v5" },
    { kind: "hero", field: "background_raw", label: "Steam Store background" },
    { kind: "hero", field: "background", label: "Steam Store background" }
  ];
  for (const asset of storeAssets) {
    const url = stringValue(data[asset.field]);
    if (url) {
      addAssetCandidate(candidates, seen, {
        provider: "steam",
        kind: asset.kind,
        label: asset.label,
        url,
        source: "Steam Store"
      });
    }
  }

  const screenshots = Array.isArray(data.screenshots) ? data.screenshots : [];
  screenshots.slice(0, 24).forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const full = stringValue(entry.path_full);
    const thumb = stringValue(entry.path_thumbnail);
    if (full) {
      addAssetCandidate(candidates, seen, {
        provider: "steam",
        kind: "hero",
        label: `Steam screenshot ${index + 1}`,
        url: full,
        thumbnailUrl: thumb,
        source: "Steam Store"
      });
    }
  });

  const movies = Array.isArray(data.movies) ? data.movies : [];
  movies.slice(0, 8).forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const thumb = stringValue(entry.thumbnail);
    if (thumb) {
      addAssetCandidate(candidates, seen, {
        provider: "steam",
        kind: "poster",
        label: `Steam trailer poster ${index + 1}`,
        url: thumb,
        source: "Steam Store"
      });
    }
  });
}

async function fetchSteamAssetCandidates(gameId: string, appid: string, candidates: GameAssetCandidate[], seen: Set<string>, warnings: string[]): Promise<void> {
  try {
    const response = await fetch(`https://api.steamcmd.net/v1/info/${encodeURIComponent(appid)}`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const raw = await response.json();
    saveSteamRawMetadata(gameId, appid, "steam_appinfo", raw);
    addSteamAppInfoAssetCandidates(appid, raw, candidates, seen);
  } catch (error) {
    const cached = repository.getRawGameMetadata("steam", appid, "steam_appinfo")?.raw;
    if (cached) {
      addSteamAppInfoAssetCandidates(appid, cached, candidates, seen);
    } else {
      warnings.push(`Steam appinfo assets unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(appid)}&cc=us&l=english`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const raw = await response.json();
    saveSteamRawMetadata(gameId, appid, "steam_appdetails", raw);
    addSteamStoreAssetCandidates(appid, raw, candidates, seen);
  } catch (error) {
    const cached = repository.getRawGameMetadata("steam", appid, "steam_appdetails")?.raw;
    if (cached) {
      addSteamStoreAssetCandidates(appid, cached, candidates, seen);
    } else {
      warnings.push(`Steam Store assets unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function fetchSteamGridDbList(path: string, idKind: "steam" | "game", id: string | number, apiKey: string): Promise<SteamGridDbAsset[]> {
  const response = await fetch(`https://www.steamgriddb.com/api/v2/${path}/${idKind}/${encodeURIComponent(String(id))}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as SteamGridDbListResponse<SteamGridDbAsset>;
  return json.data ?? [];
}

async function fetchSteamGridDbSearch(title: string, apiKey: string): Promise<SteamGridDbGame | undefined> {
  const response = await fetch(`https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(title)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as SteamGridDbListResponse<SteamGridDbGame>;
  const normalized = title.trim().toLocaleLowerCase();
  return (json.data ?? []).find((entry) => entry.name?.trim().toLocaleLowerCase() === normalized) ?? json.data?.[0];
}

async function fetchSteamGridDbCandidates(
  game: Game,
  apiKey: string | undefined,
  candidates: GameAssetCandidate[],
  seen: Set<string>,
  warnings: string[]
): Promise<void> {
  if (!apiKey) {
    warnings.push("SteamGridDB API key is not configured.");
    return;
  }
  const steamGridDbApiKey = apiKey;
  const mappings: Array<{ path: string; kind: GameAssetKind; label: string }> = [
    { path: "grids", kind: "grid", label: "SteamGridDB grid" },
    { path: "heroes", kind: "hero", label: "SteamGridDB hero" },
    { path: "logos", kind: "logo", label: "SteamGridDB logo" },
    { path: "icons", kind: "icon", label: "SteamGridDB icon" }
  ];
  const appid = steamImportedGameFromGame(game)?.externalId;
  let foundAny = false;

  async function loadBy(idKind: "steam" | "game", id: string | number) {
    await Promise.all(mappings.map(async (mapping) => {
      try {
        const assets = await fetchSteamGridDbList(mapping.path, idKind, id, steamGridDbApiKey);
        assets.slice(0, 64).forEach((asset, index) => {
          if (!asset.url) return;
          foundAny = true;
          addAssetCandidate(candidates, seen, {
            provider: "steamgriddb",
            kind: mapping.kind,
            label: `${mapping.label} ${index + 1}`,
            url: asset.url,
            thumbnailUrl: asset.thumb,
            width: numberValue(asset.width),
            height: numberValue(asset.height),
            score: numberValue(asset.score),
            nsfw: booleanValue(asset.nsfw),
            humor: booleanValue(asset.humor),
            source: "SteamGridDB"
          });
        });
      } catch (error) {
        warnings.push(`${mapping.label} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  if (appid) {
    await loadBy("steam", appid);
  }
  if (!foundAny) {
    try {
      const match = await fetchSteamGridDbSearch(game.title, steamGridDbApiKey);
      if (match?.id) {
        await loadBy("game", match.id);
      } else {
        warnings.push("SteamGridDB did not find a title match.");
      }
    } catch (error) {
      warnings.push(`SteamGridDB search unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function addIgdbAssetCandidates(game: IgdbGame, candidates: GameAssetCandidate[], seen: Set<string>): void {
  if (game.cover?.image_id) {
    addAssetCandidate(candidates, seen, {
      provider: "igdb",
      kind: "grid",
      label: "IGDB cover",
      url: buildIgdbImageUrl(game.cover.image_id, "cover_big"),
      source: "IGDB"
    });
  }
  game.artworks?.forEach((entry, index) => {
    if (!entry.image_id) return;
    addAssetCandidate(candidates, seen, {
      provider: "igdb",
      kind: "hero",
      label: `IGDB artwork ${index + 1}`,
      url: buildIgdbImageUrl(entry.image_id, "1080p"),
      source: "IGDB"
    });
  });
  game.screenshots?.forEach((entry, index) => {
    if (!entry.image_id) return;
    addAssetCandidate(candidates, seen, {
      provider: "igdb",
      kind: "hero",
      label: `IGDB screenshot ${index + 1}`,
      url: buildIgdbImageUrl(entry.image_id, "screenshot_big"),
      thumbnailUrl: buildIgdbImageUrl(entry.image_id, "thumb"),
      source: "IGDB"
    });
  });
}

async function fetchIgdbAssetCandidates(
  game: Game,
  settings: AppSettings,
  candidates: GameAssetCandidate[],
  seen: Set<string>,
  warnings: string[]
): Promise<void> {
  if (!settings.igdb) {
    warnings.push("IGDB credentials are not configured.");
    return;
  }
  try {
    const client = new IgdbClient({
      clientId: await nativeBridge.decryptSecret(settings.igdb.clientId),
      clientSecret: await nativeBridge.decryptSecret(settings.igdb.clientSecret)
    });
    const igdbSource = game.sourceIds.find((source) => source.provider === "igdb");
    const steamSource = game.sourceIds.find((source) => source.provider === "steam");
    const igdbGame = igdbSource
      ? await client.getGame(Number(igdbSource.externalId))
      : steamSource
        ? await client.lookupByExternal(steamSource.externalId, 1)
        : (await client.searchGames(game.title, 1))[0];
    if (igdbGame) {
      addIgdbAssetCandidates(igdbGame, candidates, seen);
    } else {
      warnings.push("IGDB did not find a matching game.");
    }
  } catch (error) {
    warnings.push(`IGDB assets unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getAssetCandidates(game: Game): Promise<GameAssetCandidateResult> {
  const settings = await settingsService.get();
  const candidates: GameAssetCandidate[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  addCurrentAssetCandidates(game, candidates, seen);

  const steamSource = game.sourceIds.find((source) => source.provider === "steam");
  if (steamSource) {
    await fetchSteamAssetCandidates(game.id, steamSource.externalId, candidates, seen, warnings);
  }

  const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
  await Promise.all([
    fetchSteamGridDbCandidates(game, steamGridDbApiKey, candidates, seen, warnings),
    fetchIgdbAssetCandidates(game, settings, candidates, seen, warnings)
  ]);

  return { candidates, warnings };
}

function hasRichDetailMetadata(game: Game): boolean {
  return Boolean(game.shortDescription || game.aboutText || game.screenshots.length || game.trailerUrl);
}

async function hydrateRichDetailMetadata(game: Game): Promise<Game> {
  const imported = steamImportedGameFromGame(game);
  if (!imported || hasRichDetailMetadata(game)) {
    return game;
  }

  try {
    syncStatusService.log("info", "metadata:detail", `Fetching detail metadata for ${game.title}`, { appid: imported.externalId });
    const metadata = await fetchSteamMetadata(imported.externalId, fetch, (entry) => {
      diagnosticLogService.log({
        level: entry.level,
        phase: `metadata:${entry.providerId}`,
        message: `${entry.gameTitle}: ${entry.message}`,
        details: {
          appid: entry.appid,
          ...entry.details
        }
      });
    }, imported.title, (raw) => saveSteamRawMetadata(game.id, imported.externalId, "steam_appdetails", raw));
    if (metadata.metadataStatus === "failed") {
      return game;
    }

    repository.applyMetadata(game.id, await cacheMetadataAssets(metadata));
    return repository.getGame(game.id) ?? game;
  } catch (error) {
    diagnosticLogService.log({
      level: "warning",
      phase: "metadata:detail",
      message: `${game.title}: detail metadata refresh failed`,
      details: { appid: imported.externalId, error: error instanceof Error ? error.message : String(error) }
    });
    return game;
  }
}

function mergeDetailMetadata(game: Game, metadata: GameMetadataPatch): Game {
  return {
    ...game,
    ...metadata,
    id: game.id,
    sourceIds: game.sourceIds,
    installState: game.installState,
    discovery: game.discovery,
    screenshots: metadata.screenshots ?? game.screenshots,
    genres: metadata.genres ?? game.genres,
    tags: metadata.tags ?? game.tags,
    developers: metadata.developers ?? game.developers,
    publishers: metadata.publishers ?? game.publishers,
    contentDescriptors: metadata.contentDescriptors ?? game.contentDescriptors,
    metadataStatus: metadata.metadataStatus ?? game.metadataStatus
  };
}

async function hydrateDiscoveryDetailMetadata(game: Game): Promise<Game> {
  const imported = steamImportedGameFromGame(game);
  if (!imported || hasRichDetailMetadata(game)) {
    return game;
  }

  try {
    syncStatusService.backgroundProgress("metadata:detail", `Fetching detail metadata for ${game.title}`, undefined, undefined, {
      appid: imported.externalId
    });
    const metadata = await fetchSteamMetadata(imported.externalId, fetch, (entry) => {
      diagnosticLogService.log({
        level: entry.level,
        phase: `metadata:${entry.providerId}`,
        message: `${entry.gameTitle}: ${entry.message}`,
        details: {
          appid: entry.appid,
          discovery: true,
          ...entry.details
        }
      });
    }, imported.title);

    if (metadata.metadataStatus === "failed") {
      return game;
    }

    return mergeDetailMetadata(game, await cacheMetadataAssets(metadata));
  } catch (error) {
    diagnosticLogService.log({
      level: "warning",
      phase: "metadata:detail",
      message: `${game.title}: discovery detail metadata refresh failed`,
      details: { appid: imported.externalId, error: error instanceof Error ? error.message : String(error) }
    });
    return game;
  } finally {
    if (richMetadataBackfillTotal === 0) {
      syncStatusService.backgroundFinish(`Detail metadata loaded for ${game.title}`);
    }
  }
}

function prioritizeRichMetadataBackfill(games: Game[]): Game[] {
  return games
    .filter((game) => !hasRichDetailMetadata(game) && steamImportedGameFromGame(game))
    .sort((a, b) => {
      const installedDelta = Number(b.installState === "installed") - Number(a.installState === "installed");
      if (installedDelta !== 0) {
        return installedDelta;
      }

      const playedDelta = (Date.parse(b.lastPlayedAt ?? "") || 0) - (Date.parse(a.lastPlayedAt ?? "") || 0);
      if (playedDelta !== 0) {
        return playedDelta;
      }

      return (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0);
    });
}

function enqueueRichMetadata(gameOrId: Game | string, priority = false): void {
  const id = typeof gameOrId === "string" ? gameOrId : gameOrId.id;
  const game = typeof gameOrId === "string" ? repository.getGame(gameOrId) : gameOrId;
  if (!game || hasRichDetailMetadata(game) || !steamImportedGameFromGame(game) || richMetadataQueued.has(id) || richMetadataInFlight.has(id)) {
    return;
  }

  richMetadataQueued.add(id);
  if (priority) {
    richMetadataQueue.unshift(id);
  } else {
    richMetadataQueue.push(id);
  }

  richMetadataBackfillTotal += 1;
  void processRichMetadataQueue();
}

function finishRichMetadataQueueIfIdle(): void {
  if (richMetadataQueued.size > 0 || richMetadataRunning > 0 || richMetadataBackfillTotal === 0) {
    return;
  }

  syncStatusService.backgroundFinish(`Detail metadata complete: ${richMetadataBackfillDone}/${richMetadataBackfillTotal} games`);
  richMetadataBackfillTotal = 0;
  richMetadataBackfillDone = 0;
}

function enqueueRichMetadataBackfill(limit = RICH_METADATA_STARTUP_LIMIT): void {
  for (const game of prioritizeRichMetadataBackfill(repository.listGames()).slice(0, limit)) {
    enqueueRichMetadata(game);
  }
}

function clearRichMetadataQueue(message?: string): void {
  richMetadataQueued.clear();
  richMetadataQueue.length = 0;
  if (message) {
    syncStatusService.backgroundFinish(message);
  }
  richMetadataBackfillTotal = 0;
  richMetadataBackfillDone = 0;
}

async function processRichMetadataQueue(): Promise<void> {
  while (richMetadataRunning < RICH_METADATA_CONCURRENCY && richMetadataQueued.size > 0) {
    const id = richMetadataQueue.shift();
    if (!id) {
      return;
    }

    if (!richMetadataQueued.has(id)) {
      continue;
    }

    richMetadataQueued.delete(id);
    richMetadataInFlight.add(id);
    richMetadataRunning += 1;
    void refreshRichMetadata(id).finally(() => {
      richMetadataInFlight.delete(id);
      richMetadataRunning -= 1;
      richMetadataBackfillDone += 1;
      finishRichMetadataQueueIfIdle();
      void processRichMetadataQueue();
    });
  }
}

async function refreshRichMetadata(id: string): Promise<void> {
  const game = repository.getGame(id);
  if (!game || hasRichDetailMetadata(game)) {
    return;
  }

  const imported = steamImportedGameFromGame(game);
  syncStatusService.backgroundProgress(
    "metadata:detail",
    `Fetching detail metadata for ${game.title}`,
    Math.min(richMetadataBackfillTotal, richMetadataBackfillDone + richMetadataRunning),
    richMetadataBackfillTotal,
    imported ? { appid: imported.externalId } : undefined
  );
  const refreshed = await hydrateRichDetailMetadata(game);
  if (refreshed !== game && hasRichDetailMetadata(refreshed)) {
    mainWindow?.webContents.send("games:updated", { ...refreshed, sourceMatches: sourceService.search(refreshed.id) });
  }
}

function createWindow(): void {
  profile("window:create:start", "Creating BrowserWindow");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#09080d",
    icon: windowIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  profile("window:create:end", "BrowserWindow created");

  if (process.env.ELECTRON_RENDERER_URL) {
    profile("window:load:start", "Loading renderer URL", { url: process.env.ELECTRON_RENDERER_URL });
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    profile("window:load:start", "Loading renderer file");
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    profile("window:ready-to-show", "Renderer ready to show");
    mainWindow?.focus();
  });

  mainWindow.webContents.on("dom-ready", () => {
    profile("renderer:dom-ready", "Renderer DOM ready");
  });
  mainWindow.webContents.on("did-finish-load", () => {
    profile("renderer:did-finish-load", "Renderer finished loading");
  });
  mainWindow.webContents.on("unresponsive", () => {
    rendererUnresponsiveAt = performance.now();
    profile("renderer:unresponsive", "Renderer became unresponsive");
  });
  mainWindow.webContents.on("responsive", () => {
    const durationMs = rendererUnresponsiveAt ? roundDuration(rendererUnresponsiveAt) : undefined;
    profile("renderer:responsive", "Renderer became responsive", { durationMs });
    if (durationMs) {
      startupProfileService?.recordFreeze("renderer", durationMs, "electron-unresponsive", { state: "responsive" });
    }
    rendererUnresponsiveAt = undefined;
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    profile("renderer:process-gone", "Renderer process gone", { reason: details.reason, exitCode: details.exitCode });
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      profile("renderer:console", message, { level, line, sourceId });
    }
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximizeChanged", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximizeChanged", false));
  mainWindow.on("closed", () => {
    profile("window:closed", "BrowserWindow closed");
    mainWindow = undefined;
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    profile("window:load:failed", "Renderer failed to load", { errorCode, errorDescription });
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`);
  });
}

function createSplashWindow(): void {
  const { bounds: displayBounds } = screen.getPrimaryDisplay();
  const width = 400;
  const height = 300;
  const x = Math.round(displayBounds.x + (displayBounds.width - width) / 2);
  const y = Math.round(displayBounds.y + (displayBounds.height - height) / 2);

  splashWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  splashWindow.setIgnoreMouseEvents(true);

  if (process.env.ELECTRON_RENDERER_URL) {
    void splashWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/splash.html`);
  } else {
    void splashWindow.loadFile(join(__dirname, "../renderer/splash.html"));
  }

  splashWindow.once("ready-to-show", () => {
    splashWindow?.show();
  });

  splashWindow.on("closed", () => {
    splashWindow = undefined;
  });
}

function dismissSplash(): void {
  if (startupReadyTimeout) {
    clearTimeout(startupReadyTimeout);
    startupReadyTimeout = undefined;
  }
  if (!splashWindow || splashWindow.isDestroyed()) {
    mainWindow?.show();
    mainWindow?.focus();
    return;
  }
  void splashWindow.webContents.executeJavaScript("document.body.classList.add('dismiss')").catch(() => undefined);
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    mainWindow?.show();
    mainWindow?.focus();
  }, 300);
}

function runAfterInitialRendererPaint(task: () => void): void {
  const window = mainWindow;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) {
      return;
    }

    scheduled = true;
    profile("startup:background:scheduled", "Startup background work scheduled", { delayMs: STARTUP_BACKGROUND_DELAY_MS });
    setTimeout(task, STARTUP_BACKGROUND_DELAY_MS);
  };

  if (!window) {
    schedule();
    return;
  }

  if (!window.webContents.isLoading()) {
    schedule();
    return;
  }

  window.webContents.once("did-finish-load", schedule);
  window.webContents.once("did-fail-load", schedule);
  setTimeout(schedule, STARTUP_BACKGROUND_DELAY_MS * 4);
}

async function startSteamSync(providerId?: ProviderId, options: { refreshStaleMetadata?: boolean } = {}): Promise<SyncResult> {
  if (providerId && providerId !== "steam") {
    throw new Error(`Provider ${providerId} is not implemented yet.`);
  }

  profile("steam-sync:start-requested", "Steam sync start requested", { providerId, refreshStaleMetadata: options.refreshStaleMetadata });
  const started = await withSteamSyncStartLock(async () => {
    await cancelActiveSteamSync("Steam sync replaced by a newer request");
    const controller = new AbortController();
    const promise = syncSteamLibrary(providerId, { ...options, signal: controller.signal }).finally(() => {
      if (activeSteamSync?.promise === promise) {
        activeSteamSync = undefined;
      }
    });
    activeSteamSync = { controller, promise };
    return { promise };
  });
  return started.promise;
}

async function syncSteamLibrary(providerId?: ProviderId, options: { refreshStaleMetadata?: boolean; signal?: AbortSignal } = {}) {
  const syncStartedAt = performance.now();
  const syncRunId = randomUUID();
  const trigger = options.refreshStaleMetadata === false ? "startup" : "manual";
  const runSpan = profileSpan("steam-sync", "steam-sync:run", {
    syncRunId,
    providerId,
    trigger,
    refreshStaleMetadata: options.refreshStaleMetadata
  });
  profile("steam-sync:start", "Steam sync started", { syncRunId, providerId, trigger, refreshStaleMetadata: options.refreshStaleMetadata });
  throwIfSteamSyncCancelled(options.signal);
  const settingsSpan = profileSpan("steam-sync", "steam-sync:settings-load", { syncRunId });
  const settings = await settingsService.get();
  settingsSpan.end("ok", {
    syncRunId,
    steamAccounts: settings.steamAccounts.length,
    hasSteamWebApiKey: Boolean(settings.steamWebApiKey),
    hasSteamGridDbApiKey: Boolean(settings.steamGridDbApiKey)
  });
  throwIfSteamSyncCancelled(options.signal);
  const decryptSpan = profileSpan("steam-sync", "steam-sync:decrypt-secrets", { syncRunId });
  const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;

  if (providerId && providerId !== "steam") {
    throw new Error(`Provider ${providerId} is not implemented yet.`);
  }

  const webApiKey = settings.steamWebApiKey ? await nativeBridge.decryptSecret(settings.steamWebApiKey) : undefined;
  decryptSpan.end("ok", {
    syncRunId,
    decryptedSteamGridDbKey: Boolean(settings.steamGridDbApiKey),
    decryptedSteamWebApiKey: Boolean(settings.steamWebApiKey)
  });
  const eligibleAccounts = webApiKey ? settings.steamAccounts : [];

  if (eligibleAccounts.length === 0) {
    syncStatusService.start("steam");
    syncStatusService.finish(
      webApiKey ? "Steam sync skipped: no paired accounts" : "Steam sync skipped: add a Steam Web API key in Settings"
    );
    runSpan.end("ok", { syncRunId, scanned: 0, upserted: 0, installed: 0, skipped: true, refreshStaleMetadata: options.refreshStaleMetadata });
    void startupProfileService?.writeReport();
    return { providerId: "steam" as const, scanned: 0, upserted: 0, warnings: [] };
  }

  const buildScanLogger = (account: SteamAccountSettings) => (level: "info" | "warning" | "error", message: string, details?: Record<string, unknown>) => {
    const annotated = { ...details, account: account.personaName ?? account.steamId };
    diagnosticLogService.log({ level, phase: "steam:family", message, details: annotated });
    syncStatusService.log(level, "steam:family", message, annotated);
    if (level === "warning" || level === "error") {
      console.warn(`[steam:family] ${message}`, annotated);
    }
  };

  const buildProvider = (
    account: SteamAccountSettings,
    key: string,
    familyAccessToken: string | undefined,
    familyScanResult?: (result: { status: SteamFamilyScanStatus; error?: string }) => void
  ) =>
    new SteamImporterProvider({
      account: { steamId: account.steamId, webApiKey: key, familyAccessToken },
      includePlayedFreeGames: true,
      steamGridDbApiKey,
      steamAppInfoProvider: fetchNativeSteamAppInfoMetadata,
      metadataMode: "fast",
      rawMetadataRecorder: (game, source, raw) =>
        saveSteamRawMetadata(makeGameId(game.provider, game.externalId), game.externalId, source, raw),
      signal: options.signal,
      profiler: startupProfileService,
      scanLogger: buildScanLogger(account),
      familyScanResult,
      metadataLogger: (entry) => {
        diagnosticLogService.log({
          level: entry.level,
          phase: `metadata:${entry.providerId}`,
          message: `${entry.gameTitle}: ${entry.message}`,
          details: { appid: entry.appid, ...entry.details }
        });
        syncStatusService.log(entry.level, `metadata:${entry.providerId}`, `${entry.gameTitle}: ${entry.message}`, entry.details);
        if (entry.level === "warning") {
          console.warn(entry.message, entry.details);
        }
      }
    });

  syncStatusService.start("steam");
  const refreshStaleMetadata = options.refreshStaleMetadata ?? true;

  // Scan all accounts sequentially so progress events stay coherent.
  let imported: ImportedGame[];
  let provider: SteamImporterProvider;
  const incompleteFamilyScanOwners = new Set<string>();
  try {
    const scanned: ImportedGame[] = [];
    for (const account of eligibleAccounts) {
      throwIfSteamSyncCancelled(options.signal);
      const familyTokenSpan = profileSpan("steam-sync", "steam-sync:family-token-refresh", {
        syncRunId,
        account: account.steamId,
        hasFamilySession: Boolean(account.familySession)
      });
      let familyAccessToken: string | undefined;
      try {
        familyAccessToken = await resolveFamilyAccessTokenForAccount(account);
        familyTokenSpan.end("ok", { syncRunId, account: account.steamId, refreshed: Boolean(familyAccessToken) });
      } catch (error) {
        familyTokenSpan.end("error", { syncRunId, account: account.steamId, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      throwIfSteamSyncCancelled(options.signal);
      const familyScanStatus: { current: SteamFamilyScanStatus | undefined } = {
        current: account.familySession ? "skipped" : undefined
      };
      const accountProvider = buildProvider(account, webApiKey!, familyAccessToken, (result) => {
        familyScanStatus.current = result.status;
      });
      syncStatusService.progress(
        "steam:owned-games",
        `Calling Steam owned games API for ${account.personaName ?? account.steamId}`
      );
      const ownedSpan = profileSpan("steam-sync", "steam-sync:owned-games-fetch", { syncRunId, account: account.steamId });
      let accountScan: ImportedGame[];
      try {
        accountScan = await accountProvider.scan();
        ownedSpan.end("ok", { syncRunId, account: account.steamId, count: accountScan.length, familyScanStatus: familyScanStatus.current });
      } catch (error) {
        ownedSpan.end(isSteamSyncCancelledError(error) ? "cancelled" : "error", {
          syncRunId,
          account: account.steamId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      if (account.familySession && familyScanStatus.current !== "complete") {
        incompleteFamilyScanOwners.add(account.steamId);
        const message = familyAccessToken
          ? "Steam family library refresh did not complete; preserving existing family-shared games."
          : "Steam family token could not auto-renew; preserving existing family-shared games.";
        const details = { account: account.personaName ?? account.steamId, status: familyScanStatus.current };
        syncStatusService.log("warning", "steam:family", message, details);
        diagnosticLogService.log({ level: "warning", phase: "steam:family", message, details });
      }
      scanned.push(...accountScan);
      profile("steam-sync:owned-games", "Steam owned games scan finished", {
        account: account.steamId,
        count: accountScan.length,
        durationMs: roundDuration(syncStartedAt)
      });
    }
    imported = scanned;
    // Metadata refresh provider — account-independent so any paired account works.
    provider = buildProvider(eligibleAccounts[0]!, webApiKey!, undefined);
    throwIfSteamSyncCancelled(options.signal);
  } catch (error) {
    if (isSteamSyncCancelledError(error)) {
      syncStatusService.cancel(error.message);
      profile("steam-sync:cancelled", "Steam sync cancelled while loading owned games", {
        syncRunId,
        durationMs: roundDuration(syncStartedAt),
        error: error.message
      });
      runSpan.end("cancelled", { syncRunId, durationMs: roundDuration(syncStartedAt), error: error.message, trigger });
      void startupProfileService?.writeReport();
      throw error;
    }
    syncStatusService.fail("Steam sync failed while loading owned games", { error: error instanceof Error ? error.message : String(error) });
    profile("steam-sync:error", "Steam sync failed while loading owned games", {
      syncRunId,
      durationMs: roundDuration(syncStartedAt),
      error: error instanceof Error ? error.message : String(error)
    });
    runSpan.end("error", {
      syncRunId,
      durationMs: roundDuration(syncStartedAt),
      error: error instanceof Error ? error.message : String(error),
      trigger
    });
    void startupProfileService?.writeReport();
    throw error;
  }

  try {
    syncStatusService.progress("steam:local-installs", "Reading local Steam install manifests", 0, imported.length);
    const localInstallSpan = profileSpan("steam-sync", "steam-sync:local-install-scan", { syncRunId, imported: imported.length });
    const installedApps = await discoverInstalledSteamApps().catch((error: unknown) => {
      syncStatusService.log("warning", "steam:local-installs", "Could not read local Steam install manifests", {
        error: error instanceof Error ? error.message : String(error)
      });
      return new Map();
    });
    localInstallSpan.end("ok", { syncRunId, count: installedApps.size });
    profile("steam-sync:local-installs", "Local Steam install scan finished", { count: installedApps.size, durationMs: roundDuration(syncStartedAt) });
    throwIfSteamSyncCancelled(options.signal);

    let upserted = 0;
    let metadataCacheHits = 0;
    let staleMetadataCount = 0;
    const warnings: string[] = [];
    const metadataTargets: Array<{ id: string; game: ImportedGame }> = [];

    const upsertStartedAt = performance.now();
    let lastYieldIndex = 0;
    let upsertChunkSize = STEAM_SYNC_UPSERT_YIELD_INTERVAL;
    while (lastYieldIndex < imported.length) {
      throwIfSteamSyncCancelled(options.signal);
      const chunkEnd = Math.min(imported.length, lastYieldIndex + upsertChunkSize);
      const chunkStartedAt = performance.now();
      const chunkSpan = profileSpan("steam-sync", "steam-sync:sqlite-upsert-chunk", {
        syncRunId,
        from: lastYieldIndex + 1,
        to: chunkEnd,
        size: upsertChunkSize
      });
      const rowTimings: Array<{ id: string; title: string; durationMs: number }> = [];
      syncStatusService.progress(
        "steam:upsert",
        `Syncing Steam library ${chunkEnd}/${imported.length}`,
        chunkEnd,
        imported.length,
        { from: lastYieldIndex + 1, to: chunkEnd },
        { history: false }
      );
      repository.transaction(() => {
        for (let index = lastYieldIndex; index < chunkEnd; index += 1) {
          throwIfSteamSyncCancelled(options.signal);
          const rowStartedAt = performance.now();
          const game = imported[index] as ImportedGame;
          const installed = installedApps.get(game.externalId);
          const gameWithInstallState = {
            ...game,
            installState: installed ? ("installed" as const) : game.installState,
            installDirectory: installed?.installDirectory ?? game.installDirectory
          };
          const persisted = repository.upsertImportedGameSummary(gameWithInstallState);
          upserted += 1;
          rowTimings.push({ id: persisted.id, title: game.title, durationMs: roundDuration(rowStartedAt) });
          if (hasAnyCachedMetadata(persisted) && !refreshStaleMetadata) {
            metadataCacheHits += 1;
            continue;
          }

          if (refreshStaleMetadata && persisted.metadataStatus !== "none") {
            staleMetadataCount += 1;
          }

          metadataTargets.push({ id: persisted.id, game: gameWithInstallState });
        }
      });
      const chunkDurationMs = roundDuration(chunkStartedAt);
      const slowestRows = rowTimings
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5);
      const chunkDetails: Record<string, unknown> = { syncRunId, from: lastYieldIndex + 1, to: chunkEnd, size: upsertChunkSize, durationMs: chunkDurationMs };
      if (chunkDurationMs > 50) {
        chunkDetails.slowestRows = slowestRows;
      }
      chunkSpan.end("ok", chunkDetails);
      if (chunkDurationMs > 50) {
        profile("steam-sync:upsert-chunk", "Steam library upsert chunk finished", {
          from: lastYieldIndex + 1,
          to: chunkEnd,
          size: upsertChunkSize,
          durationMs: chunkDurationMs,
          slowestRows
        });
      }
      lastYieldIndex = chunkEnd;
      upsertChunkSize = chunkDurationMs > 50
        ? STEAM_SYNC_MIN_UPSERT_YIELD_INTERVAL
        : Math.min(STEAM_SYNC_UPSERT_YIELD_INTERVAL, upsertChunkSize + STEAM_SYNC_MIN_UPSERT_YIELD_INTERVAL);
      await yieldToEventLoop();
    }
    profile("steam-sync:upsert", "Steam library upsert finished", {
      upserted,
      metadataCacheHits,
      staleMetadataCount,
      metadataTargets: metadataTargets.length,
      durationMs: roundDuration(upsertStartedAt),
      totalDurationMs: roundDuration(syncStartedAt)
    });
    if (metadataCacheHits > 0) {
      syncStatusService.log("info", "metadata:cache", `Metadata cache hits: ${metadataCacheHits}/${upserted}`);
    }
    if (staleMetadataCount > 0) {
      syncStatusService.log("info", "metadata:cache", `Manual metadata refresh targets queued: ${staleMetadataCount}`);
    }

    const retainedSteamSources = imported.map((game) => ({ externalId: game.externalId, ownerSteamid: game.ownerSteamid ?? "" }));
    if (incompleteFamilyScanOwners.size > 0) {
      const preservedLegacyFamilySources = new Set<string>();
      for (const game of repository.listGames()) {
        for (const source of game.sourceIds) {
          const ownerSteamid = source.ownerSteamid ?? "";
          if (
            source.provider !== "steam" ||
            source.shareType !== "family" ||
            (!incompleteFamilyScanOwners.has(ownerSteamid) && ownerSteamid !== "")
          ) {
            continue;
          }
          const key = `${source.externalId}\u0000${ownerSteamid}`;
          if (preservedLegacyFamilySources.has(key)) {
            continue;
          }
          preservedLegacyFamilySources.add(key);
          retainedSteamSources.push({ externalId: source.externalId, ownerSteamid });
        }
      }
    }

    const pruneSpan = profileSpan("steam-sync", "steam-sync:prune-provider-sources", {
      syncRunId,
      retainedSources: retainedSteamSources.length
    });
    const pruneResult = repository.pruneProviderSources(
      "steam",
      ["", ...eligibleAccounts.map((account) => account.steamId)],
      retainedSteamSources
    );
    pruneSpan.end("ok", { syncRunId, ...pruneResult });
    if (pruneResult.sourcesRemoved > 0 || pruneResult.gamesRemoved > 0) {
      syncStatusService.log(
        "info",
        "steam:prune",
        `Removed ${pruneResult.gamesRemoved} Steam games no longer listed by synced accounts`,
        { sourcesRemoved: pruneResult.sourcesRemoved, gamesRemoved: pruneResult.gamesRemoved }
      );
    }

    const metadataTotalSpan = profileSpan("steam-sync", "steam-sync:metadata-refresh-total", { syncRunId, count: metadataTargets.length });
    try {
      await mapWithConcurrency(metadataTargets, METADATA_REFRESH_CONCURRENCY, async (target, index) => {
      const gameSpan = profileSpan("metadata", "metadata:game-refresh", {
        syncRunId,
        appid: target.game.externalId,
        title: target.game.title,
        index: index + 1,
        total: metadataTargets.length
      });
      try {
        throwIfSteamSyncCancelled(options.signal);
        syncStatusService.progress("metadata:refresh", `Fetching fast metadata for ${target.game.title}`, index + 1, metadataTargets.length, {
          appid: target.game.externalId
        });
        const providerMetadata = await provider.refreshMetadata(target.game);
        const cacheSpan = profileSpan("steam-sync", "steam-sync:asset-cache-metadata-patch", {
          syncRunId,
          appid: target.game.externalId,
          title: target.game.title
        });
        const metadata = await cacheMetadataAssets(providerMetadata, refreshStaleMetadata);
        cacheSpan.end("ok", {
          syncRunId,
          appid: target.game.externalId,
          title: target.game.title,
          fields: Object.keys(metadata)
        });
        throwIfSteamSyncCancelled(options.signal);
        const applySpan = profileSpan("steam-sync", "steam-sync:metadata-apply", {
          syncRunId,
          appid: target.game.externalId,
          title: target.game.title
        });
        repository.applyMetadata(target.id, metadata);
        applySpan.end("ok", { syncRunId, appid: target.game.externalId, title: target.game.title, metadataStatus: metadata.metadataStatus });
        const enriched = repository.getGame(target.id);
        if (enriched) {
          enqueueRichMetadata(enriched);
        }
        if (metadata.metadataStatus === "failed") {
          warnings.push(`Metadata failed for ${target.game.title}`);
        }
        gameSpan.end("ok", {
          syncRunId,
          appid: target.game.externalId,
          title: target.game.title,
          metadataStatus: metadata.metadataStatus,
          fields: Object.keys(metadata)
        });
      } catch (error) {
        gameSpan.end(isSteamSyncCancelledError(error) ? "cancelled" : "error", {
          syncRunId,
          appid: target.game.externalId,
          title: target.game.title,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      });
      metadataTotalSpan.end("ok", { syncRunId, count: metadataTargets.length });
    } catch (error) {
      metadataTotalSpan.end(isSteamSyncCancelledError(error) ? "cancelled" : "error", {
        syncRunId,
        count: metadataTargets.length,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    profile("steam-sync:metadata-refresh", "Steam metadata refresh finished", {
      count: metadataTargets.length,
      durationMs: roundDuration(syncStartedAt)
    });
    const richBackfillSpan = profileSpan("steam-sync", "steam-sync:rich-backfill-queue", { syncRunId });
    enqueueRichMetadataBackfill();
    richBackfillSpan.end("ok", { syncRunId });
    throwIfSteamSyncCancelled(options.signal);
    syncStatusService.finish(`Steam sync complete: ${upserted} games, ${installedApps.size} local installs`);
    profile("steam-sync:end", "Steam sync completed", {
      syncRunId,
      scanned: imported.length,
      upserted,
      installed: installedApps.size,
      durationMs: roundDuration(syncStartedAt)
    });
    runSpan.end("ok", {
      syncRunId,
      scanned: imported.length,
      upserted,
      installed: installedApps.size,
      refreshStaleMetadata,
      trigger
    });
    void startupProfileService?.writeReport();
    return { providerId: "steam" as const, scanned: imported.length, upserted, warnings };
  } catch (error) {
    if (isSteamSyncCancelledError(error)) {
      syncStatusService.cancel(error.message);
      profile("steam-sync:cancelled", "Steam sync cancelled", { durationMs: roundDuration(syncStartedAt), error: error.message });
      runSpan.end("cancelled", { syncRunId, durationMs: roundDuration(syncStartedAt), error: error.message, trigger });
      void startupProfileService?.writeReport();
      throw error;
    }
    syncStatusService.fail("Steam sync failed", { error: error instanceof Error ? error.message : String(error) });
    profile("steam-sync:error", "Steam sync failed", {
      syncRunId,
      durationMs: roundDuration(syncStartedAt),
      error: error instanceof Error ? error.message : String(error)
    });
    runSpan.end("error", {
      syncRunId,
      durationMs: roundDuration(syncStartedAt),
      error: error instanceof Error ? error.message : String(error),
      trigger
    });
    void startupProfileService?.writeReport();
    throw error;
  }
}

type LaunchResult =
  | ({ kind: "launched" } & LaunchSession)
  | {
      kind: "requires-switch";
      gameId: string;
      gameTitle: string;
      currentAccountName?: string;
      currentSteamId?: string;
      target: { steamId: string; accountName: string; personaName?: string };
    }
  | { kind: "no-account"; reason: string };

function launchSwitchResult(
  id: string,
  game: Game,
  active: Awaited<ReturnType<typeof getActiveSteamUser>>,
  target: SteamLaunchAccountOption
): LaunchResult {
  return {
    kind: "requires-switch",
    gameId: id,
    gameTitle: game.title,
    currentAccountName: active.accountName,
    currentSteamId: active.steamId,
    target: {
      steamId: target.steamId,
      accountName: target.localUsername!,
      personaName: target.personaName
    }
  };
}

async function resolveLaunchOrSwitch(id: string, preferredSteamId?: string): Promise<LaunchResult> {
  const game = repository.getGame(id);
  if (!game) {
    throw new Error(`Game ${id} was not found.`);
  }

  const settings = await settingsService.get();
  const launchable = resolveLaunchableSteamAccounts(game, settings.steamAccounts);
  const hasSteamSource = game.sourceIds.some((source) => source.provider === "steam");

  // Non-Steam game, or no paired accounts at all → just launch.
  if (!hasSteamSource || settings.steamAccounts.length === 0) {
    return performLaunch(id);
  }

  const active = await getActiveSteamUser();
  const activeLaunchable = active.steamId ? launchable.find((account) => account.steamId === active.steamId) : undefined;
  const savedSteamId = settings.launchAccountPreferences?.[id];
  const selectedTarget =
    (preferredSteamId ? launchable.find((account) => account.steamId === preferredSteamId) : undefined) ??
    (savedSteamId ? launchable.find((account) => account.steamId === savedSteamId) : undefined);

  if (selectedTarget) {
    if (activeLaunchable?.steamId === selectedTarget.steamId) {
      return performLaunch(id);
    }
    if (!selectedTarget.localUsername) {
      const label = selectedTarget.personaName ?? selectedTarget.steamId;
      return { kind: "no-account", reason: `Map a local Steam username to ${label} before switching accounts.` };
    }
    return launchSwitchResult(id, game, active, selectedTarget);
  }

  if (activeLaunchable) {
    return performLaunch(id);
  }

  // Pick a target — owners first, then family-borrower viewers; require a mapped local username.
  const target =
    launchable.find((account) => account.kind === "owner" && Boolean(account.localUsername)) ??
    launchable.find((account) => account.kind === "family" && Boolean(account.localUsername));
  if (!target) {
    return performLaunch(id); // no usable target → fall back to plain launch
  }

  return launchSwitchResult(id, game, active, target);
}

async function performLaunch(id: string): Promise<{ kind: "launched" } & LaunchSession> {
  const game = repository.getGame(id);
  if (!game) {
    throw new Error(`Game ${id} was not found.`);
  }
  const localSource = game.sourceIds.find((source) => source.provider === "local");
  if (localSource && game.executablePath) {
    const session = launchTracker.spawnAndTrack(id, game.executablePath, game.installDirectory);
    return { kind: "launched", ...session };
  }
  const steamSource = game.sourceIds.find((source) => source.provider === "steam");
  const command = repository.getLaunchCommand(id);
  const session = await nativeBridge.launchGame({
    gameId: id,
    provider: steamSource?.provider ?? "manual",
    externalId: steamSource?.externalId ?? id,
    command,
    executablePath: game.executablePath,
    workingDirectory: game.installDirectory
  });
  return { kind: "launched", ...session };
}

async function runLocalScan(): Promise<{ scanned: number; matched: number; ambiguous: number; unmatched: number; issues: LocalScanIssue[] } | undefined> {
  if (activeLocalScan) {
    return activeLocalScan.promise as Promise<ReturnType<typeof runLocalScan>>;
  }
  const span = profileSpan("local-scan", "local-scan:run");
  const settings = await settingsService.get();
  const roots = (settings.localRoots ?? []).filter((root) => root.path && root.path.trim().length > 0);
  if (roots.length === 0) {
    span.end("ok", { skipped: true, rootCount: 0 });
    return undefined;
  }

  const controller = new AbortController();
  const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
  const igdbAuth = settings.igdb
    ? {
        clientId: await nativeBridge.decryptSecret(settings.igdb.clientId),
        clientSecret: await nativeBridge.decryptSecret(settings.igdb.clientSecret)
      }
    : undefined;

  const promise = localImportService
    .run({
      roots,
      excludePatterns: settings.localExcludePatterns ?? [],
      ignoredPaths: settings.localIgnoredPaths ?? [],
      igdbAuth,
      steamGridDbApiKey,
      steamAppInfoProvider: fetchNativeSteamAppInfoMetadata,
      signal: controller.signal,
      searchSteamStore: async (query) => {
        try {
          const results = await searchSteamStore(query, net.fetch);
          return results.slice(0, 6).map((entry): IdentifyCandidate => ({
            provider: "steam",
            externalId: entry.appId,
            title: entry.title,
            confidence: 0,
            reason: "search",
            releaseDate: entry.releaseDate,
            coverUrl: entry.capsuleUrl
          }));
        } catch (error) {
          console.warn("Steam search for local importer failed", error);
          return [];
        }
      },
      log: (level, message, details) => {
        diagnosticLogService.log({ level, phase: "local:scan", message, details });
        syncStatusService.log(level, "local:scan", message, details);
      }
    })
    .finally(() => {
      if (activeLocalScan?.promise === promise) {
        activeLocalScan = undefined;
      }
      span.end("ok", { rootCount: roots.length });
    });

  activeLocalScan = { promise, controller };
  return promise;
}

function registerIpc(): void {
  ipcMain.once("startup:ready", () => {
    profile("startup:ready", "Renderer signaled startup ready");
    dismissSplash();
  });

  ipcMain.on("debug:profile", (_event, entry: { phase?: unknown; message?: unknown; details?: unknown; rendererElapsedMs?: unknown }) => {
    startupProfileService?.log({
      scope: "renderer",
      phase: typeof entry?.phase === "string" ? entry.phase : "renderer",
      message: typeof entry?.message === "string" ? entry.message : "Renderer profile event",
      details: entry?.details && typeof entry.details === "object" ? (entry.details as Record<string, unknown>) : undefined,
      rendererElapsedMs: typeof entry?.rendererElapsedMs === "number" ? entry.rendererElapsedMs : undefined
    });
  });
  ipcMain.on("debug:profile-record", (_event, entry: unknown) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    startupProfileService?.recordRendererEvent(entry as Parameters<StartupProfileService["recordRendererEvent"]>[0]);
  });

  handleIpc("library:sync", async (_event, providerId?: ProviderId) => {
    return startSteamSync(providerId, { refreshStaleMetadata: true });
  });

  handleIpc("local:scan", async () => {
    const result = await runLocalScan();
    return result ?? { scanned: 0, matched: 0, ambiguous: 0, unmatched: 0, issues: [] };
  });
  handleIpc("local:get-issues", async () => {
    return localImportService.lastReport?.issues ?? [];
  });
  handleIpc("local:probe", async (
    _event,
    args: { folderPath?: string; executablePath?: string }
  ) => {
    const settings = await settingsService.get();
    const igdbAuth = settings.igdb
      ? {
          clientId: await nativeBridge.decryptSecret(settings.igdb.clientId),
          clientSecret: await nativeBridge.decryptSecret(settings.igdb.clientSecret)
        }
      : undefined;
    return localImportService.probe(args, {
      igdbAuth,
      searchSteamStore: async (query) => {
        try {
          const results = await searchSteamStore(query, net.fetch);
          return results.slice(0, 8).map((entry): IdentifyCandidate => ({
            provider: "steam",
            externalId: entry.appId,
            title: entry.title,
            confidence: 0,
            reason: "search",
            releaseDate: entry.releaseDate,
            coverUrl: entry.capsuleUrl
          }));
        } catch (error) {
          console.warn("Steam search for probe failed", error);
          return [];
        }
      }
    });
  });
  handleIpc("local:search-metadata", async (_event, args: { query: string }) => {
    const settings = await settingsService.get();
    const igdbAuth = settings.igdb
      ? {
          clientId: await nativeBridge.decryptSecret(settings.igdb.clientId),
          clientSecret: await nativeBridge.decryptSecret(settings.igdb.clientSecret)
        }
      : undefined;
    return localImportService.searchMetadata(args.query, {
      igdbAuth,
      searchSteamStore: async (query) => {
        try {
          const results = await searchSteamStore(query, net.fetch);
          return results.slice(0, 12).map((entry): IdentifyCandidate => ({
            provider: "steam",
            externalId: entry.appId,
            title: entry.title,
            confidence: 0,
            reason: "search",
            releaseDate: entry.releaseDate,
            coverUrl: entry.capsuleUrl
          }));
        } catch {
          return [];
        }
      }
    });
  });
  handleIpc("local:set-ignored", async (_event, paths: string[]) => {
    return settingsService.update({ localIgnoredPaths: paths });
  });
  handleIpc("local:ignore-folder", async (_event, folderPath: string) => {
    const current = await settingsService.get();
    const ignored = new Set(current.localIgnoredPaths ?? []);
    ignored.add(folderPath);
    return settingsService.update({ localIgnoredPaths: [...ignored] });
  });
  handleIpc("local:count-under", (_event, folderPath: string) => {
    const prefix = folderPath.replace(/[\\/]+$/, "").toLowerCase();
    const games = repository.listLocalGames();
    return games.filter((game) => {
      if (!game.installDirectory) return false;
      const dir = game.installDirectory.toLowerCase();
      return dir === prefix || dir.startsWith(prefix + "\\") || dir.startsWith(prefix + "/");
    }).length;
  });
  handleIpc("local:remove-under", (_event, folderPath: string) => {
    return { removed: repository.removeLocalGamesUnder(folderPath) };
  });
  handleIpc("local:remove-all", () => {
    return { removed: repository.removeAllLocalGames() };
  });
  handleIpc("local:remove-and-ignore", async (_event, args: { gameId: string; folderPath?: string }) => {
    repository.removeGame(args.gameId);
    if (args.folderPath) {
      const current = await settingsService.get();
      const ignored = new Set(current.localIgnoredPaths ?? []);
      ignored.add(args.folderPath);
      await settingsService.update({ localIgnoredPaths: [...ignored] });
    }
    return { ok: true };
  });
  handleIpc("local:remove-game", (_event, gameId: string) => {
    const game = repository.getGame(gameId);
    if (!game) {
      return { ok: true };
    }
    if (!isLocalGame(game)) {
      throw new Error("Only local games can be deleted from this menu.");
    }
    repository.removeGame(gameId);
    return { ok: true };
  });
  handleIpc("local:add-single", async (
    _event,
    args: {
      folderPath?: string;
      executablePath?: string;
      titleOverride?: string;
      match?: { provider: "steam" | "igdb"; externalId: string; title: string };
    }
  ) => {
    const settings = await settingsService.get();
    const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
    const igdbAuth = settings.igdb
      ? {
          clientId: await nativeBridge.decryptSecret(settings.igdb.clientId),
          clientSecret: await nativeBridge.decryptSecret(settings.igdb.clientSecret)
        }
      : undefined;

    const result = await localImportService.addSingle(args, {
      igdbAuth,
      steamGridDbApiKey,
      steamAppInfoProvider: fetchNativeSteamAppInfoMetadata,
      searchSteamStore: async (query) => {
        try {
          const results = await searchSteamStore(query, net.fetch);
          return results.slice(0, 6).map((entry): IdentifyCandidate => ({
            provider: "steam",
            externalId: entry.appId,
            title: entry.title,
            confidence: 0,
            reason: "search",
            releaseDate: entry.releaseDate,
            coverUrl: entry.capsuleUrl
          }));
        } catch (error) {
          console.warn("Steam search for single-add failed", error);
          return [];
        }
      },
      log: (level, message, details) => {
        diagnosticLogService.log({ level, phase: "local:add-single", message, details });
        syncStatusService.log(level, "local:add-single", message, details);
      }
    });

    // If this candidate was previously flagged as an issue, drop it now that it has a resolution.
    const report = localImportService.lastReport;
    if (report && (args.match || result.identification.kind === "match")) {
      report.issues = report.issues.filter((issue) => issue.candidateId !== result.candidateId);
    }
    return result;
  });
  handleIpc("local:repair-library", () => {
    return repository.repairPhantomLocalGames();
  });
  handleIpc("local:resolve-ambiguous", async (
    _event,
    args: { candidateId: string; chosen: { provider: "steam" | "igdb"; externalId: string; title: string } | null }
  ) => {
    const settings = await settingsService.get();
    const localId = makeGameId("local", args.candidateId);
    const game = repository.getGame(localId);
    if (!game) {
      throw new Error("Local game candidate not found in library; rescan first.");
    }
    if (!args.chosen) {
      // Mark as resolved with no match — leave as-is.
      return { ok: true };
    }
    repository.attachSecondarySource({
      gameId: localId,
      provider: args.chosen.provider,
      externalId: args.chosen.externalId
    });

    // Refresh metadata using the user-picked source.
    let patch: GameMetadataPatch | undefined;
    if (args.chosen.provider === "steam") {
      patch = await refreshFusedMetadata(
        {
          provider: "steam",
          externalId: args.chosen.externalId,
          title: args.chosen.title,
          installState: "installed"
        } as ImportedGame,
        {
          steamGridDbApiKey: settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined,
          steamAppInfoProvider: fetchNativeSteamAppInfoMetadata,
          mode: "fast"
        }
      );
    } else if (args.chosen.provider === "igdb" && settings.igdb) {
      const { IgdbClient, mapIgdbGameToPatch } = await import("@hynite/metadata");
      const client = new IgdbClient({
        clientId: await nativeBridge.decryptSecret(settings.igdb.clientId),
        clientSecret: await nativeBridge.decryptSecret(settings.igdb.clientSecret)
      });
      const igdbGame = await client.getGame(Number(args.chosen.externalId));
      if (igdbGame) patch = mapIgdbGameToPatch(igdbGame);
    }
    if (patch && Object.keys(patch).length > 0) {
      repository.applyMetadata(localId, patch);
    }
    // Remove the resolved issue from the in-memory scan report so the UI updates.
    const report = localImportService.lastReport;
    if (report) {
      report.issues = report.issues.filter((issue) => issue.candidateId !== args.candidateId);
    }
    return { ok: true };
  });
  handleIpc("games:set-launch-exe", (_event, args: { gameId: string; executablePath: string }) => {
    repository.setExecutablePath(args.gameId, args.executablePath);
    return { ok: true };
  });
  handleIpc("dialog:pick-folder", async (_event, args: { title?: string; defaultPath?: string } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: args.title ?? "Select folder",
      defaultPath: args.defaultPath,
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled) return undefined;
    return result.filePaths[0];
  });
  handleIpc("dialog:pick-file", async (
    _event,
    args: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } = {}
  ) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: args.title ?? "Select file",
      defaultPath: args.defaultPath,
      properties: ["openFile"],
      filters: args.filters
    });
    if (result.canceled) return undefined;
    return result.filePaths[0];
  });
  handleIpc("dialog:pick-files", async (
    _event,
    args: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> } = {}
  ) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: args.title ?? "Select files",
      defaultPath: args.defaultPath,
      properties: ["openFile", "multiSelections"],
      filters: args.filters
    });
    if (result.canceled) return [];
    return result.filePaths;
  });
  handleIpc("local:set-roots", async (_event, roots: Array<{ path: string; depth: number }>) => {
    return settingsService.update({ localRoots: roots });
  });
  handleIpc("local:set-exclude-patterns", async (_event, patterns: string[]) => {
    return settingsService.update({ localExcludePatterns: patterns });
  });
  handleIpc("metadata:save-igdb-credentials", async (_event, args: { clientId: string; clientSecret: string }) => {
    const clientId = await nativeBridge.encryptSecret({ value: args.clientId, scope: "current-user" });
    const clientSecret = await nativeBridge.encryptSecret({ value: args.clientSecret, scope: "current-user" });
    return settingsService.update({ igdb: { clientId, clientSecret } });
  });
  handleIpc("metadata:clear-igdb-credentials", async () => {
    return settingsService.update({ igdb: undefined });
  });

  handleIpc("library:list", (_event, query: LibraryQuery = {}) => repository.queryGames(query));
  handleIpc("library:clear", async () => {
    await withSteamSyncStartLock(() => cancelActiveSteamSync("Steam sync cancelled before clearing the library"));
    clearRichMetadataQueue("Detail metadata cancelled before clearing the library");
    const cleared = repository.clearLibrary();
    await homeService.clearCache();
    return { cleared };
  });

  handleIpc("games:get", (_event, id: string) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    enqueueRichMetadata(game, true);
    return { ...game, sourceMatches: sourceService.search(id) };
  });

  handleIpc("games:get-asset-candidates", async (_event, id: string) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    return getAssetCandidates(game);
  });

  handleIpc("games:update-assets", async (_event, id: string, update: GameAssetUpdate) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    const cachedPatch = await cacheMetadataAssets(assetUpdateToPatch(update), true);
    repository.updateGameAssets(id, patchToAssetUpdate(cachedPatch, update));
    const updated = repository.getGame(id);
    if (!updated) {
      throw new Error(`Game ${id} was not found after asset update.`);
    }
    const detail = { ...updated, sourceMatches: sourceService.search(id) };
    mainWindow?.webContents.send("games:updated", detail);
    return detail;
  });

  handleIpc("games:hydrateDiscovery", async (_event, game: Game) => {
    const hydrated = await hydrateDiscoveryDetailMetadata(game);
    return { ...hydrated, sourceMatches: sourceService.searchTitle(hydrated.title) };
  });

  handleIpc("games:launch", async (_event, id: string, preferredSteamId?: string) => resolveLaunchOrSwitch(id, preferredSteamId));
  handleIpc("steam:switchAndLaunch", async (_event, id: string, targetSteamId: string) => {
    const settings = await settingsService.get();
    const target = settings.steamAccounts.find((account) => account.steamId === targetSteamId);
    if (!target) {
      throw new Error(`Paired Steam account ${targetSteamId} not found.`);
    }
    if (!target.localUsername) {
      throw new Error("Map a local Steam username to this account before switching.");
    }
    await switchSteamAccount({ steamId: target.steamId, accountName: target.localUsername });
    return performLaunch(id);
  });
  handleIpc("steam:listLocalAccounts", async () => {
    const { accounts } = await readLoginUsers();
    return accounts;
  });
  handleIpc("steam:getActiveUser", () => getActiveSteamUser());
  handleIpc("steam:setAccountLocalUsername", async (_event, steamId: string, localUsername: string | undefined) => {
    const trimmed = localUsername?.trim();
    return settingsService.patchSteamAccount(steamId, { localUsername: trimmed ? trimmed : undefined });
  });
  handleIpc("steam:setPreferredLaunchAccount", async (_event, gameId: string, steamId: string | undefined) => {
    const trimmed = steamId?.trim();
    return settingsService.setLaunchAccountPreference(gameId, trimmed ? trimmed : undefined);
  });
  handleIpc("steam:removeAccount", async (_event, steamId: string) => settingsService.removeSteamAccount(steamId));

  handleIpc("home:get", async () => {
    const settings = await settingsService.get();
    const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
    return homeService.get(repository.listGames(), { steamGridDbApiKey, steamAppInfoProvider: fetchNativeSteamAppInfoMetadata });
  });
  handleIpc("sync:status", () => syncStatusService.get());
  handleIpc("sources:import", (_event, input: SourceImportInput) => sourceService.import(input));
  handleIpc("sources:list", () => sourceService.list());
  handleIpc("sources:remove", (_event, id: string) => sourceService.remove(id));
  handleIpc("sources:refreshSource", (_event, id: string, json: string) => sourceService.refreshSource(id, json));
  handleIpc("sources:search", (_event, gameId: string) => sourceService.search(gameId));
  handleIpc("sources:searchTitle", (_event, title: string, options) => sourceService.searchTitle(title, options));
  handleIpc("sources:exactTitleMatches", (_event, title: string) => sourceService.exactTitleMatches(title));
  handleIpc("clipboard:copy", (_event, text: string) => clipboard.writeText(text));
  handleIpc("settings:get", () => settingsService.get());
  handleIpc("settings:update", (_event, patch) => settingsService.update(patch));
  handleIpc("steam:pair", async () => {
    const paired = await pairSteamAccount(mainWindow);
    const current = await settingsService.get();
    const existing = current.steamAccounts.find((account) => account.steamId === paired.steamId);

    // Best-effort auto-map to a local Steam user — when the SteamID matches a row in
    // loginusers.vdf the user never has to choose anything by hand.
    let autoLocalUsername: string | undefined;
    let autoPersonaName: string | undefined;
    try {
      const { accounts } = await readLoginUsers();
      const match = accounts.find((account) => account.steamId === paired.steamId);
      if (match) {
        autoLocalUsername = match.accountName;
        autoPersonaName = match.personaName;
      }
    } catch (error) {
      console.warn("Could not auto-detect local Steam user", error);
    }

    await settingsService.upsertSteamAccount({
      ...(existing ?? {}),
      steamId: paired.steamId,
      pairedAt: paired.pairedAt,
      personaName: existing?.personaName ?? autoPersonaName,
      localUsername: existing?.localUsername ?? autoLocalUsername
    });
    return paired;
  });
  handleIpc("steam:saveApiKey", async (_event, apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Steam Web API key is required.");
    }
    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({ steamWebApiKey: encrypted });
  });
  handleIpc("steam:clearApiKey", async () => settingsService.update({ steamWebApiKey: undefined }));
  handleIpc("steam:disconnect", async (_event, steamId?: string) => {
    if (steamId) {
      return settingsService.removeSteamAccount(steamId);
    }
    return settingsService.update({ steamAccounts: [] });
  });
  handleIpc("steam:connectFamily", async (_event, steamId: string) => {
    const current = await settingsService.get();
    if (!current.steamAccounts.some((account) => account.steamId === steamId)) {
      throw new Error("Pair the Steam account before connecting the family library.");
    }
    const result = await authenticateSteamSession(mainWindow);
    if (result.steamId !== steamId) {
      throw new Error(
        `The Steam session you logged in as (${result.steamId}) doesn't match the paired account (${steamId}).`
      );
    }
    const encrypted = await nativeBridge.encryptSecret({ value: result.accessToken, scope: "current-user" });
    return settingsService.patchSteamAccount(steamId, {
      familySession: {
        accessToken: encrypted,
        steamId: result.steamId,
        expiresAt: result.expiresAt,
        connectedAt: new Date().toISOString()
      }
    });
  });
  handleIpc("steam:refreshFamily", async (_event, steamId: string) => {
    const current = await settingsService.get();
    const target = current.steamAccounts.find((account) => account.steamId === steamId);
    if (!target?.familySession) {
      throw new Error("Family library is not connected for this account.");
    }
    const refreshed = await refreshSteamAccessToken();
    if (!refreshed) {
      throw new Error("Steam family session expired; reconnect to continue.");
    }
    const encrypted = await nativeBridge.encryptSecret({ value: refreshed.accessToken, scope: "current-user" });
    return settingsService.patchSteamAccount(steamId, {
      familySession: {
        accessToken: encrypted,
        steamId: refreshed.steamId,
        expiresAt: refreshed.expiresAt,
        connectedAt: target.familySession.connectedAt
      }
    });
  });
  handleIpc("steam:disconnectFamily", async (_event, steamId: string) => {
    await disconnectSteamFamilySession();
    return settingsService.patchSteamAccount(steamId, { familySession: undefined });
  });
  handleIpc("steam:search", async (_event, query: string): Promise<SteamSearchResult[]> => {
    return searchSteamStore(query, net.fetch);
  });
  handleIpc("metadata:saveSteamGridDbKey", async (_event, apiKey: string) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("SteamGridDB API key is required.");
    }

    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({ steamGridDbApiKey: encrypted });
  });
  handleIpc("metadata:clearSteamGridDbKey", async () => settingsService.update({ steamGridDbApiKey: undefined }));
  handleIpc("native:openExternal", (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only web links can be opened externally.");
    }

    return shell.openExternal(parsed.toString());
  });
  handleIpc("native:openFolder", (_event, path: string) => shell.openPath(path));
  handleIpc("window:minimize", () => mainWindow?.minimize());
  handleIpc("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  handleIpc("window:close", () => mainWindow?.close());
  handleIpc("window:isMaximized", () => mainWindow?.isMaximized() ?? false);
  handleIpc("music:system-audio-active", () => getSystemAudioActive());
  handleIpc("music:system-audio-debug", async () => {
    if (process.platform !== "win32") return "not win32";
    try {
      const script = buildSystemAudioDebugScript();
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const { stdout } = await execFileAsync("powershell.exe", ["-NonInteractive", "-NoProfile", "-EncodedCommand", encoded], { timeout: 15_000 });
      return stdout.trim();
    } catch (err) {
      return `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  handleIpc("debug:seed", () => {
    const seeded = repository.upsertImportedGame({
      provider: "steam",
      externalId: "1086940",
      title: "Baldur's Gate 3",
      installState: "installed",
      launchCommand: "steam://rungameid/1086940",
      playtimeMinutes: 4200,
      lastPlayedAt: new Date().toISOString()
    });
    repository.applyMetadata(makeGameId("steam", "1086940"), {
      coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1086940/library_600x900.jpg",
      backgroundUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1086940/library_hero.jpg",
      genres: ["RPG", "Adventure", "Strategy"],
      tags: ["Choices Matter", "Story Rich", "Co-op"],
      developers: ["Larian Studios"],
      publishers: ["Larian Studios"],
      releaseDate: "2023-08-03",
      metadataStatus: "complete"
    });
    return seeded;
  });
}

app.whenReady().then(() => {
  const userData = app.getPath("userData");
  startupProfileService = new StartupProfileService(userData, app.getVersion());
  profile("app:ready", "Electron app ready", {
    userData,
    profileCommand: startupProfileService.enabled,
    versions: process.versions
  });
  startStartupHeartbeat();
  repository = new HyniteRepository(join(userData, "hynite.db"));
  profile("services:repository", "Repository opened");
  settingsService = new SettingsService(join(userData, "settings.json"));
  diagnosticLogService = new DiagnosticLogService(join(userData, "metadata-diagnostics.ndjson"));
  homeService = new HomeService(join(userData, "home-cache.json"), diagnosticLogService);
  sourceService = new SourceService(repository);
  assetCacheService = new AssetCacheService(join(userData, "asset-cache"), startupProfileService);
  assetCacheService.registerProtocol(protocol);
  soundFileService = new SoundFileService(() => settingsService.get());
  soundFileService.registerProtocol(protocol);
  soundFileService.registerMusicProtocol(protocol);
  nativeBridge = new NativeBridge();
  syncStatusService = new SyncStatusService(() => mainWindow, join(userData, "sync-status.json"));
  launchTracker = new LaunchTracker(repository);
  localImportService = new LocalImportService(join(userData, "local-scan-cache.json"), repository, nativeBridge);
  profile("services:ready", "Main services initialized");
  registerIpc();
  profile("ipc:registered", "IPC handlers registered");
  startSystemAudioMonitor();
  createWindow();
  createSplashWindow();
  startupReadyTimeout = setTimeout(() => {
    profile("startup:ready-timeout", "Startup ready timeout — showing main window");
    dismissSplash();
  }, 30_000);
  startupReadyTimeout.unref?.();
  void settingsService.get().then((settings) => {
    const canSync = Boolean(settings.steamWebApiKey) && settings.steamAccounts.length > 0;
    profile("startup:settings-loaded", "Startup settings loaded", {
      steamAccounts: settings.steamAccounts.length,
      hasSteamWebApiKey: Boolean(settings.steamWebApiKey),
      hasSteamGridDbApiKey: Boolean(settings.steamGridDbApiKey)
    });
    const localRoots = (settings.localRoots ?? []).filter((root) => root.path && root.path.trim().length > 0);
    const runStartupLocalScan = (): void => {
      if (localRoots.length === 0) return;
      profile("startup:background:local-scan:scheduled", "Startup background local scan scheduled", { rootCount: localRoots.length, delayMs: STARTUP_LOCAL_SCAN_DELAY_MS });
      setTimeout(() => {
        profile("startup:background:local-scan", "Starting background local scan", { rootCount: localRoots.length });
        void runLocalScan().catch((error: unknown) => {
          console.warn("Startup local scan failed", error);
        });
      }, STARTUP_LOCAL_SCAN_DELAY_MS).unref?.();
    };

    runAfterInitialRendererPaint(() => {
      profile("startup:background:start", "Startup background work started");
      if (canSync) {
        void startSteamSync("steam", { refreshStaleMetadata: false }).catch((error: unknown) => {
          if (isSteamSyncCancelledError(error)) {
            return;
          }
          console.warn("Startup Steam sync failed", error);
        }).finally(() => {
          profile("startup:background:rich-backfill", "Queueing rich metadata after startup Steam sync");
          enqueueRichMetadataBackfill();
          runStartupLocalScan();
        });
        return;
      }

      profile("startup:background:rich-backfill", "Queueing rich metadata without startup Steam sync");
      enqueueRichMetadataBackfill();
      runStartupLocalScan();
    });
  });
});

app.on("window-all-closed", () => {
  profile("app:window-all-closed", "All windows closed");
  if (startupHeartbeatTimer) {
    clearInterval(startupHeartbeatTimer);
    startupHeartbeatTimer = undefined;
  }
  stopSystemAudioMonitor();
  syncStatusService?.flush();
  void startupProfileService?.finish();
  repository?.close();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  profile("app:activate", "Electron app activated");
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
