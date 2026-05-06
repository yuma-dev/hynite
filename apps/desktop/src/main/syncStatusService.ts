import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserWindow } from "electron";
import type { ProviderId, SyncLogEntry, SyncLogLevel, SyncStatus } from "@hynite/core";

export class SyncStatusService {
  private status: SyncStatus = {
    active: false,
    phase: "idle",
    message: "No sync running",
    history: []
  };

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
    this.emit();
    this.persist();
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
    this.persist();
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
    this.persist();
  }

  private emit(): void {
    this.getWindow()?.webContents.send("sync:statusChanged", this.get());
  }

  private readPersistedStatus(): SyncStatus {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SyncStatus;
      return {
        ...parsed,
        active: false,
        phase: "idle",
        message: parsed.lastSuccessAt ? `Last Steam sync ${parsed.lastSuccessAt}` : "No sync running",
        current: undefined,
        total: undefined,
        history: parsed.history?.slice(0, 300) ?? []
      };
    } catch {
      return this.status;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ ...this.status, active: false }, null, 2));
  }
}
