import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserWindow } from "electron";
import type { HyniteRepository } from "@hynite/db";
import type { SourceRefreshEntry, SourceRefreshState, SourceRefreshStatus } from "@hynite/core";
import { fetchSourceViaBrowser, ManualVerificationRequiredError } from "./sourceFetchService";
import type { SourceService } from "./sourceService";

const DAY_MS = 24 * 60 * 60 * 1000;
// Don't fire the sweep the instant the app launches — let startup settle first.
const STARTUP_GRACE_MS = 90_000;

/**
 * Refreshes every URL-backed download source once a day, in the background,
 * without ever interrupting the user. Sources whose bot-check won't auto-solve
 * are flagged `needs-verification` so the UI can surface them for a manual pass.
 */
export class SourceRefreshService {
  private status: SourceRefreshStatus = { running: false, entries: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private sweeping = false;

  constructor(
    private readonly repository: HyniteRepository,
    private readonly sourceService: SourceService,
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly filePath: string
  ) {
    this.status = this.readPersisted();
  }

  /** Current status, pruned to sources that still exist. */
  get(): SourceRefreshStatus {
    const liveIds = new Set(this.repository.listSources().map((s) => s.id));
    return {
      running: this.status.running,
      lastRunAt: this.status.lastRunAt,
      entries: this.status.entries.filter((e) => liveIds.has(e.id))
    };
  }

  /** Begin the daily schedule (runs an initial sweep if one is overdue). */
  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Push the current (pruned) status to the renderer — e.g. after a removal. */
  pushStatus(): void {
    this.emit();
  }

  /** Record that the user manually refreshed a source (clears any flag on it). */
  recordManualSuccess(sourceId: string, message?: string): void {
    this.upsertEntry({ id: sourceId, name: this.nameFor(sourceId), url: this.urlFor(sourceId), state: "ok", message, checkedAt: new Date().toISOString() });
    this.persist();
    this.emit();
  }

  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const last = this.status.lastRunAt ? Date.parse(this.status.lastRunAt) : 0;
    const elapsed = Date.now() - (Number.isFinite(last) ? last : 0);
    // If a day has passed (or we never ran), go after the startup grace; else
    // wait out the remainder of the day.
    const delay = Math.max(STARTUP_GRACE_MS, DAY_MS - elapsed);
    this.timer = setTimeout(() => void this.runSweep(), delay);
  }

  /** Run a full sweep now. Safe to call concurrently — extra calls no-op. */
  async runSweep(): Promise<void> {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const sources = this.repository.listSources().filter((s) => Boolean(s.url));
    this.status = { ...this.status, running: true };
    this.emit();
    console.info(`[source:refresh] starting daily sweep of ${sources.length} source(s)`);

    for (const source of sources) {
      const checkedAt = new Date().toISOString();
      let entry: SourceRefreshEntry;
      try {
        const fetched = await fetchSourceViaBrowser({ url: source.url!, parent: this.getWindow(), silent: true });
        const result = this.sourceService.refreshSource(source.id, fetched.json);
        entry = { id: source.id, name: result.name, url: source.url, state: "ok", message: `${result.importedEntries.toLocaleString()} entries`, checkedAt };
        console.info(`[source:refresh] ${result.name}: ok (${result.importedEntries} entries)`);
      } catch (error) {
        const needsVerification = error instanceof ManualVerificationRequiredError;
        const state: SourceRefreshState = needsVerification ? "needs-verification" : "error";
        const message = error instanceof Error ? error.message : String(error);
        entry = { id: source.id, name: source.name, url: source.url, state, message, checkedAt };
        console.warn(`[source:refresh] ${source.name}: ${state} — ${message}`);
      }
      this.upsertEntry(entry);
      this.emit();
    }

    this.status = { ...this.status, running: false, lastRunAt: new Date().toISOString() };
    this.persist();
    this.emit();
    this.sweeping = false;
    console.info("[source:refresh] sweep complete");
    this.scheduleNext();
  }

  private upsertEntry(entry: SourceRefreshEntry): void {
    const entries = this.status.entries.filter((e) => e.id !== entry.id);
    entries.push(entry);
    this.status = { ...this.status, entries };
  }

  private nameFor(id: string): string {
    return this.repository.listSources().find((s) => s.id === id)?.name ?? "source";
  }

  private urlFor(id: string): string | undefined {
    return this.repository.listSources().find((s) => s.id === id)?.url;
  }

  private emit(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send("sources:refreshStatus", this.get());
  }

  private readPersisted(): SourceRefreshStatus {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SourceRefreshStatus;
      return { running: false, lastRunAt: parsed.lastRunAt, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { running: false, entries: [] };
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ ...this.status, running: false }, null, 2));
    } catch (error) {
      console.warn("[source:refresh] failed to persist status:", error);
    }
  }
}
