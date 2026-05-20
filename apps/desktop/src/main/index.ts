import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, powerMonitor, protocol, screen, session, shell, Tray } from "electron";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { HyniteRepository } from "@hynite/db";
import { discoverInstalledSteamApps, hashFolderPath, readLoginUsers, SteamImporterProvider, type SteamFamilyScanStatus } from "@hynite/importers";
import type { IdentifyCandidate, LocalScanIssue } from "@hynite/importers";
import { LocalImportService } from "./localImportService";
import { LaunchTracker } from "./launchTracker";
import { makeGameId, resolveLaunchableSteamAccounts, type AppSettings, type EncryptedSecret, type Game, type GameAssetCandidate, type GameAssetCandidateResult, type GameAssetKind, type GameAssetUpdate, type GameMetadataPatch, type ImportedGame, type LaunchSession, type LibraryQuery, type OnboardingState, type ProfileSpanHandle, type ProviderId, type SourceImportInput, type SpotlightPendingAction, type SpotlightState, type SteamAccountSettings, type SteamLocalAccount, type SteamLaunchAccountOption, type SteamSearchResult, type SteamStoreEmbedInfo, type SyncResult, type WindowBounds, type WindowState, type WishlistCalendarQuery, type WishlistListQuery } from "@hynite/core";
import { getActiveSteamUser, switchSteamAccount } from "./steamSwitchService";
import { buildIgdbImageUrl, fetchSteamMetadata, IgdbClient, metadataFromSteamAppDetailsResponse, metadataFromSteamAppInfo, refreshFusedMetadata, type IgdbGame } from "@hynite/metadata";
import { DiagnosticLogService } from "./diagnosticLogService";
import { HomeService } from "./homeService";
import { NativeBridge } from "./nativeBridge";
import { SettingsService } from "./settingsService";
import { SoundFileService } from "./soundFileService";
import { SourceService } from "./sourceService";
import { searchSteamStore } from "./steamSearchService";
import { SteamWishlistService } from "./steamWishlistService";
import { StartupProfileService } from "./startupProfileService";
import { SyncStatusService } from "./syncStatusService";
import { UpdaterService } from "./updaterService";
import { AssetCacheService } from "./assetCacheService";
import { BackgroundService } from "./backgroundService";
import { LocalPlaytimeMonitor } from "./localPlaytimeMonitor";
import { SpotlightService } from "./spotlightService";
import {
  authenticateSteamSession,
  disconnectSteamFamilySession,
  isSteamStoreSessionLoggedIn,
  pairSteamAccount,
  refreshSteamAccessToken,
  steamFamilySessionPartition
} from "./steamAuthService";
import { initMainObservability, setObservabilityEnabled } from "./observability";
import { acceleratorFromHotkeyInput } from "../shared/hotkey";

// Initialize crash reporting before any app logic so early failures are captured.
initMainObservability();

let mainWindow: Electron.BrowserWindow | undefined;
let splashWindow: Electron.BrowserWindow | undefined;
let spotlightWindow: Electron.BrowserWindow | undefined;
let tray: Tray | undefined;
let startupReadyTimeout: ReturnType<typeof setTimeout> | undefined;
let revealMainWindowInProgress = false;
let startupReadyHandled = false;
let pendingMainWindowFocus = false;
let pendingMainWindowMaximize = false;
let repository: HyniteRepository;
let settingsService: SettingsService;
let homeService: HomeService;
let sourceService: SourceService;
let nativeBridge: NativeBridge;
let syncStatusService: SyncStatusService;
let updaterService: UpdaterService;
let assetCacheService: AssetCacheService;
let soundFileService: SoundFileService;
let diagnosticLogService: DiagnosticLogService;
let localImportService: LocalImportService;
let launchTracker: LaunchTracker;
let localPlaytimeMonitor: LocalPlaytimeMonitor;
let backgroundService: BackgroundService;
let spotlightService: SpotlightService;
let steamWishlistService: SteamWishlistService;
let activeLocalScan: { promise: Promise<unknown>; controller: AbortController } | undefined;
let startupProfileService: StartupProfileService | undefined;
let startupHeartbeatTimer: NodeJS.Timeout | undefined;
let resourceSampleTimer: NodeJS.Timeout | undefined;
let resourceSampleRunning = false;
let rendererUnresponsiveAt: number | undefined;
let windowStateSaveTimer: ReturnType<typeof setTimeout> | undefined;
let windowStateSaveChain: Promise<unknown> = Promise.resolve();
let mainWindowUsesOnboardingBounds = false;
let suppressWindowStateSave = false;
let isQuitting = false;
let servicesShutDown = false;
let controllerPollingStarted = false;
let foregroundStartupBackgroundWorkScheduled = false;
let settingsBackupTimer: NodeJS.Timeout | undefined;
let resetEverythingInProgress = false;
let spotlightState: SpotlightState = { enabled: true, hotkey: "Alt+Space", registered: false };
let steamTagDirectoryRefresh: Promise<void> | undefined;
let registeredSpotlightHotkey: string | undefined;
let pendingSpotlightAction: SpotlightPendingAction | undefined;
let spotlightLaunchHandoffActive = false;
let spotlightHotkeyCaptureSenderId: number | undefined;
let spotlightHotkeyCaptureCompleted = false;

function resolveWindowIconPath(): string {
  const devIconPath = join(__dirname, "../../assets/icons/app.ico");
  const packagedIconPath = join(process.resourcesPath ?? "", "icons/app.ico");
  if (app.isPackaged && existsSync(packagedIconPath)) {
    return packagedIconPath;
  }
  return devIconPath;
}

const windowIconPath = resolveWindowIconPath();
const WINDOWS_APP_USER_MODEL_ID = "app.hynite.launcher";
const BACKGROUND_ARG = "--background";
const ONBOARDING_PREVIEW_ARG = "--onboarding-preview";
const DEFAULT_WINDOW_WIDTH = 980;
const DEFAULT_WINDOW_HEIGHT = 660;
const MIN_WINDOW_WIDTH = 980;
const MIN_WINDOW_HEIGHT = 360;
const ONBOARDING_WINDOW_WIDTH = 980;
const ONBOARDING_WINDOW_HEIGHT = 560;
const MIN_ONBOARDING_WINDOW_WIDTH = 760;
const MIN_ONBOARDING_WINDOW_HEIGHT = 360;
const MIN_VISIBLE_WINDOW_PX = 80;
const STEAM_STORE_HOME_URL = "https://store.steampowered.com/";
const METADATA_REFRESH_CONCURRENCY = 4;
const RICH_METADATA_CONCURRENCY = 1;
const RICH_METADATA_STARTUP_LIMIT = Number.POSITIVE_INFINITY;
const FOREGROUND_STARTUP_BACKGROUND_DELAY_MS = 1_000;
const STARTUP_BACKGROUND_DELAY_MS = FOREGROUND_STARTUP_BACKGROUND_DELAY_MS;
const STARTUP_LOCAL_SCAN_DELAY_MS = 3_000;
const STEAM_SYNC_UPSERT_YIELD_INTERVAL = 25;
const STEAM_SYNC_MIN_UPSERT_YIELD_INTERVAL = 5;
const PREFETCH_LAST_PLAYED_BATCH_SIZE = 100;
const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;

function pairedAtTime(account: SteamAccountSettings): number {
  const time = Date.parse(account.pairedAt);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function firstPairedSteamAccount(accounts: SteamAccountSettings[]): SteamAccountSettings | undefined {
  return accounts.reduce<SteamAccountSettings | undefined>((earliest, account) => {
    if (!earliest) return account;
    return pairedAtTime(account) < pairedAtTime(earliest) ? account : earliest;
  }, undefined);
}

function envFlagEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function isOnboardingPreview(argv = process.argv): boolean {
  return envFlagEnabled(process.env.HYNITE_ONBOARDING_PREVIEW) || argv.includes(ONBOARDING_PREVIEW_ARG);
}

const onboardingPreview = isOnboardingPreview();

function transientUserDataPath(userData: string, name: string): string {
  return onboardingPreview ? join(app.getPath("temp"), `hynite-onboarding-preview-${process.pid}`, name) : join(userData, name);
}

const RESET_USER_DATA_ENTRIES = [
  "hynite.db",
  "hynite.db-shm",
  "hynite.db-wal",
  "settings.json",
  "settings.json.bak",
  "settings-backups",
  "metadata-diagnostics.ndjson",
  "home-cache.json",
  "asset-cache",
  "sync-status.json",
  "local-scan-cache.json",
  "profile-runs",
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "blob_storage",
  "Local Storage",
  "IndexedDB",
  "Session Storage",
  "Service Worker",
  "Shared Dictionary",
  "Network",
  "Cookies",
  "Cookies-journal",
  "DIPS",
  "DIPS-journal"
];
protocol.registerSchemesAsPrivileged([
  { scheme: "hynite-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "hynite-sound", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "hynite-music", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

if (process.platform === "win32") {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}
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

function normalizeIsoTimestamp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

async function getOnboardingState(): Promise<OnboardingState> {
  const firstRun = !settingsService.hasPersistedSettings();
  const settings = await settingsService.get();
  const completedAt = settings.onboarding?.completedAt ?? settings.onboarding?.skippedAt;
  return {
    shouldShow: onboardingPreview || (firstRun && !completedAt),
    firstRun,
    preview: onboardingPreview,
    completedAt
  };
}

async function completeOnboarding(input?: { skipped?: boolean }): Promise<AppSettings> {
  if (onboardingPreview) {
    return settingsService.get();
  }
  const now = new Date().toISOString();
  return settingsService.update({
    onboarding: input?.skipped
      ? { version: 1, skippedAt: now }
      : { version: 1, completedAt: now }
  });
}

function emitGameUpdated(gameId: string): void {
  const updated = repository.getGame(gameId);
  if (!updated || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("games:updated", { ...updated, sourceMatches: sourceService.search(updated.id) });
}

async function syncLocalLastPlayedFromPrefetch(repo: HyniteRepository, bridge: NativeBridge): Promise<number> {
  const games = repo.getLocalGameExecutables();
  if (games.length === 0) return 0;

  const span = profileSpan("local-activity", "local-activity:prefetch-sync", { games: games.length });
  let updatedCount = 0;
  try {
    for (let index = 0; index < games.length; index += PREFETCH_LAST_PLAYED_BATCH_SIZE) {
      const batch = games.slice(index, index + PREFETCH_LAST_PLAYED_BATCH_SIZE);
      const results = await bridge.getPrefetchLastRunTimes(batch.map((game) => game.executablePath));
      const byPath = new Map(results.map((result) => [result.path.toLowerCase(), normalizeIsoTimestamp(result.lastRunAt)]));

      for (const game of batch) {
        const lastRunAt = byPath.get(game.executablePath.toLowerCase());
        if (!lastRunAt) continue;
        if (repo.updateLastPlayedAtIfNewer(game.id, lastRunAt)) {
          updatedCount += 1;
          emitGameUpdated(game.id);
        }
      }
      await yieldToEventLoop();
    }
    span.end("ok", { games: games.length, updated: updatedCount });
    return updatedCount;
  } catch (error) {
    span.end("error", { games: games.length, updated: updatedCount, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function backfillLocalAddedAt(repo: HyniteRepository): Promise<void> {
  const games = repo.getLocalGamesWithoutAddedAt();
  if (games.length === 0) return;
  for (const game of games) {
    const pathToStat = game.installDirectory ?? game.executablePath;
    if (!pathToStat) continue;
    try {
      const s = await stat(pathToStat);
      if (typeof s.birthtimeMs === "number" && Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0) {
        repo.setAddedAt(game.id, new Date(s.birthtimeMs).toISOString());
      }
    } catch {
      // path inaccessible — skip
    }
    await yieldToEventLoop();
  }
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

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

async function readProcessRssMb(pid: number | undefined): Promise<number | undefined> {
  if (!pid || process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      windowsHide: true,
      timeout: 2_000
    });
    const line = stdout.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry && !entry.includes("No tasks"));
    if (!line) return undefined;
    const columns = parseCsvLine(line);
    const memText = columns[4] ?? "";
    const kb = Number(memText.replace(/[^\d]/g, ""));
    return Number.isFinite(kb) && kb > 0 ? Math.round((kb / 1024) * 10) / 10 : undefined;
  } catch {
    return undefined;
  }
}

async function sampleResources(): Promise<void> {
  if (!startupProfileService?.enabled || resourceSampleRunning) return;
  resourceSampleRunning = true;
  try {
    const memory = process.memoryUsage();
    const electronMetrics = app.getAppMetrics();
    const totalElectronWorkingSetMb = electronMetrics.reduce((sum, metric) => {
      const workingSetKb = Number((metric as any).memory?.workingSetSize ?? 0);
      return sum + (Number.isFinite(workingSetKb) ? workingSetKb / 1024 : 0);
    }, 0);
    const totalElectronCpuPercent = electronMetrics.reduce((sum, metric) => {
      const cpu = Number((metric as any).cpu?.percentCPUUsage ?? 0);
      return sum + (Number.isFinite(cpu) ? cpu : 0);
    }, 0);
    const rendererProcessCount = electronMetrics.filter((metric) => {
      const type = String((metric as any).type ?? "").toLowerCase();
      return type.includes("renderer") || type.includes("tab");
    }).length;
    const nativeInfo = nativeBridge?.getProcessInfo();
    const nativeBridgeRssMb = await readProcessRssMb(nativeInfo?.pid);
    const backgroundState = backgroundService?.getState();
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;

    startupProfileService.metric("resource", "resource:sample", Math.round(totalElectronCpuPercent * 10) / 10, {
      mode: window ? "foreground" : "tray",
      hasWindow: Boolean(window),
      windowVisible: window?.isVisible() ?? false,
      windowMinimized: window?.isMinimized() ?? false,
      rendererProcessCount,
      mainRssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
      heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
      heapTotalMb: Math.round((memory.heapTotal / 1024 / 1024) * 10) / 10,
      externalMb: Math.round((memory.external / 1024 / 1024) * 10) / 10,
      totalElectronWorkingSetMb: Math.round(totalElectronWorkingSetMb * 10) / 10,
      totalElectronCpuPercent: Math.round(totalElectronCpuPercent * 10) / 10,
      nativeBridgeRunning: nativeInfo?.running ?? false,
      nativeBridgePid: nativeInfo?.pid,
      nativeBridgeRssMb,
      backgroundMode: backgroundState?.mode,
      backgroundTimerCount: backgroundState?.timerCount,
      backgroundRunningSteam: backgroundState?.runningSteam,
      backgroundRunningLocalScan: backgroundState?.runningLocalScan,
      backgroundRunningPrefetch: backgroundState?.runningPrefetch
    });
  } catch (error) {
    startupProfileService?.point("resource", "resource:sample-error", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    resourceSampleRunning = false;
  }
}

function startResourceSampler(): void {
  if (!startupProfileService?.enabled || resourceSampleTimer) return;
  void sampleResources();
  resourceSampleTimer = setInterval(() => {
    void sampleResources();
  }, RESOURCE_SAMPLE_INTERVAL_MS);
  resourceSampleTimer.unref?.();
}

function stopResourceSampler(): void {
  if (!resourceSampleTimer) return;
  clearInterval(resourceSampleTimer);
  resourceSampleTimer = undefined;
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
    const refreshed = await refreshSteamAccessToken(account.steamId);
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

type SteamTagApiEntry = {
  tagid?: number | string;
  name?: string;
};

function steamTagIdsFromAppInfo(storeTags: Record<string, string> | undefined): string[] {
  return [...new Set(
    Object.values(storeTags ?? {})
      .map((tag) => tag.trim())
      .filter((tag) => /^\d+$/.test(tag))
  )];
}

function inlineSteamTagNames(storeTags: Record<string, string> | undefined): string[] {
  return Object.values(storeTags ?? {})
    .map((tag) => tag.trim())
    .filter((tag) => tag && !/^\d+$/.test(tag));
}

async function refreshSteamTagDirectory(): Promise<void> {
  if (steamTagDirectoryRefresh) {
    return steamTagDirectoryRefresh;
  }

  steamTagDirectoryRefresh = (async () => {
    const response = await fetch("https://store.steampowered.com/tagdata/populartags/english?cc=DE");
    if (!response.ok) {
      throw new Error(`Steam tag directory returned ${response.status}`);
    }

    const json = (await response.json()) as SteamTagApiEntry[];
    const tags = json
      .map((entry) => ({
        tagId: entry.tagid === undefined ? "" : String(entry.tagid),
        name: entry.name?.trim() ?? ""
      }))
      .filter((entry) => entry.tagId && entry.name);
    repository.upsertSteamTags(tags);
    diagnosticLogService?.log({
      level: "info",
      phase: "metadata:steam-tags",
      message: "Steam tag directory refreshed",
      details: { tags: tags.length }
    });
  })().finally(() => {
    steamTagDirectoryRefresh = undefined;
  });

  return steamTagDirectoryRefresh;
}

async function resolveSteamAppInfoTagNames(storeTags: Record<string, string> | undefined, game: ImportedGame): Promise<string[]> {
  const inlineNames = inlineSteamTagNames(storeTags);
  const tagIds = steamTagIdsFromAppInfo(storeTags);
  if (tagIds.length === 0) {
    return inlineNames;
  }

  let known = repository.getSteamTagNames(tagIds);
  const missing = tagIds.filter((tagId) => !known.has(tagId));
  if (missing.length > 0) {
    diagnosticLogService?.log({
      level: "info",
      phase: "metadata:steam-tags",
      message: `${game.title}: resolving unknown Steam tag ids`,
      details: {
        appid: game.externalId,
        missingTagIds: missing.slice(0, 20),
        totalMissing: missing.length
      }
    });
    try {
      await refreshSteamTagDirectory();
      known = repository.getSteamTagNames(tagIds);
    } catch (error) {
      diagnosticLogService?.log({
        level: "warning",
        phase: "metadata:steam-tags",
        message: `${game.title}: Steam tag directory refresh failed`,
        details: {
          appid: game.externalId,
          missingTagIds: missing.slice(0, 20),
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  return [...inlineNames, ...tagIds.map((tagId) => known.get(tagId)).filter((name): name is string => Boolean(name))]
    .filter((name, index, names) => names.indexOf(name) === index);
}

async function fetchNativeSteamAppInfoMetadata(game: ImportedGame) {
  const span = profileSpan("native-bridge", "steam-appinfo:native", { appid: game.externalId, title: game.title });
  try {
    const appInfo = await nativeBridge.getSteamAppInfo(game.externalId);
    if (appInfo) {
      saveSteamRawMetadata(makeGameId(game.provider, game.externalId), game.externalId, "steam_appinfo", appInfo.raw ?? appInfo);
    }
    const storeTagNames = appInfo ? await resolveSteamAppInfoTagNames(appInfo.storeTags, game) : [];
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
            storeTags: appInfo.storeTags,
            storeTagNames,
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
      storeTagIds: steamTagIdsFromAppInfo(appInfo?.storeTags).length,
      storeTagNames: storeTagNames.length,
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

async function resetEverythingAndRelaunch(): Promise<{ ok: true; removed: string[]; failed: Array<{ entry: string; error: string }> }> {
  if (onboardingPreview) {
    return { ok: true, removed: [], failed: [] };
  }
  if (resetEverythingInProgress) {
    return { ok: true, removed: [], failed: [] };
  }
  resetEverythingInProgress = true;
  suppressWindowStateSave = true;
  isQuitting = true;

  if (startupReadyTimeout) {
    clearTimeout(startupReadyTimeout);
    startupReadyTimeout = undefined;
  }
  if (startupHeartbeatTimer) {
    clearInterval(startupHeartbeatTimer);
    startupHeartbeatTimer = undefined;
  }
  if (settingsBackupTimer) {
    clearInterval(settingsBackupTimer);
    settingsBackupTimer = undefined;
  }
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = undefined;
  }

  activeLocalScan?.controller.abort();
  await withSteamSyncStartLock(() => cancelActiveSteamSync("Steam sync cancelled before resetting all app data")).catch(() => undefined);
  clearRichMetadataQueue("Detail metadata cancelled before resetting all app data");
  backgroundService?.stop();
  stopResourceSampler();
  stopSystemAudioMonitor();

  await session.defaultSession.clearStorageData().catch(() => undefined);
  await session.defaultSession.clearCache().catch(() => undefined);
  await startupProfileService?.finish().catch(() => undefined);

  try {
    repository?.close();
  } catch {
    // Reset is best-effort after shutdown; stale handles should not block deletion.
  }
  try {
    nativeBridge?.dispose();
  } catch {
    // Ignore bridge shutdown failures during reset.
  }
  servicesShutDown = true;

  const userData = app.getPath("userData");
  const results = await Promise.allSettled(RESET_USER_DATA_ENTRIES.map(async (entry) => {
    await rm(join(userData, entry), { recursive: true, force: true });
    return entry;
  }));
  const removed: string[] = [];
  const failed: Array<{ entry: string; error: string }> = [];
  results.forEach((result, index) => {
    const entry = RESET_USER_DATA_ENTRIES[index]!;
    if (result.status === "fulfilled") {
      removed.push(entry);
    } else {
      failed.push({ entry, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
  });

  app.relaunch({ args: process.argv.slice(1) });
  setImmediate(() => app.quit());
  return { ok: true, removed, failed };
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

type MissingLocalGameIssue = Omit<LocalScanIssue, "reason"> & {
  reason: "missing_install";
  gameId: string;
  gameTitle: string;
};

function normalizeFolderPrefix(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

function isPathUnderFolder(path: string, folder: string): boolean {
  const normalizedPath = normalizeFolderPrefix(path);
  const normalizedFolder = normalizeFolderPrefix(folder);
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}\\`) || normalizedPath.startsWith(`${normalizedFolder}/`);
}

async function pathExists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function summarizeLocalIssuesForDiagnostics(issues: Array<LocalScanIssue | MissingLocalGameIssue>): Record<string, unknown> {
  const byReason = issues.reduce<Record<string, number>>((counts, issue) => {
    counts[issue.reason] = (counts[issue.reason] ?? 0) + 1;
    return counts;
  }, {});
  return {
    total: issues.length,
    byReason,
    sample: issues.slice(0, 20).map((issue) => ({
      candidateId: issue.candidateId,
      gameId: "gameId" in issue ? issue.gameId : undefined,
      reason: issue.reason,
      folderPath: issue.folderPath,
      folderName: issue.folderName
    }))
  };
}

async function getLocalIssues(settings: AppSettings): Promise<Array<LocalScanIssue | MissingLocalGameIssue>> {
  const scanIssues = await localImportService.getIssues(settings.localIgnoredPaths ?? []);
  const roots = (settings.localRoots ?? []).filter((root) => root.path.trim().length > 0);
  if (roots.length === 0) {
    diagnosticLogService.log({
      level: "info",
      phase: "local:issues",
      message: "Local issues queried",
      details: {
        rootCount: 0,
        ignoredPathCount: settings.localIgnoredPaths?.length ?? 0,
        scanIssues: summarizeLocalIssuesForDiagnostics(scanIssues),
        missingInstallIssues: summarizeLocalIssuesForDiagnostics([]),
        returned: summarizeLocalIssuesForDiagnostics(scanIssues)
      }
    });
    return scanIssues;
  }
  const availableRoots = (
    await Promise.all(roots.map(async (root) => ((await pathExists(root.path)) ? root : undefined)))
  ).filter((root): root is { path: string; depth: number } => Boolean(root));
  if (availableRoots.length === 0) {
    diagnosticLogService.log({
      level: "info",
      phase: "local:issues",
      message: "Local issues queried",
      details: {
        rootCount: roots.length,
        availableRootCount: 0,
        unavailableRoots: roots.map((root) => root.path),
        ignoredPathCount: settings.localIgnoredPaths?.length ?? 0,
        scanIssues: summarizeLocalIssuesForDiagnostics(scanIssues),
        missingInstallIssues: summarizeLocalIssuesForDiagnostics([]),
        returned: summarizeLocalIssuesForDiagnostics(scanIssues)
      }
    });
    return scanIssues;
  }

  const missing = await Promise.all(
    repository
      .listLocalGames()
      .filter((game) => game.installDirectory && availableRoots.some((root) => isPathUnderFolder(game.installDirectory!, root.path)))
      .map(async (game): Promise<MissingLocalGameIssue | undefined> => {
        if (await pathExists(game.installDirectory)) return undefined;
        return {
          candidateId: game.id,
          gameId: game.id,
          gameTitle: game.title,
          folderPath: game.installDirectory!,
          folderName: game.title,
          reason: "missing_install"
        };
      })
  );
  const missingIssues = missing.filter((issue): issue is MissingLocalGameIssue => Boolean(issue));
  const returned = [...scanIssues, ...missingIssues];
  diagnosticLogService.log({
    level: "info",
    phase: "local:issues",
    message: "Local issues queried",
    details: {
      rootCount: roots.length,
      availableRootCount: availableRoots.length,
      unavailableRoots: roots.filter((root) => !availableRoots.some((available) => available.path === root.path)).map((root) => root.path),
      ignoredPathCount: settings.localIgnoredPaths?.length ?? 0,
      scanIssues: summarizeLocalIssuesForDiagnostics(scanIssues),
      missingInstallIssues: summarizeLocalIssuesForDiagnostics(missingIssues),
      returned: summarizeLocalIssuesForDiagnostics(returned)
    }
  });
  return returned;
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
    const rawLookupSpan = profileSpan("metadata", "metadata:detail:raw-cache-lookup", { gameId: game.id, appid: imported.externalId, title: game.title });
    const cachedRaw = repository.getRawGameMetadata("steam", imported.externalId, "steam_appdetails");
    rawLookupSpan.end("ok", { gameId: game.id, appid: imported.externalId, title: game.title, cacheHit: Boolean(cachedRaw) });
    if (cachedRaw) {
      const normalizeSpan = profileSpan("metadata", "metadata:detail:raw-cache-normalize", { gameId: game.id, appid: imported.externalId, title: game.title });
      const cachedMetadata = metadataFromSteamAppDetailsResponse(imported.externalId, cachedRaw.raw, undefined, imported.title);
      normalizeSpan.end(cachedMetadata.metadataStatus === "failed" ? "error" : "ok", {
        gameId: game.id,
        appid: imported.externalId,
        title: game.title,
        metadataStatus: cachedMetadata.metadataStatus,
        fields: Object.keys(cachedMetadata)
      });
      if (cachedMetadata.metadataStatus !== "failed") {
        const cacheAssetsSpan = profileSpan("metadata", "metadata:detail:asset-cache", { gameId: game.id, appid: imported.externalId, title: game.title, source: "raw-cache" });
        const cachedAssetsMetadata = await cacheMetadataAssets(cachedMetadata);
        cacheAssetsSpan.end("ok", { gameId: game.id, appid: imported.externalId, title: game.title, fields: Object.keys(cachedAssetsMetadata) });
        const applySpan = profileSpan("metadata", "metadata:detail:apply", { gameId: game.id, appid: imported.externalId, title: game.title, source: "raw-cache" });
        repository.applyMetadata(game.id, cachedAssetsMetadata);
        const hydrated = repository.getGame(game.id) ?? game;
        applySpan.end("ok", {
          gameId: game.id,
          appid: imported.externalId,
          title: game.title,
          screenshots: hydrated.screenshots.length,
          hasTrailer: Boolean(hydrated.trailerUrl),
          hasAboutText: Boolean(hydrated.aboutText)
        });
        return hydrated;
      }
    }

    syncStatusService.log("info", "metadata:detail", `Fetching detail metadata for ${game.title}`, { appid: imported.externalId });
    const fetchSpan = profileSpan("metadata", "metadata:detail:steam-fetch", { gameId: game.id, appid: imported.externalId, title: game.title });
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
    fetchSpan.end(metadata.metadataStatus === "failed" ? "error" : "ok", {
      gameId: game.id,
      appid: imported.externalId,
      title: game.title,
      metadataStatus: metadata.metadataStatus,
      fields: Object.keys(metadata)
    });
    if (metadata.metadataStatus === "failed") {
      return game;
    }

    const cacheAssetsSpan = profileSpan("metadata", "metadata:detail:asset-cache", { gameId: game.id, appid: imported.externalId, title: game.title, source: "steam-fetch" });
    const cachedMetadata = await cacheMetadataAssets(metadata);
    cacheAssetsSpan.end("ok", { gameId: game.id, appid: imported.externalId, title: game.title, fields: Object.keys(cachedMetadata) });
    const applySpan = profileSpan("metadata", "metadata:detail:apply", { gameId: game.id, appid: imported.externalId, title: game.title, source: "steam-fetch" });
    repository.applyMetadata(game.id, cachedMetadata);
    const hydrated = repository.getGame(game.id) ?? game;
    applySpan.end("ok", {
      gameId: game.id,
      appid: imported.externalId,
      title: game.title,
      screenshots: hydrated.screenshots.length,
      hasTrailer: Boolean(hydrated.trailerUrl),
      hasAboutText: Boolean(hydrated.aboutText)
    });
    return hydrated;
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

function centerInWorkArea(display: Electron.Display, width: number, height: number): WindowBounds {
  const { workArea } = display;
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height
  };
}

type WindowSizing = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

const MAIN_WINDOW_SIZING: WindowSizing = {
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  minWidth: MIN_WINDOW_WIDTH,
  minHeight: MIN_WINDOW_HEIGHT
};

const ONBOARDING_WINDOW_SIZING: WindowSizing = {
  width: ONBOARDING_WINDOW_WIDTH,
  height: ONBOARDING_WINDOW_HEIGHT,
  minWidth: MIN_ONBOARDING_WINDOW_WIDTH,
  minHeight: MIN_ONBOARDING_WINDOW_HEIGHT
};

function clampWindowBoundsToDisplay(bounds: WindowBounds, display: Electron.Display, sizing: WindowSizing): WindowBounds {
  const { workArea } = display;
  const width = Math.min(Math.max(sizing.minWidth, Math.round(bounds.width)), Math.max(sizing.minWidth, workArea.width));
  const height = Math.min(Math.max(sizing.minHeight, Math.round(bounds.height)), Math.max(sizing.minHeight, workArea.height));
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + workArea.width - Math.min(width, MIN_VISIBLE_WINDOW_PX);
  const maxY = workArea.y + workArea.height - Math.min(height, MIN_VISIBLE_WINDOW_PX);
  return {
    x: Math.min(Math.max(Math.round(bounds.x), minX - width + MIN_VISIBLE_WINDOW_PX), Math.max(minX, maxX)),
    y: Math.min(Math.max(Math.round(bounds.y), minY), Math.max(minY, maxY)),
    width,
    height
  };
}

function resolveWindowBounds(state: WindowState | undefined, sizing: WindowSizing, useSavedState: boolean): WindowBounds {
  const stateBounds = useSavedState ? state?.bounds : undefined;
  const displays = screen.getAllDisplays();
  const savedDisplay = useSavedState && state?.displayId !== undefined
    ? displays.find((display) => display.id === state.displayId)
    : undefined;
  const display = savedDisplay
    ?? (stateBounds ? screen.getDisplayMatching(stateBounds) : screen.getPrimaryDisplay());
  const fallback = centerInWorkArea(display, sizing.width, sizing.height);
  return clampWindowBoundsToDisplay(stateBounds ?? fallback, display, sizing);
}

function currentWindowState(window: Electron.BrowserWindow): WindowState | undefined {
  if (window.isDestroyed() || window.isMinimized()) {
    return undefined;
  }
  const rawBounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  const bounds: WindowBounds = {
    x: Math.round(rawBounds.x),
    y: Math.round(rawBounds.y),
    width: Math.round(rawBounds.width),
    height: Math.round(rawBounds.height)
  };
  return {
    bounds,
    displayId: screen.getDisplayMatching(bounds).id,
    isMaximized: window.isMaximized()
  };
}

function persistWindowState(state: WindowState): void {
  if (onboardingPreview || mainWindowUsesOnboardingBounds || suppressWindowStateSave) {
    return;
  }
  const write = () => settingsService.update({ windowState: state }).then(() => undefined);
  windowStateSaveChain = windowStateSaveChain.then(write, write).catch((err) => {
    console.error("Failed to persist window state", err);
  });
}

function saveWindowStateNow(window: Electron.BrowserWindow | undefined = mainWindow): void {
  if (suppressWindowStateSave || mainWindowUsesOnboardingBounds) {
    return;
  }
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = undefined;
  }
  if (!window) {
    return;
  }
  const state = currentWindowState(window);
  if (state) {
    persistWindowState(state);
  }
}

function scheduleWindowStateSave(window: Electron.BrowserWindow | undefined = mainWindow): void {
  if (suppressWindowStateSave || mainWindowUsesOnboardingBounds || !window || window.isDestroyed() || window.isMinimized()) {
    return;
  }
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
  }
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = undefined;
    saveWindowStateNow(window);
  }, 500);
  windowStateSaveTimer.unref?.();
}

async function restoreMainWindowBoundsAfterOnboarding(): Promise<void> {
  const window = mainWindow;
  if (!mainWindowUsesOnboardingBounds || !window || window.isDestroyed()) {
    return;
  }
  suppressWindowStateSave = true;
  try {
    let windowState: WindowState | undefined;
    try {
      windowState = await settingsService.getWindowState();
    } catch (error) {
      console.warn("Failed to read app window state after onboarding", error);
    }
    if (window.isDestroyed() || mainWindow !== window) {
      return;
    }
    const restoredBounds = resolveWindowBounds(windowState, MAIN_WINDOW_SIZING, true);
    if (window.isMaximized()) {
      window.unmaximize();
    }
    window.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);
    window.setBounds(restoredBounds);
    if (windowState?.isMaximized) {
      window.maximize();
    }
  } finally {
    suppressWindowStateSave = false;
    mainWindowUsesOnboardingBounds = false;
  }
  scheduleWindowStateSave(window);
}

function startBackgroundControllerPolling(): void {
  if (process.platform !== "win32") return;
  if (controllerPollingStarted) return;
  controllerPollingStarted = true;

  let focusComboPressedPrev = false;
  let polling = false;
  const COMBO_BUTTONS = [8, 9];

  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const win = mainWindow;
      if (!win || win.isDestroyed() || win.isFocused()) {
        focusComboPressedPrev = false;
        return;
      }
      const settings = await settingsService.get();
      if (settings.controller?.enabled === false || settings.controller?.backgroundInput === false) return;

      const { connected, pressed } = await nativeBridge.pollGamepad();
      if (!connected) { focusComboPressedPrev = false; return; }

      const pressedSet = new Set(pressed);
      const comboActive = COMBO_BUTTONS.every((b) => pressedSet.has(b));
      if (comboActive && !focusComboPressedPrev) {
        if (startupRevealPending()) {
          focusComboPressedPrev = comboActive;
          return;
        }
        if (!win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          if (!win.isVisible()) win.show();
          win.focus();
          win.webContents.send("controller:bg-bp-combo");
        }
      }
      focusComboPressedPrev = comboActive;
    } catch {
      // ignore
    } finally {
      polling = false;
    }
  };

  const intervalId = setInterval(() => { void poll(); }, 100);
  (intervalId as NodeJS.Timeout).unref?.();
}

function startSpotlightHotkeyCapture(sender: Electron.WebContents): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || sender.id !== mainWindow.webContents.id) {
    return false;
  }
  spotlightHotkeyCaptureSenderId = sender.id;
  spotlightHotkeyCaptureCompleted = false;
  return true;
}

function stopSpotlightHotkeyCapture(sender?: Electron.WebContents): void {
  if (sender && spotlightHotkeyCaptureSenderId !== sender.id) {
    return;
  }
  spotlightHotkeyCaptureSenderId = undefined;
  spotlightHotkeyCaptureCompleted = false;
}

function handleSpotlightHotkeyCaptureInput(sender: Electron.WebContents, event: Electron.Event, input: Electron.Input): void {
  if (spotlightHotkeyCaptureSenderId !== sender.id) {
    return;
  }
  event.preventDefault();

  if (input.type === "keyUp") {
    if (spotlightHotkeyCaptureCompleted && !input.control && !input.alt && !input.shift && !input.meta) {
      stopSpotlightHotkeyCapture(sender);
    }
    return;
  }
  if (input.type !== "keyDown" || input.isAutoRepeat || spotlightHotkeyCaptureCompleted) {
    return;
  }
  if (input.key === "Escape") {
    spotlightHotkeyCaptureCompleted = true;
    sender.send("spotlight:hotkey-capture-result", undefined);
    return;
  }
  const accelerator = acceleratorFromHotkeyInput({
    key: input.key,
    code: input.code,
    control: input.control,
    alt: input.alt,
    shift: input.shift,
    meta: input.meta
  });
  if (!accelerator) {
    return;
  }
  spotlightHotkeyCaptureCompleted = true;
  sender.send("spotlight:hotkey-capture-result", accelerator);
}

function createWindow(windowState: WindowState | undefined, options: { showWhenReady?: boolean; focusWhenReady?: boolean; onboarding?: boolean } = {}): void {
  const sizing = options.onboarding ? ONBOARDING_WINDOW_SIZING : MAIN_WINDOW_SIZING;
  const restoredBounds = resolveWindowBounds(windowState, sizing, !options.onboarding);
  mainWindowUsesOnboardingBounds = options.onboarding === true;
  profile("window:create:start", "Creating BrowserWindow");
  mainWindow = new BrowserWindow({
    ...restoredBounds,
    minWidth: sizing.minWidth,
    minHeight: sizing.minHeight,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#09080d",
    icon: windowIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });
  pendingMainWindowMaximize = !options.onboarding && windowState?.isMaximized === true;
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
    if (options.showWhenReady) {
      mainWindow?.show();
    }
    if (options.focusWhenReady) {
      mainWindow?.focus();
    }
  });

  mainWindow.webContents.on("dom-ready", () => {
    profile("renderer:dom-ready", "Renderer DOM ready");
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      handleSpotlightHotkeyCaptureInput(mainWindow.webContents, event, input);
    }
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

  mainWindow.on("move", () => scheduleWindowStateSave());
  mainWindow.on("resize", () => scheduleWindowStateSave());
  mainWindow.on("maximize", () => {
    mainWindow?.webContents.send("window:maximizeChanged", true);
    saveWindowStateNow();
  });
  mainWindow.on("unmaximize", () => {
    mainWindow?.webContents.send("window:maximizeChanged", false);
    saveWindowStateNow();
  });
  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("window:fullScreenChanged", true);
  });
  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("window:fullScreenChanged", false);
  });
  mainWindow.on("close", (event) => {
    saveWindowStateNow();
    if (isQuitting) {
      return;
    }
    if (onboardingPreview) {
      isQuitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    void settingsService.get().then((settings) => {
      if (settings.closeToTray === false) {
        isQuitting = true;
        app.quit();
        return;
      }
      profile("window:close-to-tray", "Destroying renderer and keeping tray background alive");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
      backgroundService?.start("tray");
    }).catch((error) => {
      console.warn("Failed to read close-to-tray setting", error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
      backgroundService?.start("tray");
    });
  });
  mainWindow.on("closed", () => {
    profile("window:closed", "BrowserWindow closed");
    stopSpotlightHotkeyCapture();
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

function createSpotlightWindow(): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const width = 860;
  const height = 600;
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + Math.max(24, (display.workArea.height - height) * 0.28));

  spotlightWindow = new BrowserWindow({
    width,
    height,
    minWidth: 660,
    minHeight: 400,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon: windowIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void spotlightWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/spotlight.html`);
  } else {
    void spotlightWindow.loadFile(join(__dirname, "../renderer/spotlight.html"));
  }

  spotlightWindow.on("blur", () => {
    if (spotlightLaunchHandoffActive) {
      spotlightLaunchHandoffActive = false;
      spotlightWindow?.webContents.send("spotlight:launch-handoff-blur");
      spotlightWindow?.hide();
      return;
    }
    spotlightWindow?.hide();
  });
  spotlightWindow.on("closed", () => {
    spotlightWindow = undefined;
  });
}

function showSpotlightWindow(): void {
  if (!spotlightWindow || spotlightWindow.isDestroyed()) {
    createSpotlightWindow();
  }
  const win = spotlightWindow;
  if (!win || win.isDestroyed()) return;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const bounds = win.getBounds();
  win.setBounds({
    ...bounds,
    x: Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2),
    y: Math.round(display.workArea.y + Math.max(24, (display.workArea.height - bounds.height) * 0.28))
  });
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("spotlight:show");
}

function hideSpotlightWindow(): void {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    spotlightWindow.webContents.send("spotlight:hide-notify");
    spotlightWindow.hide();
  }
}

function toggleSpotlightWindow(): void {
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    hideSpotlightWindow();
    return;
  }
  showSpotlightWindow();
}

function applySpotlightSettings(settings: AppSettings): SpotlightState {
  if (registeredSpotlightHotkey) {
    globalShortcut.unregister(registeredSpotlightHotkey);
    registeredSpotlightHotkey = undefined;
  }
  const configured = settings.spotlight ?? { enabled: true, hotkey: "Alt+Space" };
  spotlightState = {
    enabled: configured.enabled !== false,
    hotkey: configured.hotkey,
    registered: false
  };
  if (!spotlightState.enabled) {
    return spotlightState;
  }
  if (onboardingPreview) {
    spotlightState = { ...spotlightState, registered: false, registrationError: "Disabled in onboarding preview." };
    return spotlightState;
  }
  try {
    const registered = globalShortcut.register(spotlightState.hotkey, toggleSpotlightWindow);
    spotlightState = {
      ...spotlightState,
      registered,
      registrationError: registered ? undefined : "Hotkey is already in use by another app."
    };
    if (registered) {
      registeredSpotlightHotkey = spotlightState.hotkey;
    }
  } catch (error) {
    spotlightState = {
      ...spotlightState,
      registered: false,
      registrationError: error instanceof Error ? error.message : String(error)
    };
  }
  return spotlightState;
}

async function queueMainWindowAction(action: SpotlightPendingAction): Promise<void> {
  pendingSpotlightAction = action;
  await showMainWindow({ withSplash: false, focus: true });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("spotlight:pending-action", action);
  }
}

function startupRevealPending(): boolean {
  return Boolean(startupReadyTimeout || splashWindow || revealMainWindowInProgress);
}

function revealMainWindow(focus: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    if (pendingMainWindowMaximize && !mainWindow.isMaximized()) {
      mainWindow.maximize();
    }
    pendingMainWindowMaximize = false;
    mainWindow.show();
  }
  if (focus) {
    mainWindow.focus();
  }
}

function dismissSplash(focus = pendingMainWindowFocus): void {
  if (startupReadyTimeout) {
    clearTimeout(startupReadyTimeout);
    startupReadyTimeout = undefined;
  }

  pendingMainWindowFocus = pendingMainWindowFocus || focus;
  if (revealMainWindowInProgress) {
    return;
  }
  revealMainWindowInProgress = true;

  const finishReveal = () => {
    revealMainWindowInProgress = false;
    const shouldFocus = pendingMainWindowFocus;
    pendingMainWindowFocus = false;
    revealMainWindow(shouldFocus);
  };

  const splash = splashWindow;
  if (!splash || splash.isDestroyed()) {
    finishReveal();
    return;
  }

  void splash.webContents.executeJavaScript("document.body.classList.add('dismiss')").catch(() => undefined);
  setTimeout(() => {
    if (splash.isDestroyed()) {
      finishReveal();
      return;
    }
    splash.once("closed", finishReveal);
    splash.close();
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

function isBackgroundLaunch(argv = process.argv): boolean {
  return argv.includes(BACKGROUND_ARG);
}

function applyLoginItemSettings(settings: AppSettings): void {
  if (onboardingPreview) {
    profile("login-item:skipped", "Login item registration skipped in onboarding preview");
    return;
  }
  if (process.platform !== "win32" || !app.isPackaged) {
    profile("login-item:skipped", "Login item registration skipped outside packaged Windows", {
      startWithWindows: settings.startWithWindows !== false,
      platform: process.platform,
      packaged: app.isPackaged
    });
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: settings.startWithWindows !== false,
      args: [BACKGROUND_ARG]
    });
    profile("login-item:updated", "Login item registration updated", { startWithWindows: settings.startWithWindows !== false });
  } catch (error) {
    console.warn("Failed to update login item settings", error);
  }
}

function requestMainWindowClose(): void {
  if (onboardingPreview) {
    isQuitting = true;
    app.quit();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    backgroundService?.start("tray");
    return;
  }
  mainWindow.close();
}

function rebuildTrayMenu(settings: AppSettings): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Open Hynite",
      click: () => void showMainWindow({ withSplash: true, focus: true })
    },
    {
      label: "Sync Steam Now",
      click: () => void backgroundService?.runSteamSyncNow("tray").catch((error) => {
        console.warn("Tray Steam sync failed", error);
      })
    },
    { type: "separator" },
    {
      label: "Background updates",
      type: "checkbox",
      checked: settings.backgroundUpdatesEnabled !== false,
      click: (item) => void settingsService.update({ backgroundUpdatesEnabled: item.checked }).then(onSettingsChanged).catch(console.error)
    },
    {
      label: "Track local playtime",
      type: "checkbox",
      checked: settings.backgroundPlaytimeTracking !== false,
      click: (item) => void settingsService.update({ backgroundPlaytimeTracking: item.checked }).then(onSettingsChanged).catch(console.error)
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: settings.startWithWindows !== false,
      click: (item) => void settingsService.update({ startWithWindows: item.checked }).then(onSettingsChanged).catch(console.error)
    },
    { type: "separator" },
    {
      label: "Quit Hynite",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

async function ensureTray(): Promise<void> {
  if (tray) return;
  try {
    const icon = nativeImage.createFromPath(windowIconPath);
    tray = new Tray(icon);
    tray.setToolTip("Hynite");
    tray.on("click", () => void showMainWindow({ withSplash: true, focus: true }));
    tray.on("double-click", () => void showMainWindow({ withSplash: true, focus: true }));
    rebuildTrayMenu(await settingsService.get());
  } catch (error) {
    console.warn("Failed to create tray", error);
  }
}

async function onSettingsChanged(settings: AppSettings): Promise<AppSettings> {
  setObservabilityEnabled(settings.crashReportingEnabled !== false);
  applyLoginItemSettings(settings);
  applySpotlightSettings(settings);
  rebuildTrayMenu(settings);
  void settingsService?.createPeriodicBackupIfDue().catch((error: unknown) => {
    console.warn("Failed to create periodic settings backup", error);
  });
  if (!onboardingPreview) {
    await backgroundService?.refreshSettings();
  }
  return settings;
}

function startSettingsBackupTimer(): void {
  if (onboardingPreview || settingsBackupTimer) return;
  void settingsService.createPeriodicBackupIfDue().catch((error: unknown) => {
    console.warn("Failed to create startup settings backup", error);
  });
  settingsBackupTimer = setInterval(() => {
    void settingsService.createPeriodicBackupIfDue().catch((error: unknown) => {
      console.warn("Failed to create periodic settings backup", error);
    });
  }, 60 * 60 * 1000);
  settingsBackupTimer.unref?.();
}

async function showMainWindow(options: { withSplash: boolean; focus: boolean }): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    pendingMainWindowFocus = pendingMainWindowFocus || options.focus;
    if (startupRevealPending()) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      }
      profile("window:show:deferred", "Main window show deferred until startup reveal completes", {
        withSplash: options.withSplash,
        hasSplash: Boolean(splashWindow),
        timeoutPending: Boolean(startupReadyTimeout)
      });
    } else {
      revealMainWindow(options.focus);
    }
    if (!onboardingPreview) {
      backgroundService?.start("foreground");
    }
    return;
  }

  const [windowState, onboardingState] = await Promise.all([
    settingsService.getWindowState(),
    getOnboardingState()
  ]);
  startupReadyHandled = false;
  pendingMainWindowFocus = options.focus;
  createWindow(windowState, {
    showWhenReady: false,
    focusWhenReady: false,
    onboarding: onboardingState.shouldShow
  });
  if (!onboardingPreview) {
    backgroundService?.start("foreground");
    startSystemAudioMonitor();
    startBackgroundControllerPolling();
  }

  if (options.withSplash) {
    createSplashWindow();
  }
  startupReadyTimeout = setTimeout(() => {
    profile("startup:ready-timeout", "Startup ready timeout - revealing main window", {
      withSplash: options.withSplash,
      hasSplash: Boolean(splashWindow)
    });
    dismissSplash(options.focus);
  }, 30_000);
  startupReadyTimeout.unref?.();
}

function scheduleForegroundStartupBackgroundWork(): void {
  if (onboardingPreview) {
    return;
  }
  if (foregroundStartupBackgroundWorkScheduled) {
    return;
  }
  foregroundStartupBackgroundWorkScheduled = true;

  void settingsService.get().then((settings) => {
    const hasSteamAccounts = settings.steamAccounts.length > 0;
    const canSync = Boolean(settings.steamWebApiKey) && hasSteamAccounts;
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
        void runLocalScan({ skipUnchanged: true, refreshMetadata: true }).catch((error: unknown) => {
          console.warn("Startup local scan failed", error);
        });
      }, STARTUP_LOCAL_SCAN_DELAY_MS).unref?.();
    };

    runAfterInitialRendererPaint(() => {
      profile("startup:background:start", "Startup background work started");
      void syncLocalLastPlayedFromPrefetch(repository, nativeBridge).catch((error: unknown) => {
        console.warn("Prefetch last-played sync failed", error);
      });
      if (canSync) {
        void startSteamSync("steam", {
          refreshStaleMetadata: false,
          replaceActive: false,
          richBackfillLimit: false
        }).catch((error: unknown) => {
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

      if (hasSteamAccounts) {
        void steamWishlistService.sync({ refreshStaleMetadata: false }).catch((error: unknown) => {
          console.warn("Startup Steam wishlist sync failed", error);
        });
      }
      profile("startup:background:rich-backfill", "Queueing rich metadata without startup Steam sync");
      enqueueRichMetadataBackfill();
      runStartupLocalScan();
    });
  });
}

async function startSteamSync(providerId?: ProviderId, options: { refreshStaleMetadata?: boolean; replaceActive?: boolean; richBackfillLimit?: number | false } = {}): Promise<SyncResult> {
  if (providerId && providerId !== "steam") {
    throw new Error(`Provider ${providerId} is not implemented yet.`);
  }

  profile("steam-sync:start-requested", "Steam sync start requested", {
    providerId,
    refreshStaleMetadata: options.refreshStaleMetadata,
    replaceActive: options.replaceActive !== false
  });
  const started = await withSteamSyncStartLock(async () => {
    if (activeSteamSync) {
      if (options.replaceActive === false) {
        profile("steam-sync:already-active", "Steam sync request joined active sync", { providerId });
        return { promise: activeSteamSync.promise };
      }
      await cancelActiveSteamSync("Steam sync replaced by a newer request");
    }
    const controller = new AbortController();
    const promise = syncSteamLibrary(providerId, { ...options, signal: controller.signal }).then((result) => {
      spotlightService?.refresh();
      return result;
    }).finally(() => {
      if (activeSteamSync?.promise === promise) {
        activeSteamSync = undefined;
      }
    });
    activeSteamSync = { controller, promise };
    return { promise };
  });
  return started.promise;
}

async function syncSteamLibrary(providerId?: ProviderId, options: { refreshStaleMetadata?: boolean; signal?: AbortSignal; richBackfillLimit?: number | false } = {}) {
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
    let wishlistResult: SyncResult | undefined;
    if (settings.steamAccounts.length > 0) {
      try {
        wishlistResult = await steamWishlistService.sync({ refreshStaleMetadata: options.refreshStaleMetadata ?? true, signal: options.signal });
      } catch (error) {
        syncStatusService.log("warning", "steam:wishlist", "Steam wishlist sync failed; preserving cached wishlist rows.", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    syncStatusService.finish(
      webApiKey
        ? `Steam sync skipped: no paired accounts${wishlistResult ? `, ${wishlistResult.upserted} wishlist items` : ""}`
        : `Steam sync skipped: add a Steam Web API key in Settings${wishlistResult ? `, ${wishlistResult.upserted} wishlist items` : ""}`
    );
    runSpan.end("ok", { syncRunId, scanned: 0, upserted: 0, installed: 0, wishlistUpserted: wishlistResult?.upserted ?? 0, skipped: true, refreshStaleMetadata: options.refreshStaleMetadata });
    void startupProfileService?.writeReport();
    return { providerId: "steam" as const, scanned: wishlistResult?.scanned ?? 0, upserted: wishlistResult?.upserted ?? 0, warnings: wishlistResult?.warnings ?? [] };
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
    if (options.richBackfillLimit !== false) {
      enqueueRichMetadataBackfill(typeof options.richBackfillLimit === "number" ? options.richBackfillLimit : undefined);
      richBackfillSpan.end("ok", { syncRunId, limit: options.richBackfillLimit ?? "all" });
    } else {
      richBackfillSpan.end("ok", { syncRunId, skipped: true });
    }
    throwIfSteamSyncCancelled(options.signal);
    let wishlistUpserted = 0;
    try {
      const wishlistResult = await steamWishlistService.sync({ refreshStaleMetadata, signal: options.signal });
      wishlistUpserted = wishlistResult.upserted;
      warnings.push(...wishlistResult.warnings);
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      const message = "Steam wishlist sync failed; preserving cached wishlist rows.";
      warnings.push(message);
      syncStatusService.log("warning", "steam:wishlist", message, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    throwIfSteamSyncCancelled(options.signal);
    syncStatusService.finish(`Steam sync complete: ${upserted} games, ${installedApps.size} local installs, ${wishlistUpserted} wishlist items`);
    profile("steam-sync:end", "Steam sync completed", {
      syncRunId,
      scanned: imported.length,
      upserted,
      installed: installedApps.size,
      wishlistUpserted,
      durationMs: roundDuration(syncStartedAt)
    });
    runSpan.end("ok", {
      syncRunId,
      scanned: imported.length,
      upserted,
      installed: installedApps.size,
      wishlistUpserted,
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

async function runLocalScan(options: { skipUnchanged?: boolean; refreshMetadata?: boolean } = {}): Promise<{ scanned: number; skipped: number; matched: number; ambiguous: number; unmatched: number; issues: LocalScanIssue[] } | undefined> {
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
      skipUnchanged: options.skipUnchanged,
      refreshMetadata: options.refreshMetadata,
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
      spotlightService?.refresh();
      span.end("ok", { rootCount: roots.length });
    });

  activeLocalScan = { promise, controller };
  return promise;
}

function registerIpc(): void {
  ipcMain.on("startup:ready", (_event, input?: { mode?: "app" | "onboarding" }) => {
    profile("startup:ready", "Renderer signaled startup ready");
    if (!startupReadyHandled) {
      startupReadyHandled = true;
      dismissSplash();
    }
    if (input?.mode === "app") {
      void restoreMainWindowBoundsAfterOnboarding();
      scheduleForegroundStartupBackgroundWork();
    }
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
    if (onboardingPreview) {
      return { providerId: "steam" as const, scanned: 0, upserted: 0, warnings: ["Onboarding preview did not run Steam sync."] };
    }
    return startSteamSync(providerId, { refreshStaleMetadata: true });
  });

  handleIpc("local:scan", async () => {
    if (onboardingPreview) {
      return { scanned: 0, skipped: 0, matched: 0, ambiguous: 0, unmatched: 0, issues: [] };
    }
    const result = await runLocalScan();
    const settings = await settingsService.get();
    const issues = await getLocalIssues(settings);
    return result ? { ...result, issues } : { scanned: 0, skipped: 0, matched: 0, ambiguous: 0, unmatched: 0, issues };
  });
  handleIpc("local:get-issues", async () => {
    const settings = await settingsService.get();
    return getLocalIssues(settings);
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
    if (onboardingPreview) {
      return settingsService.get();
    }
    return settingsService.update({ localIgnoredPaths: paths });
  });
  handleIpc("local:ignore-folder", async (_event, folderPath: string) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    const current = await settingsService.get();
    const ignored = new Set(current.localIgnoredPaths ?? []);
    ignored.add(folderPath);
    const issues = await localImportService.getIssues(current.localIgnoredPaths ?? []);
    const issue = issues.find((entry) => entry.folderPath === folderPath);
    if (issue) {
      await localImportService.clearIssue(issue.candidateId);
    }
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
    if (onboardingPreview) {
      return { removed: 0 };
    }
    const removed = repository.removeLocalGamesUnder(folderPath);
    spotlightService.refresh();
    return { removed };
  });
  handleIpc("local:remove-all", () => {
    if (onboardingPreview) {
      return { removed: 0 };
    }
    const removed = repository.removeAllLocalGames();
    spotlightService.refresh();
    return { removed };
  });
  handleIpc("local:remove-and-ignore", async (_event, args: { gameId: string; folderPath?: string }) => {
    if (onboardingPreview) {
      return { ok: true };
    }
    repository.removeGame(args.gameId);
    spotlightService.refresh();
    await localImportService.clearIssue(args.gameId);
    if (args.folderPath) {
      const current = await settingsService.get();
      const ignored = new Set(current.localIgnoredPaths ?? []);
      ignored.add(args.folderPath);
      await settingsService.update({ localIgnoredPaths: [...ignored] });
    }
    return { ok: true };
  });
  handleIpc("local:remove-game", async (_event, gameId: string) => {
    if (onboardingPreview) {
      return { ok: true };
    }
    const game = repository.getGame(gameId);
    if (!game) {
      return { ok: true };
    }
    if (!isLocalGame(game)) {
      throw new Error("Only local games can be deleted from this menu.");
    }
    repository.removeGame(gameId);
    spotlightService.refresh();
    await localImportService.clearIssue(gameId);
    return { ok: true };
  });
  handleIpc("local:update-location", async (_event, args: { gameId: string; folderPath: string }) => {
    if (onboardingPreview) {
      return { ok: true, executablePath: "C:\\Games\\Preview\\Preview.exe" };
    }
    const game = repository.getGame(args.gameId);
    if (!game) {
      throw new Error("Local game not found.");
    }
    if (!isLocalGame(game)) {
      throw new Error("Only local games can be moved.");
    }
    const probe = await localImportService.probe(
      { folderPath: args.folderPath },
      {
        log: (level, message, details) => {
          diagnosticLogService.log({ level, phase: "local:update-location", message, details });
          syncStatusService.log(level, "local:update-location", message, details);
        }
      }
    );
    repository.updateLocalGameLocation({
      gameId: args.gameId,
      externalId: hashFolderPath(probe.folderPath),
      installDirectory: probe.folderPath,
      executablePath: probe.chosenExe
    });
    spotlightService.refresh();
    const report = localImportService.lastReport;
    if (report) {
      report.issues = report.issues.filter((issue) => issue.candidateId !== args.gameId);
    }
    await localImportService.clearIssue(args.gameId);
    return { ok: true, executablePath: probe.chosenExe };
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
    if (onboardingPreview) {
      return {
        gameId: "local:preview",
        candidateId: "preview",
        title: args.titleOverride ?? "Preview Game",
        chosenExe: args.executablePath ?? "C:\\Games\\Preview\\Preview.exe",
        identification: { kind: "unmatched" as const, reason: "preview" }
      };
    }
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
    if (report) {
      report.issues = report.issues.filter((issue) => issue.candidateId !== result.candidateId);
    }
    await localImportService.clearIssue(result.candidateId);
    spotlightService.refresh();
    return result;
  });
  handleIpc("local:repair-library", () => {
    if (onboardingPreview) {
      return { deleted: 0 };
    }
    const deleted = repository.repairPhantomLocalGames();
    spotlightService.refresh();
    return deleted;
  });
  handleIpc("local:resolve-ambiguous", async (
    _event,
    args: { candidateId: string; chosen: { provider: "steam" | "igdb"; externalId: string; title: string } | null }
  ) => {
    if (onboardingPreview) {
      return { ok: true };
    }
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
    spotlightService.refresh();
    // Remove the resolved issue from the in-memory scan report so the UI updates.
    const report = localImportService.lastReport;
    if (report) {
      report.issues = report.issues.filter((issue) => issue.candidateId !== args.candidateId);
    }
    await localImportService.clearIssue(args.candidateId);
    return { ok: true };
  });
  handleIpc("games:set-launch-exe", (_event, args: { gameId: string; executablePath: string }) => {
    if (onboardingPreview) {
      return { ok: true };
    }
    repository.setExecutablePath(args.gameId, args.executablePath);
    spotlightService.refresh();
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
    if (onboardingPreview) {
      return settingsService.get();
    }
    return settingsService.update({ localRoots: roots });
  });
  handleIpc("local:set-exclude-patterns", async (_event, patterns: string[]) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    return settingsService.update({ localExcludePatterns: patterns });
  });
  handleIpc("metadata:save-igdb-credentials", async (_event, args: { clientId: string; clientSecret: string }) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    const clientId = await nativeBridge.encryptSecret({ value: args.clientId, scope: "current-user" });
    const clientSecret = await nativeBridge.encryptSecret({ value: args.clientSecret, scope: "current-user" });
    return settingsService.update({ igdb: { clientId, clientSecret } });
  });
  handleIpc("metadata:clear-igdb-credentials", async () => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    return settingsService.update({ igdb: undefined });
  });

  handleIpc("library:list", (_event, query: LibraryQuery = {}) => repository.queryGames(query));
  handleIpc("wishlist:list", (_event, query: WishlistListQuery = {}) => {
    const span = profileSpan("wishlist", "wishlist:list", {
      searchLength: query.search?.trim().length ?? 0,
      sourceAvailability: query.sourceAvailability ?? "all",
      sort: query.sort ?? "title",
      sortDirection: query.sortDirection ?? "asc",
      accountFilters: query.accountSteamIds?.length ?? 0
    });
    const items = steamWishlistService.list(query);
    span.end("ok", {
      items: items.length,
      withSourceMatches: items.filter((item) => item.sourceMatches.length > 0).length,
      withExactRelease: items.filter((item) => Boolean(item.releaseDate)).length,
      withCover: items.filter((item) => Boolean(item.coverUrl ?? item.libraryCapsuleUrl)).length,
      withLogo: items.filter((item) => Boolean(item.logoUrl)).length
    });
    return items;
  });
  handleIpc("wishlist:count", () => {
    const span = profileSpan("wishlist", "wishlist:count");
    const count = steamWishlistService.count();
    span.end("ok", { count });
    return count;
  });
  handleIpc("wishlist:calendar", (_event, query: WishlistCalendarQuery) => {
    const span = profileSpan("wishlist", "wishlist:calendar", {
      startDate: query.startDate,
      months: query.months,
      accountFilters: query.accountSteamIds?.length ?? 0
    });
    const items = steamWishlistService.calendar(query);
    span.end("ok", {
      items: items.length,
      withSourceMatches: items.filter((item) => item.sourceMatches.length > 0).length,
      withCover: items.filter((item) => Boolean(item.coverUrl ?? item.libraryCapsuleUrl)).length,
      withLogo: items.filter((item) => Boolean(item.logoUrl)).length
    });
    return items;
  });
  handleIpc("wishlist:refresh", async () => {
    if (onboardingPreview) {
      return { providerId: "steam" as const, scanned: 0, upserted: 0, warnings: ["Onboarding preview did not run Steam wishlist sync."] };
    }
    return steamWishlistService.sync({ refreshStaleMetadata: true });
  });
  handleIpc("library:clear", async () => {
    if (onboardingPreview) {
      return { cleared: 0 };
    }
    await withSteamSyncStartLock(() => cancelActiveSteamSync("Steam sync cancelled before clearing the library"));
    clearRichMetadataQueue("Detail metadata cancelled before clearing the library");
    const cleared = repository.clearLibrary();
    spotlightService.refresh();
    await homeService.clearCache();
    return { cleared };
  });

  handleIpc("games:get", (_event, id: string) => {
    const detailSpan = profileSpan("ipc", "detail:get", { gameId: id });
    const dbSpan = profileSpan("sqlite", "detail:get:db-read", { gameId: id });
    const game = repository.getGame(id);
    dbSpan.end(game ? "ok" : "error", {
      gameId: id,
      title: game?.title,
      hasRichDetail: game ? hasRichDetailMetadata(game) : false,
      screenshots: game?.screenshots.length ?? 0
    });
    if (!game) {
      detailSpan.end("error", { gameId: id, error: "not-found" });
      throw new Error(`Game ${id} was not found.`);
    }
    const queueSpan = profileSpan("metadata", "detail:get:rich-queue", { gameId: id, title: game.title });
    enqueueRichMetadata(game, true);
    queueSpan.end("ok", { gameId: id, title: game.title, alreadyRich: hasRichDetailMetadata(game) });
    detailSpan.end("ok", {
      gameId: id,
      title: game.title,
      hasRichDetail: hasRichDetailMetadata(game),
      screenshots: game.screenshots.length,
      sourceMatchesDeferred: true
    });
    return { ...game, sourceMatches: [] };
  });

  handleIpc("games:get-asset-candidates", async (_event, id: string) => {
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    return getAssetCandidates(game);
  });

  handleIpc("games:update-assets", async (_event, id: string, update: GameAssetUpdate) => {
    if (onboardingPreview) {
      const game = repository.getGame(id);
      if (!game) {
        throw new Error(`Game ${id} was not found.`);
      }
      return { ...game, sourceMatches: [] };
    }
    const game = repository.getGame(id);
    if (!game) {
      throw new Error(`Game ${id} was not found.`);
    }
    const nextTitle = typeof update.title === "string" ? update.title.trim() : undefined;
    if (update.title !== undefined && !nextTitle) {
      throw new Error("Game title cannot be empty.");
    }
    if (nextTitle && nextTitle !== game.title) {
      repository.applyMetadata(id, { title: nextTitle });
    }
    const hasAssetUpdate = ["grid", "hero", "logo", "icon", "header", "poster"].some((kind) =>
      Object.prototype.hasOwnProperty.call(update, kind)
    );
    if (hasAssetUpdate) {
      const cachedPatch = await cacheMetadataAssets(assetUpdateToPatch(update), true);
      repository.updateGameAssets(id, patchToAssetUpdate(cachedPatch, update));
    }
    spotlightService.refresh();
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
    return { ...hydrated, sourceMatches: [] };
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
    if (onboardingPreview) {
      return settingsService.get();
    }
    const trimmed = localUsername?.trim();
    return settingsService.patchSteamAccount(steamId, { localUsername: trimmed ? trimmed : undefined });
  });
  handleIpc("steam:setPreferredLaunchAccount", async (_event, gameId: string, steamId: string | undefined) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    const trimmed = steamId?.trim();
    return settingsService.setLaunchAccountPreference(gameId, trimmed ? trimmed : undefined);
  });
  handleIpc("steam:removeAccount", async (_event, steamId: string) => onboardingPreview ? settingsService.get() : settingsService.removeSteamAccount(steamId));
  handleIpc("steam:storeEmbed", async (): Promise<SteamStoreEmbedInfo> => {
    const settings = await settingsService.get();
    const account = firstPairedSteamAccount(settings.steamAccounts);
    if (!account) {
      return {
        available: false,
        url: STEAM_STORE_HOME_URL,
        reason: "no-account"
      };
    }

    const loggedIn = await isSteamStoreSessionLoggedIn(account.steamId).catch(() => false);
    return {
      available: true,
      url: STEAM_STORE_HOME_URL,
      partition: steamFamilySessionPartition(account.steamId),
      loggedIn,
      account: {
        steamId: account.steamId,
        personaName: account.personaName,
        hasFamilySession: Boolean(account.familySession)
      }
    };
  });
  handleIpc("steam:captureStoreSession", async (): Promise<AppSettings | undefined> => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    const current = await settingsService.get();
    const account = firstPairedSteamAccount(current.steamAccounts);
    if (!account) {
      return undefined;
    }
    const refreshed = await refreshSteamAccessToken(account.steamId);
    if (!refreshed || refreshed.steamId !== account.steamId) {
      return undefined;
    }
    const encrypted = await nativeBridge.encryptSecret({ value: refreshed.accessToken, scope: "current-user" });
    return settingsService.patchSteamAccount(account.steamId, {
      familySession: {
        accessToken: encrypted,
        steamId: refreshed.steamId,
        expiresAt: refreshed.expiresAt,
        connectedAt: account.familySession?.connectedAt ?? new Date().toISOString()
      }
    });
  });

  handleIpc("home:get", async () => {
    const settings = await settingsService.get();
    const steamGridDbApiKey = settings.steamGridDbApiKey ? await nativeBridge.decryptSecret(settings.steamGridDbApiKey) : undefined;
    return homeService.get(repository.listGames(), { steamGridDbApiKey, steamAppInfoProvider: fetchNativeSteamAppInfoMetadata });
  });
  handleIpc("onboarding:state", () => getOnboardingState());
  handleIpc("onboarding:complete", (_event, input?: { skipped?: boolean }) => completeOnboarding(input));
  handleIpc("sync:status", () => syncStatusService.get());
  handleIpc("updater:status", () => updaterService.get());
  handleIpc("updater:check", () => updaterService.check());
  handleIpc("updater:download", () => updaterService.download());
  handleIpc("updater:install", () => updaterService.install());
  handleIpc("sources:import", (_event, input: SourceImportInput) => {
    if (onboardingPreview) {
      return {
        sourceId: "preview-source",
        name: "Preview source",
        importedEntries: 24,
        skippedEntries: 0
      };
    }
    return sourceService.import(input);
  });
  handleIpc("sources:list", () => sourceService.list());
  handleIpc("sources:remove", (_event, id: string) => {
    if (onboardingPreview) {
      return undefined;
    }
    return sourceService.remove(id);
  });
  handleIpc("sources:refreshSource", (_event, id: string, json: string) => {
    if (onboardingPreview) {
      return { sourceId: id, name: "Preview source", importedEntries: 24, skippedEntries: 0 };
    }
    return sourceService.refreshSource(id, json);
  });
  handleIpc("sources:search", (_event, gameId: string, options) => {
    const span = profileSpan("source-search", "sources:search", { gameId });
    const matches = sourceService.search(gameId, options);
    span.end("ok", { gameId, sourceMatches: matches.length });
    return matches;
  });
  handleIpc("sources:searchTitle", (_event, title: string, options) => {
    const span = profileSpan("source-search", "sources:search-title", { title });
    const matches = sourceService.searchTitle(title, options);
    span.end("ok", { title, sourceMatches: matches.length });
    return matches;
  });
  handleIpc("sources:exactTitleMatches", (_event, title: string) => {
    const span = profileSpan("source-search", "sources:exact-title-matches", { title });
    const matches = sourceService.exactTitleMatches(title);
    span.end("ok", { title, sourceMatches: matches.length });
    return matches;
  });
  handleIpc("sources:exactTitleMatchesBatch", (_event, titles: string[]) => {
    const safeTitles = Array.isArray(titles) ? titles : [];
    const span = profileSpan("source-search", "sources:exact-title-matches-batch", { titles: safeTitles.length });
    const results = sourceService.exactTitleMatchesBatch(safeTitles);
    span.end("ok", {
      titles: results.length,
      matchedTitles: results.filter((result) => result.matches.length > 0).length,
      sourceMatches: results.reduce((total, result) => total + result.matches.length, 0)
    });
    return results;
  });
  handleIpc("clipboard:copy", (_event, text: string) => clipboard.writeText(text));
  handleIpc("settings:get", () => settingsService.get());
  handleIpc("settings:list-backups", () => settingsService.listBackups());
  handleIpc("settings:restore-backup", async (_event, id: string) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    return onSettingsChanged(await settingsService.restoreBackup(id));
  });
  handleIpc("settings:health", () => settingsService.detectHealthWarning());
  handleIpc("settings:update", async (_event, patch) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    return onSettingsChanged(await settingsService.update(patch));
  });
  handleIpc("spotlight:state", () => spotlightState);
  handleIpc("spotlight:search", (_event, query: string, options) => {
    const span = profileSpan("spotlight", "spotlight:search", { queryLength: query.trim().length });
    const results = spotlightService.search(query, options);
    span.end("ok", { results: results.length, offset: options?.offset ?? 0, limit: options?.limit });
    return results;
  });
  handleIpc("spotlight:launch", async (_event, gameId: string): Promise<LaunchResult> => {
    const result = await resolveLaunchOrSwitch(gameId);
    if (result.kind === "launched") {
      return result;
    }
    if (result.kind === "requires-switch") {
      hideSpotlightWindow();
      await queueMainWindowAction({ kind: "launch", gameId });
    }
    return result;
  });
  handleIpc("spotlight:open-details", async (_event, gameId: string) => {
    hideSpotlightWindow();
    await queueMainWindowAction({ kind: "details", gameId });
  });
  handleIpc("spotlight:hide", () => hideSpotlightWindow());
  handleIpc("spotlight:set-launch-handoff-active", (_event, active: boolean) => {
    spotlightLaunchHandoffActive = active === true;
  });
  handleIpc("spotlight:hotkey-capture-start", (event) => startSpotlightHotkeyCapture(event.sender));
  handleIpc("spotlight:hotkey-capture-stop", (event) => {
    stopSpotlightHotkeyCapture(event.sender);
  });
  handleIpc("spotlight:consume-pending-action", () => {
    const action = pendingSpotlightAction;
    pendingSpotlightAction = undefined;
    return action;
  });
  handleIpc("steam:pair", async () => {
    if (onboardingPreview) {
      return {
        steamId: "76561198000000000",
        pairedAt: new Date().toISOString()
      };
    }
    const { pairing: paired, familyResult } = await pairSteamAccount(mainWindow);
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

    let autoFamilySession = existing?.familySession;
    if (familyResult) {
      try {
        const encrypted = await nativeBridge.encryptSecret({ value: familyResult.accessToken, scope: "current-user" });
        autoFamilySession = {
          accessToken: encrypted,
          steamId: familyResult.steamId,
          expiresAt: familyResult.expiresAt,
          connectedAt: new Date().toISOString()
        };
      } catch (error) {
        console.warn("[steam:pair] could not encrypt auto-captured family token:", error);
      }
    }

    await settingsService.upsertSteamAccount({
      ...(existing ?? {}),
      steamId: paired.steamId,
      pairedAt: paired.pairedAt,
      personaName: existing?.personaName ?? autoPersonaName,
      localUsername: existing?.localUsername ?? autoLocalUsername,
      ...(autoFamilySession ? { familySession: autoFamilySession } : {})
    });
    return paired;
  });
  handleIpc("steam:saveApiKey", async (_event, apiKey: string) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Steam Web API key is required.");
    }
    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({ steamWebApiKey: encrypted });
  });
  handleIpc("steam:clearApiKey", async () => onboardingPreview ? settingsService.get() : settingsService.update({ steamWebApiKey: undefined }));
  handleIpc("steam:disconnect", async (_event, steamId?: string) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    if (steamId) {
      return settingsService.removeSteamAccount(steamId);
    }
    return settingsService.update({ steamAccounts: [] });
  });
  handleIpc("steam:connectFamily", async (_event, steamId: string) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    const current = await settingsService.get();
    if (!current.steamAccounts.some((account) => account.steamId === steamId)) {
      throw new Error("Pair the Steam account before connecting the family library.");
    }
    const result = await authenticateSteamSession(mainWindow, steamId);
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
    if (onboardingPreview) {
      return settingsService.get();
    }
    const current = await settingsService.get();
    const target = current.steamAccounts.find((account) => account.steamId === steamId);
    if (!target?.familySession) {
      throw new Error("Family library is not connected for this account.");
    }
    const refreshed = await refreshSteamAccessToken(steamId);
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
    if (onboardingPreview) {
      return settingsService.get();
    }
    await disconnectSteamFamilySession(steamId);
    return settingsService.patchSteamAccount(steamId, { familySession: undefined });
  });
  handleIpc("steam:search", async (_event, query: string): Promise<SteamSearchResult[]> => {
    return searchSteamStore(query, net.fetch);
  });
  handleIpc("metadata:saveSteamGridDbKey", async (_event, apiKey: string) => {
    if (onboardingPreview) {
      return settingsService.get();
    }
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("SteamGridDB API key is required.");
    }

    const encrypted = await nativeBridge.encryptSecret({ value: trimmed, scope: "current-user" });
    return settingsService.update({ steamGridDbApiKey: encrypted });
  });
  handleIpc("metadata:clearSteamGridDbKey", async () => onboardingPreview ? settingsService.get() : settingsService.update({ steamGridDbApiKey: undefined }));
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
  handleIpc("window:setFullScreen", (_event, fullscreen: boolean) => {
    if (!mainWindow) return;
    if (mainWindow.isFullScreen() === fullscreen) return;
    mainWindow.setFullScreen(fullscreen);
  });
  handleIpc("window:isFullScreen", () => mainWindow?.isFullScreen() ?? false);
  handleIpc("window:focusBigPicture", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (startupRevealPending()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
  handleIpc("music:system-audio-active", () => onboardingPreview ? false : getSystemAudioActive());
  handleIpc("music:system-audio-debug", async () => {
    if (onboardingPreview) return "onboarding preview";
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
    if (onboardingPreview) {
      throw new Error("Debug seed is disabled in onboarding preview.");
    }
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
  handleIpc("debug:reset-everything", () => resetEverythingAndRelaunch());
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  startupProfileService = new StartupProfileService(userData, app.getVersion());
  profile("app:ready", "Electron app ready", {
    userData,
    onboardingPreview,
    profileCommand: startupProfileService.enabled,
    versions: process.versions
  });
  startStartupHeartbeat();
  repository = new HyniteRepository(onboardingPreview ? ":memory:" : join(userData, "hynite.db"));
  profile("services:repository", "Repository opened");
  if (!onboardingPreview) {
    void backfillLocalAddedAt(repository);
  }
  const audioAssetsRoot = app.isPackaged
    ? join(process.resourcesPath, "audio")
    : join(__dirname, "../../assets/audio");
  settingsService = new SettingsService(join(userData, "settings.json"), audioAssetsRoot);
  startSettingsBackupTimer();
  // Sentry inits enabled at process start (to catch early crashes); honor the
  // user's opt-out as soon as settings load. Brief startup window may still report.
  void settingsService
    .get()
    .then((settings) => setObservabilityEnabled(settings.crashReportingEnabled !== false))
    .catch(() => undefined);
  diagnosticLogService = new DiagnosticLogService(transientUserDataPath(userData, "metadata-diagnostics.ndjson"));
  homeService = new HomeService(transientUserDataPath(userData, "home-cache.json"), diagnosticLogService, (model) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send("home:updated", model);
  });
  sourceService = new SourceService(repository);
  spotlightService = new SpotlightService(repository);
  spotlightService.refresh();
  assetCacheService = new AssetCacheService(transientUserDataPath(userData, "asset-cache"), startupProfileService);
  assetCacheService.registerProtocol(protocol);
  soundFileService = new SoundFileService(() => settingsService.get());
  soundFileService.registerProtocol(protocol);
  soundFileService.registerMusicProtocol(protocol);
  nativeBridge = new NativeBridge();
  syncStatusService = new SyncStatusService(() => mainWindow, transientUserDataPath(userData, "sync-status.json"));
  updaterService = new UpdaterService(() => mainWindow, {
    log: (level, message, details) => diagnosticLogService.log({ level, phase: "updater", message, details })
  });
  steamWishlistService = new SteamWishlistService({
    repository,
    settingsService,
    sourceService,
    syncStatusService,
    cacheMetadataAssets,
    steamAppInfoProvider: fetchNativeSteamAppInfoMetadata,
    metadataLogger: (entry) => {
      diagnosticLogService.log({
        level: entry.level,
        phase: `metadata:${entry.providerId}`,
        message: `${entry.gameTitle}: ${entry.message}`,
        details: { appid: entry.appid, ...entry.details }
      });
      syncStatusService.log(entry.level, `metadata:${entry.providerId}`, `${entry.gameTitle}: ${entry.message}`, entry.details);
    }
  });
  launchTracker = new LaunchTracker(repository);
  launchTracker.on((event) => {
    if (event.kind === "started") {
      localPlaytimeMonitor?.ignorePid(event.session.pid);
    }
    emitGameUpdated(event.gameId);
  });
  localImportService = new LocalImportService(
    transientUserDataPath(userData, "local-scan-cache.json"),
    repository,
    nativeBridge,
    (level, message, details) => {
      diagnosticLogService.log({ level, phase: "local:issue-cache", message, details });
    }
  );
  localPlaytimeMonitor = new LocalPlaytimeMonitor({
    repository,
    nativeBridge,
    getSettings: () => settingsService.get(),
    emitGameUpdated,
    log: (level, message, details) => {
      diagnosticLogService.log({ level, phase: "local:playtime", message, details });
      syncStatusService.log(level === "warning" ? "warning" : "info", "local:playtime", message, details);
    }
  });
  backgroundService = new BackgroundService({
    getSettings: () => settingsService.get(),
    startSteamSync,
    runLocalScan,
    syncLocalLastPlayedFromPrefetch: () => syncLocalLastPlayedFromPrefetch(repository, nativeBridge),
    enqueueRichMetadataBackfill,
    localPlaytimeMonitor,
    isOnBatteryPower: () => powerMonitor.isOnBatteryPower(),
    getSystemIdleTime: () => powerMonitor.getSystemIdleTime(),
    cancelActiveSteamSync,
    profile
  });
  profile("services:ready", "Main services initialized");
  startResourceSampler();
  registerIpc();
  profile("ipc:registered", "IPC handlers registered");
  if (!onboardingPreview) {
    updaterService.start();
  }
  const settings = await settingsService.get();
  applyLoginItemSettings(settings);
  applySpotlightSettings(settings);
  if (!onboardingPreview) {
    await ensureTray();
    backgroundService.start(isBackgroundLaunch() ? "tray" : "foreground");
  }
  if (!isBackgroundLaunch()) {
    await showMainWindow({ withSplash: true, focus: true });
  }
});

app.on("second-instance", (_event, argv) => {
  profile("app:second-instance", "Second instance requested", { background: isBackgroundLaunch(argv) });
  if (!isBackgroundLaunch(argv)) {
    void showMainWindow({ withSplash: true, focus: true });
  }
});

powerMonitor.on("resume", () => {
  void backgroundService?.onResume();
});

powerMonitor.on("unlock-screen", () => {
  void backgroundService?.onResume();
});

app.on("window-all-closed", () => {
  profile("app:window-all-closed", "All windows closed");
  stopSystemAudioMonitor();
});

app.on("activate", () => {
  profile("app:activate", "Electron app activated");
  if (BrowserWindow.getAllWindows().length === 0) {
    void showMainWindow({ withSplash: true, focus: true });
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  if (servicesShutDown) {
    return;
  }
  servicesShutDown = true;
  if (startupHeartbeatTimer) {
    clearInterval(startupHeartbeatTimer);
    startupHeartbeatTimer = undefined;
  }
  if (settingsBackupTimer) {
    clearInterval(settingsBackupTimer);
    settingsBackupTimer = undefined;
  }
  stopResourceSampler();
  stopSystemAudioMonitor();
  globalShortcut.unregisterAll();
  backgroundService?.stop();
  if (!onboardingPreview) {
    syncStatusService?.flush();
  }
  updaterService?.dispose();
  void startupProfileService?.finish();
  repository?.close();
  nativeBridge?.dispose();
});
