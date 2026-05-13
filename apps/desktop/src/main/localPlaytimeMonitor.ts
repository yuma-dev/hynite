import { extname } from "node:path";
import type { AppSettings } from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";
import type { NativeBridge } from "./nativeBridge";

const ACTIVE_POLL_MS = 30_000;
const EMPTY_POLL_MS = 10 * 60_000;
const EXECUTABLE_REFRESH_MS = 10 * 60_000;
const IGNORED_PID_TTL_MS = 12 * 60 * 60_000;

type LocalExecutable = {
  id: string;
  executablePath: string;
  key: string;
};

type ActiveSession = {
  gameId: string;
  executablePath: string;
  key: string;
  pid: number;
  startedAtMs: number;
  missingPolls: number;
};

export type LocalPlaytimeMonitorOptions = {
  repository: Pick<HyniteRepository, "getLocalGameExecutables" | "addPlaytime">;
  nativeBridge: Pick<NativeBridge, "getRunningProcesses">;
  getSettings: () => Promise<AppSettings>;
  emitGameUpdated?: (gameId: string) => void;
  now?: () => number;
  log?: (level: "info" | "warning", message: string, details?: Record<string, unknown>) => void;
};

function normalizePathKey(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function parseTimestamp(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isTrackableExecutable(path: string): boolean {
  return extname(path).toLowerCase() === ".exe";
}

export class LocalPlaytimeMonitor {
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private enabled = false;
  private polling = false;
  private executableCache: LocalExecutable[] = [];
  private executableByKey = new Map<string, LocalExecutable>();
  private lastExecutableRefreshAt = Number.NEGATIVE_INFINITY;
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly ignoredPids = new Map<number, number>();
  private lastWarningAt = 0;

  constructor(private readonly options: LocalPlaytimeMonitorOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshSettings();
  }

  stop(): void {
    this.stopped = true;
    this.enabled = false;
    this.clearTimer();
    this.flushActiveSessions();
  }

  async refreshSettings(): Promise<void> {
    const settings = await this.options.getSettings();
    this.enabled = settings.backgroundPlaytimeTracking !== false;
    if (!this.enabled) {
      this.clearTimer();
      this.flushActiveSessions();
      return;
    }
    this.schedule(0);
  }

  ignorePid(pid: number | undefined): void {
    if (!pid || pid <= 0) return;
    this.ignoredPids.set(pid, this.now() + IGNORED_PID_TTL_MS);
  }

  async refreshExecutables(): Promise<void> {
    await this.refreshExecutablesIfNeeded(true);
  }

  async pollNow(): Promise<void> {
    if (this.stopped || !this.enabled || this.polling) return;
    this.polling = true;
    try {
      this.pruneIgnoredPids();
      await this.refreshExecutablesIfNeeded();
      if (this.executableCache.length === 0) {
        this.schedule(EMPTY_POLL_MS);
        return;
      }

      const running = await this.options.nativeBridge.getRunningProcesses(
        this.executableCache.map((game) => game.executablePath)
      );
      const now = this.now();
      const seen = new Set<string>();
      const runningPids = new Set<number>();

      for (const processInfo of running) {
        runningPids.add(processInfo.pid);
        if (this.ignoredPids.has(processInfo.pid)) {
          continue;
        }
        const key = normalizePathKey(processInfo.path);
        const executable = this.executableByKey.get(key);
        if (!executable) {
          continue;
        }
        const sessionKey = `${processInfo.pid}\u0000${key}`;
        seen.add(sessionKey);
        const existing = this.activeSessions.get(sessionKey);
        if (existing) {
          existing.missingPolls = 0;
          continue;
        }
        const startedAtMs = parseTimestamp(processInfo.startedAt, now);
        this.activeSessions.set(sessionKey, {
          gameId: executable.id,
          executablePath: executable.executablePath,
          key,
          pid: processInfo.pid,
          startedAtMs,
          missingPolls: 0
        });
        this.options.repository.addPlaytime(executable.id, 0, new Date(startedAtMs).toISOString());
        this.options.emitGameUpdated?.(executable.id);
      }

      for (const pid of [...this.ignoredPids.keys()]) {
        if (!runningPids.has(pid)) {
          this.ignoredPids.delete(pid);
        }
      }

      for (const [sessionKey, session] of [...this.activeSessions]) {
        if (seen.has(sessionKey)) {
          continue;
        }
        session.missingPolls += 1;
        if (session.missingPolls < 2) {
          continue;
        }
        const minutes = Math.round((now - session.startedAtMs) / 60_000);
        this.options.repository.addPlaytime(session.gameId, minutes, new Date(now).toISOString());
        this.options.emitGameUpdated?.(session.gameId);
        this.activeSessions.delete(sessionKey);
      }

      this.schedule(ACTIVE_POLL_MS);
    } catch (error) {
      this.warn("Local playtime monitor poll failed", { error: error instanceof Error ? error.message : String(error) });
      this.schedule(ACTIVE_POLL_MS);
    } finally {
      this.polling = false;
    }
  }

  private async refreshExecutablesIfNeeded(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastExecutableRefreshAt < EXECUTABLE_REFRESH_MS) {
      return;
    }
    this.lastExecutableRefreshAt = now;
    const rows = this.options.repository.getLocalGameExecutables();
    this.executableCache = rows.flatMap((row): LocalExecutable[] => {
      if (!isTrackableExecutable(row.executablePath)) {
        return [];
      }
      return [{
        id: row.id,
        executablePath: row.executablePath,
        key: normalizePathKey(row.executablePath)
      }];
    });
    this.executableByKey = new Map(this.executableCache.map((row) => [row.key, row]));
  }

  private flushActiveSessions(): void {
    const now = this.now();
    for (const session of this.activeSessions.values()) {
      const minutes = Math.round((now - session.startedAtMs) / 60_000);
      this.options.repository.addPlaytime(session.gameId, minutes, new Date(now).toISOString());
      this.options.emitGameUpdated?.(session.gameId);
    }
    this.activeSessions.clear();
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.enabled) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollNow();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private pruneIgnoredPids(): void {
    const now = this.now();
    for (const [pid, expiresAt] of this.ignoredPids) {
      if (expiresAt <= now) {
        this.ignoredPids.delete(pid);
      }
    }
  }

  private warn(message: string, details?: Record<string, unknown>): void {
    const now = this.now();
    if (now - this.lastWarningAt < 10 * 60_000) {
      return;
    }
    this.lastWarningAt = now;
    this.options.log?.("warning", message, details);
    console.warn(message, details);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
