import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserWindow } from "electron";
import type { ProviderId, SyncLogEntry, SyncLogLevel, SyncStatus } from "@hynite/core";

const STATUS_FLUSH_INTERVAL_MS = 250;

export class SyncStatusService {
  private status: SyncStatus = {
    active: false,
    phase: "idle",
    message: "No sync running",
    history: []
  };
  private emitTimer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly filePath: string
  ) {
    this.status = this.readPersistedStatus();
  }

  get(): SyncStatus {
    return {
      ...this.status,
      history: [...this.status.history]
    };
  }

  start(providerId: ProviderId, total?: number): void {
    const startedAt = new Date().toISOString();
    this.status = {
      ...this.status,
      active: true,
      providerId,
      phase: "starting",
      message: "Starting Steam sync",
      startedAt,
      finishedAt: undefined,
      current: 0,
      total
    };
    this.log("info", "starting", "Starting Steam sync", { providerId });
  }

  progress(phase: string, message: string, current?: number, total?: number, details?: Record<string, unknown>): void {
    this.status = {
      ...this.status,
      active: true,
      phase,
      message,
      current: current ?? this.status.current,
      total: total ?? this.status.total
    };
    this.log("info", phase, message, details);
  }

  backgroundProgress(phase: string, message: string, current?: number, total?: number, details?: Record<string, unknown>): void {
    this.status = {
      ...this.status,
      backgroundActive: true,
      backgroundPhase: phase,
      backgroundMessage: message,
      backgroundCurrent: current,
      backgroundTotal: total
    };
    this.log("info", phase, message, details);
  }

  backgroundFinish(message: string, details?: Record<string, unknown>): void {
    if (!this.status.backgroundActive) {
      return;
    }

    this.status = {
      ...this.status,
      backgroundActive: false,
      backgroundMessage: message,
      backgroundCurrent: this.status.backgroundTotal ?? this.status.backgroundCurrent
    };
    this.log("info", this.status.backgroundPhase ?? "metadata:detail", message, details);
    this.flush();
  }

  log(level: SyncLogLevel, phase: string, message: string, details?: Record<string, unknown>): void {
    const entry: SyncLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      phase,
      message,
      details
    };

    this.status = {
      ...this.status,
      history: [entry, ...this.status.history].slice(0, 300)
    };
    this.scheduleEmit();
    this.schedulePersist();
  }

  finish(message: string): void {
    const finishedAt = new Date().toISOString();
    this.status = {
      ...this.status,
      active: false,
      phase: "complete",
      message,
      finishedAt,
      lastSuccessAt: finishedAt,
      current: this.status.total ?? this.status.current
    };
    this.log("info", "complete", message);
    this.flush();
  }

  fail(message: string, details?: Record<string, unknown>): void {
    this.status = {
      ...this.status,
      active: false,
      phase: "failed",
      message,
      finishedAt: new Date().toISOString()
    };
    this.log("error", "failed", message, details);
    this.flush();
  }

  cancel(message: string, details?: Record<string, unknown>): void {
    this.status = {
      ...this.status,
      active: false,
      phase: "cancelled",
      message,
      finishedAt: new Date().toISOString()
    };
    this.log("info", "cancelled", message, details);
    this.flush();
  }

  flush(): void {
    this.flushEmit();
    this.flushPersist();
  }

  private emit(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }

    window.webContents.send("sync:statusChanged", this.get());
  }

  private scheduleEmit(): void {
    if (this.emitTimer) {
      return;
    }

    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit();
    }, STATUS_FLUSH_INTERVAL_MS);
  }

  private flushEmit(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    this.emit();
  }

  private readPersistedStatus(): SyncStatus {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SyncStatus;
      return {
        ...parsed,
        active: false,
        backgroundActive: false,
        phase: "idle",
        message: parsed.lastSuccessAt ? `Last Steam sync ${parsed.lastSuccessAt}` : "No sync running",
        current: undefined,
        total: undefined,
        backgroundCurrent: undefined,
        backgroundTotal: undefined,
        history: parsed.history?.slice(0, 300) ?? []
      };
    } catch {
      return this.status;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ ...this.status, active: false, backgroundActive: false }, null, 2));
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, STATUS_FLUSH_INTERVAL_MS);
  }

  private flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persist();
  }
}
