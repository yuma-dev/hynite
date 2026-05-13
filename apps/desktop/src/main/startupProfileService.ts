import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  ProfileCategorySummary,
  ProfileEvent,
  ProfileProcess,
  ProfileSink,
  ProfileSpanHandle,
  ProfileSpanStatus,
  ProfileSpanSummary,
  TimingStats
} from "@hynite/core";

export type StartupProfileScope = ProfileProcess;

export type StartupProfileEntry = {
  scope: StartupProfileScope;
  phase: string;
  message: string;
  details?: Record<string, unknown>;
  rendererElapsedMs?: number;
};

type ProfileMetric = {
  kind: "metric";
  ts: string;
  elapsedMs: number;
  process: ProfileProcess;
  category: string;
  name: string;
  value: number;
  details?: Record<string, unknown>;
};

type ProfileRecord = ProfileEvent | ProfileMetric;

type ActiveSpan = Extract<ProfileEvent, { kind: "span-start" }> & {
  startedAt: number;
};

type FreezeReport = {
  id: string;
  process: ProfileProcess;
  startedAtElapsedMs: number;
  durationMs: number;
  severity: "notice" | "slow" | "freeze";
  detectedBy: "heartbeat" | "longtask" | "electron-unresponsive";
  overlappingSpans: ProfileSpanSummary[];
  recentEvents: ProfileEvent[];
  likelyCause: {
    category: "asset-load" | "steam-sync" | "sqlite" | "ipc" | "renderer-render" | "metadata" | "native-bridge" | "unknown";
    confidence: "high" | "medium" | "low";
    reason: string;
  };
};

type ProfileReport = {
  schemaVersion: 1;
  session: {
    id: string;
    startedAt: string;
    finishedAt?: string;
    appVersion: string;
    profileMode: "deep";
    userData: string;
    platform: string;
    versions: Record<string, string>;
  };
  summary: {
    durationMs: number;
    maxMainFreezeMs?: number;
    maxRendererFreezeMs?: number;
    totalMainFreezeMs: number;
    totalRendererFreezeMs: number;
    slowestSpans: ProfileSpanSummary[];
    topCategories: ProfileCategorySummary[];
    totalDroppedFrames: number;
    worstFrameMs?: number;
    warnings: string[];
  };
  freezes: FreezeReport[];
  startup: {
    milestones: ProfileEvent[];
    initialRendererLoadMs?: number;
    firstPaintOverlayHiddenMs?: number;
    backgroundSyncStartedMs?: number;
  };
  assets: Record<string, unknown>;
  detailOpen: Record<string, unknown>;
  steamSync: Record<string, unknown>;
  ipc: Record<string, unknown>;
  runtimeFrames: Record<string, unknown>;
  resources: Record<string, unknown>;
  renderer: Record<string, unknown>;
  main: Record<string, unknown>;
  raw: {
    eventsPath: string;
    droppedEventCount: number;
  };
};

const MAX_QUEUE = 10_000;
const MAX_RECENT_EVENTS = 200;
const MAX_COMPLETED_SPANS = 25_000;
const MAX_SLOWEST = 50;
const REPORT_INTERVAL_MS = 10_000;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function emptyTimingStats(): TimingStats {
  return { count: 0, totalMs: 0, minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, slowest: [] };
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return round(sorted[index] ?? 0);
}

function timingStats(spans: ProfileSpanSummary[], label: (span: ProfileSpanSummary) => string = (span) => span.name): TimingStats {
  if (spans.length === 0) return emptyTimingStats();
  const durations = spans.map((span) => span.durationMs);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    count: spans.length,
    totalMs: round(total),
    minMs: round(Math.min(...durations)),
    maxMs: round(Math.max(...durations)),
    avgMs: round(total / spans.length),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    slowest: [...spans]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, MAX_SLOWEST)
      .map((span) => ({ label: label(span), durationMs: span.durationMs, details: span.details }))
  };
}

function metricStats(metrics: ProfileMetric[], label: (metric: ProfileMetric) => string = (metric) => metric.name): TimingStats {
  if (metrics.length === 0) return emptyTimingStats();
  const values = metrics.map((metric) => metric.value);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: metrics.length,
    totalMs: round(total),
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
    avgMs: round(total / metrics.length),
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    slowest: [...metrics]
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_SLOWEST)
      .map((metric) => ({ label: label(metric), durationMs: metric.value, details: metric.details }))
  };
}

function inferCategory(phase: string): string {
  if (phase.startsWith("steam-sync") || phase.startsWith("steam:")) return "steam-sync";
  if (phase.startsWith("metadata")) return "metadata";
  if (phase.startsWith("ipc")) return "ipc";
  if (phase.startsWith("renderer:heartbeat") || phase.startsWith("main:heartbeat")) return "event-loop";
  if (phase.startsWith("renderer") || phase.startsWith("react") || phase.startsWith("app:") || phase.startsWith("refresh")) return "renderer-render";
  if (phase.startsWith("home")) return "home";
  if (phase.startsWith("library")) return "library";
  if (phase.startsWith("window")) return "window";
  if (phase.startsWith("startup") || phase.startsWith("services") || phase.startsWith("app:ready")) return "startup";
  return "main";
}

function sanitizeRunId(value: string): string {
  return value.replace(/[:]/g, "-");
}

function hashPrefix(value: string): string {
  return basename(value).slice(0, 12);
}

function safeUrlDetails(value: string): Record<string, unknown> {
  try {
    const url = new URL(value);
    const last = basename(url.pathname);
    const appid = /\/apps\/(?<appid>\d+)\//.exec(url.pathname)?.groups?.appid;
    return {
      protocol: url.protocol.replace(":", ""),
      host: url.host,
      extension: extname(url.pathname).toLowerCase(),
      appid,
      asset: last ? hashPrefix(last) : undefined
    };
  } catch {
    return { value: hashPrefix(value) };
  }
}

function redactValue(key: string, value: unknown): unknown {
  const lower = key.toLocaleLowerCase();
  if (lower.includes("apikey") || lower.includes("api_key") || lower.includes("access_token") || lower.includes("token") || lower.includes("secret")) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return safeUrlDetails(value);
    if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\")) return { basename: basename(value), extension: extname(value).toLowerCase() };
    if (value.length > 500) return `${value.slice(0, 500)}...`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry, index) => redactValue(`${key}[${index}]`, entry));
  }
  if (value && typeof value === "object") {
    return redactDetails(value as Record<string, unknown>);
  }
  return value;
}

function redactDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, redactValue(key, value)]));
}

function spanSummaryFromStart(span: ActiveSpan, nowElapsedMs: number): ProfileSpanSummary {
  return {
    id: span.id,
    process: span.process,
    category: span.category,
    name: span.name,
    startedAtElapsedMs: span.elapsedMs,
    durationMs: round(nowElapsedMs - span.elapsedMs),
    status: "ok",
    details: span.details
  };
}

function likelyCause(overlappingSpans: ProfileSpanSummary[]): FreezeReport["likelyCause"] {
  if (overlappingSpans.length === 0) {
    return { category: "unknown", confidence: "low", reason: "No instrumented span overlapped this freeze window." };
  }

  const slowest = [...overlappingSpans].sort((a, b) => b.durationMs - a.durationMs)[0]!;
  const map: Record<string, FreezeReport["likelyCause"]["category"]> = {
    "asset-cache": "asset-load",
    "renderer-assets": "asset-load",
    "steam-sync": "steam-sync",
    sqlite: "sqlite",
    ipc: "ipc",
    "renderer-render": "renderer-render",
    metadata: "metadata",
    "native-bridge": "native-bridge"
  };
  return {
    category: map[slowest.category] ?? "unknown",
    confidence: overlappingSpans.length > 0 ? "medium" : "low",
    reason: `Longest overlapping span: ${slowest.category}/${slowest.name} (${slowest.durationMs}ms).`
  };
}

function severityFor(durationMs: number): FreezeReport["severity"] {
  if (durationMs >= 1000) return "freeze";
  if (durationMs >= 250) return "slow";
  return "notice";
}

export class StartupProfileService implements ProfileSink {
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly reportPath: string;
  readonly latestReportPath: string;
  private readonly startedAt = performance.now();
  private readonly startedAtIso = new Date().toISOString();
  private readonly queue: string[] = [];
  private readonly recentEvents: ProfileEvent[] = [];
  private readonly completedSpans: ProfileSpanSummary[] = [];
  private readonly activeSpans = new Map<string, ActiveSpan>();
  private readonly freezes: FreezeReport[] = [];
  private readonly metrics: ProfileMetric[] = [];
  private flushPromise = Promise.resolve();
  private flushScheduled = false;
  private droppedEventCount = 0;
  private reportTimer?: NodeJS.Timeout;
  private finishedAt?: string;

  constructor(
    private readonly userData: string,
    private readonly appVersion: string
  ) {
    this.enabled = process.env.HYNITE_STARTUP_PROFILE === "1" || process.env.HYNITE_STARTUP_PROFILE === "true";
    this.sessionId = sanitizeRunId(this.startedAtIso);
    const root = join(userData, "profile-runs");
    this.runDir = join(root, this.sessionId);
    this.eventsPath = join(this.runDir, "events.ndjson");
    this.reportPath = join(this.runDir, "report.json");
    this.latestReportPath = join(root, "latest-report.json");

    if (this.enabled) {
      void this.initialize(root);
      this.reportTimer = setInterval(() => {
        void this.writeReport();
      }, REPORT_INTERVAL_MS);
      this.reportTimer.unref?.();
    }
  }

  log(entry: StartupProfileEntry): void {
    this.point(inferCategory(entry.phase), entry.phase, {
      message: entry.message,
      ...entry.details,
      rendererElapsedMs: entry.rendererElapsedMs
    }, entry.scope);
  }

  point(category: string, name: string, details?: Record<string, unknown>, process: ProfileProcess = "main"): void {
    if (!this.enabled) return;
    const event: ProfileEvent = {
      kind: "point",
      ts: new Date().toISOString(),
      elapsedMs: this.elapsed(),
      process,
      category,
      name,
      details: redactDetails(details)
    };
    this.record(event);
  }

  startSpan(category: string, name: string, details?: Record<string, unknown>, process: ProfileProcess = "main"): ProfileSpanHandle {
    if (!this.enabled) {
      return { id: "", end: () => undefined };
    }

    const id = randomUUID();
    const startedAt = performance.now();
    const event: ActiveSpan = {
      kind: "span-start",
      id,
      ts: new Date().toISOString(),
      elapsedMs: this.elapsed(),
      process,
      category,
      name,
      details: redactDetails(details),
      startedAt
    };
    this.activeSpans.set(id, event);
    this.record(event);

    let ended = false;
    return {
      id,
      end: (status: ProfileSpanStatus = "ok", endDetails?: Record<string, unknown>) => {
        if (ended) return;
        ended = true;
        this.endSpan(id, status, endDetails);
      }
    };
  }

  metric(category: string, name: string, value: number, details?: Record<string, unknown>, process: ProfileProcess = "main"): void {
    if (!this.enabled) return;
    const event: ProfileMetric = {
      kind: "metric",
      ts: new Date().toISOString(),
      elapsedMs: this.elapsed(),
      process,
      category,
      name,
      value: round(value),
      details: redactDetails(details)
    };
    this.metrics.push(event);
    if (this.metrics.length > 5_000) {
      this.metrics.splice(0, this.metrics.length - 5_000);
    }
    this.enqueue(event);
  }

  recordRendererEvent(event: ProfileRecord): void {
    if (!this.enabled) return;
    if (event.kind === "span-start") {
      this.activeSpans.set(event.id, { ...event, startedAt: performance.now() - Math.max(0, this.elapsed() - event.elapsedMs) });
      this.record(event);
      return;
    }
    if (event.kind === "span-end") {
      const started = this.activeSpans.get(event.id);
      this.activeSpans.delete(event.id);
      const mergedDetails = redactDetails({ ...started?.details, ...event.details });
      const mergedEvent: ProfileEvent = {
        ...event,
        details: mergedDetails
      };
      this.completedSpans.push({
        id: event.id,
        process: event.process,
        category: event.category,
        name: event.name,
        startedAtElapsedMs: started?.elapsedMs ?? round(event.elapsedMs - event.durationMs),
        durationMs: event.durationMs,
        status: event.status,
        details: mergedDetails
      });
      this.trimCompletedSpans();
      this.record(mergedEvent);
      return;
    }
    if (event.kind === "metric") {
      this.metric(event.category, event.name, event.value, event.details, event.process);
      return;
    }
    if (
      event.kind === "point" &&
      event.process === "renderer" &&
      event.category === "event-loop" &&
      event.name === "renderer:freeze" &&
      typeof event.details?.durationMs === "number"
    ) {
      this.recordFreeze(
        "renderer",
        event.details.durationMs,
        event.details.detectedBy === "longtask" ? "longtask" : "heartbeat",
        event.details
      );
      return;
    }
    this.record(event);
  }

  recordFreeze(
    process: ProfileProcess,
    durationMs: number,
    detectedBy: FreezeReport["detectedBy"],
    details?: Record<string, unknown>
  ): void {
    if (!this.enabled) return;
    const elapsedMs = this.elapsed();
    const startedAtElapsedMs = Math.max(0, round(elapsedMs - durationMs));
    const overlappingSpans = this.overlappingSpans(startedAtElapsedMs, elapsedMs);
    const freeze: FreezeReport = {
      id: randomUUID(),
      process,
      startedAtElapsedMs,
      durationMs: round(durationMs),
      severity: severityFor(durationMs),
      detectedBy,
      overlappingSpans,
      recentEvents: [...this.recentEvents],
      likelyCause: likelyCause(overlappingSpans)
    };
    this.freezes.push(freeze);
    this.point("event-loop", `${process}:freeze`, {
      durationMs: freeze.durationMs,
      detectedBy,
      severity: freeze.severity,
      likelyCause: freeze.likelyCause,
      ...details
    }, process);
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    this.scheduleFlush();
    await this.flushPromise;
  }

  async finish(): Promise<void> {
    if (!this.enabled) return;
    this.finishedAt = new Date().toISOString();
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = undefined;
    }
    await this.flush();
    await this.writeReport();
  }

  writeReport(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const report = this.buildReport();
    return mkdir(dirname(this.reportPath), { recursive: true })
      .then(() => writeFile(this.reportPath, JSON.stringify(report, null, 2), "utf8"))
      .then(() => mkdir(dirname(this.latestReportPath), { recursive: true }))
      .then(() => copyFile(this.reportPath, this.latestReportPath))
      .catch((error: unknown) => {
        console.warn("Failed to write startup profile report", error);
      });
  }

  private elapsed(): number {
    return round(performance.now() - this.startedAt);
  }

  private endSpan(id: string, status: ProfileSpanStatus, details?: Record<string, unknown>): void {
    const started = this.activeSpans.get(id);
    if (!started) return;
    this.activeSpans.delete(id);
    const durationMs = round(performance.now() - started.startedAt);
    const mergedDetails = redactDetails({ ...started.details, ...details });
    const event: ProfileEvent = {
      kind: "span-end",
      id,
      ts: new Date().toISOString(),
      elapsedMs: this.elapsed(),
      durationMs,
      process: started.process,
      category: started.category,
      name: started.name,
      status,
      details: mergedDetails
    };
    this.completedSpans.push({
      id,
      process: started.process,
      category: started.category,
      name: started.name,
      startedAtElapsedMs: started.elapsedMs,
      durationMs,
      status,
      details: mergedDetails
    });
    this.trimCompletedSpans();
    this.record(event);
  }

  private record(event: ProfileEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > MAX_RECENT_EVENTS) {
      this.recentEvents.splice(0, this.recentEvents.length - MAX_RECENT_EVENTS);
    }
    this.enqueue(event);
  }

  private enqueue(record: ProfileRecord): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.droppedEventCount += 1;
      return;
    }

    this.queue.push(`${JSON.stringify(record)}\n`);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      const lines = this.queue.splice(0, this.queue.length).join("");
      if (!lines) return;
      this.flushPromise = this.flushPromise
        .then(async () => {
          await mkdir(dirname(this.eventsPath), { recursive: true });
          await appendFile(this.eventsPath, lines, "utf8");
        })
        .catch((error: unknown) => {
          console.warn("Failed to write startup profile events", error);
        });
    }, 0).unref?.();
  }

  private trimCompletedSpans(): void {
    if (this.completedSpans.length > MAX_COMPLETED_SPANS) {
      this.completedSpans.splice(0, this.completedSpans.length - MAX_COMPLETED_SPANS);
    }
  }

  private overlappingSpans(startElapsedMs: number, endElapsedMs: number): ProfileSpanSummary[] {
    const active = [...this.activeSpans.values()].map((span) => spanSummaryFromStart(span, endElapsedMs));
    return [...this.completedSpans, ...active]
      .filter((span) => span.startedAtElapsedMs <= endElapsedMs && span.startedAtElapsedMs + span.durationMs >= startElapsedMs)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 20);
  }

  private buildReport(): ProfileReport {
    const durationMs = this.elapsed();
    const mainFreezes = this.freezes.filter((freeze) => freeze.process === "main");
    const rendererFreezes = this.freezes.filter((freeze) => freeze.process === "renderer");
    const slowestSpans = [...this.completedSpans]
      .filter((span) => !(span.name === "renderer-assets:image-load" && span.status === "cancelled"))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, MAX_SLOWEST);
    const droppedFrameMetrics = this.metrics.filter((metric) => metric.category === "runtime-frame" && metric.name === "renderer:frame-delta");
    const totalDroppedFrames = droppedFrameMetrics.reduce((sum, metric) => sum + (typeof metric.details?.droppedFrames === "number" ? metric.details.droppedFrames : 0), 0);
    const topCategories = this.topCategories();
    const warnings: string[] = [];
    if (this.droppedEventCount > 0) warnings.push(`Dropped ${this.droppedEventCount} profile events because the async queue was full.`);

    return {
      schemaVersion: 1,
      session: {
        id: this.sessionId,
        startedAt: this.startedAtIso,
        finishedAt: this.finishedAt,
        appVersion: this.appVersion,
        profileMode: "deep",
        userData: this.userData,
        platform: process.platform,
        versions: Object.fromEntries(Object.entries(process.versions).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      },
      summary: {
        durationMs,
        maxMainFreezeMs: mainFreezes.length ? Math.max(...mainFreezes.map((freeze) => freeze.durationMs)) : undefined,
        maxRendererFreezeMs: rendererFreezes.length ? Math.max(...rendererFreezes.map((freeze) => freeze.durationMs)) : undefined,
        totalMainFreezeMs: round(mainFreezes.reduce((sum, freeze) => sum + freeze.durationMs, 0)),
        totalRendererFreezeMs: round(rendererFreezes.reduce((sum, freeze) => sum + freeze.durationMs, 0)),
        slowestSpans,
        topCategories,
        totalDroppedFrames,
        worstFrameMs: droppedFrameMetrics.length ? Math.max(...droppedFrameMetrics.map((metric) => metric.value)) : undefined,
        warnings
      },
      freezes: this.freezes,
      startup: this.startupReport(),
      assets: this.assetReport(),
      detailOpen: this.detailOpenReport(),
      steamSync: this.steamSyncReport(),
      ipc: this.ipcReport(),
      runtimeFrames: this.runtimeFrameReport(),
      resources: this.resourceReport(),
      renderer: this.processReport("renderer"),
      main: this.processReport("main"),
      raw: {
        eventsPath: this.eventsPath,
        droppedEventCount: this.droppedEventCount
      }
    };
  }

  private startupReport(): ProfileReport["startup"] {
    const milestones = this.recentEvents.filter((event) => event.category === "startup" || event.name.startsWith("initial-load") || event.name.startsWith("startup-overlay"));
    const initial = this.completedSpans.find((span) => span.name === "initial-load");
    const overlay = this.recentEvents.find((event) => event.name === "startup-overlay:hidden");
    const background = this.recentEvents.find((event) => event.name === "startup:background:start");
    return {
      milestones,
      initialRendererLoadMs: initial?.durationMs,
      firstPaintOverlayHiddenMs: overlay?.elapsedMs,
      backgroundSyncStartedMs: background?.elapsedMs
    };
  }

  private topCategories(): ProfileCategorySummary[] {
    const byCategory = new Map<string, ProfileSpanSummary[]>();
    for (const span of this.completedSpans) {
      const spans = byCategory.get(span.category) ?? [];
      spans.push(span);
      byCategory.set(span.category, spans);
    }
    return [...byCategory.entries()]
      .map(([category, spans]) => ({
        category,
        durationMs: round(spans.reduce((sum, span) => sum + span.durationMs, 0)),
        count: spans.length,
        p95Ms: timingStats(spans).p95Ms
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 20);
  }

  private assetReport(): Record<string, unknown> {
    const spans = this.completedSpans.filter((span) => span.category === "asset-cache" || span.category === "renderer-assets");
    const localReads = spans.filter((span) => span.name === "asset-cache:protocol-read");
    const rendererImages = spans.filter((span) => span.name.startsWith("renderer-assets:image"));
    const rendererImagesByStatus = {
      ok: timingStats(rendererImages.filter((span) => span.status === "ok"), (span) => `${String(span.details?.role ?? "image")} ${String(span.details?.sourceKind ?? "")}`.trim()),
      error: timingStats(rendererImages.filter((span) => span.status === "error"), (span) => `${String(span.details?.role ?? "image")} ${String(span.details?.sourceKind ?? "")}`.trim()),
      cancelled: timingStats(rendererImages.filter((span) => span.status === "cancelled"), (span) => `${String(span.details?.role ?? "image")} ${String(span.details?.sourceKind ?? "")}`.trim())
    };
    const cacheHits = spans.filter((span) => span.name === "asset-cache:cache-hit").length;
    const remoteFetches = spans.filter((span) => span.name === "asset-cache:remote-fetch");
    const failed = spans.filter((span) => span.status === "error" || span.details?.status === "missing" || span.name.endsWith(":image-error"));
    return {
      localCacheHits: cacheHits,
      localCacheMisses: localReads.filter((span) => span.details?.status === "missing").length,
      remoteFetches: remoteFetches.length,
      protocolReads: timingStats(localReads, (span) => String(span.details?.asset ?? span.name)),
      rendererImages: timingStats(rendererImages, (span) => `${String(span.details?.role ?? "image")} ${String(span.details?.sourceKind ?? "")}`.trim()),
      rendererImagesByStatus,
      slowestLocalReads: timingStats(localReads).slowest,
      slowestRendererImages: timingStats(rendererImages.filter((span) => span.status !== "cancelled")).slowest,
      failed: failed.slice(-100),
      oneByOneGaps: this.assetGaps(rendererImages)
    };
  }

  private assetGaps(rendererImages: ProfileSpanSummary[]): Array<Record<string, unknown>> {
    const completedLoads = rendererImages
      .filter((span) => span.name === "renderer-assets:image-load")
      .sort((a, b) => a.startedAtElapsedMs + a.durationMs - (b.startedAtElapsedMs + b.durationMs));
    const gaps: Array<Record<string, unknown>> = [];
    for (let index = 1; index < completedLoads.length; index += 1) {
      const previous = completedLoads[index - 1]!;
      const current = completedLoads[index]!;
      const previousEnd = previous.startedAtElapsedMs + previous.durationMs;
      const currentEnd = current.startedAtElapsedMs + current.durationMs;
      const gapMs = round(currentEnd - previousEnd);
      if (gapMs >= 100) {
        gaps.push({
          gapMs,
          previous: previous.details,
          current: current.details,
          atElapsedMs: currentEnd
        });
      }
    }
    return gaps.slice(-100);
  }

  private detailOpenReport(): Record<string, unknown> {
    const byName = (name: string) => this.completedSpans.filter((span) => span.name === name);
    const prefixed = (prefix: string) => this.completedSpans.filter((span) => span.name.startsWith(prefix));
    const gamesGetIpc = this.completedSpans.filter((span) => span.category === "ipc" && span.name === "ipc:call" && span.details?.channel === "games:get");
    const detailSpans = [
      ...prefixed("renderer:detail-open"),
      ...prefixed("detail:get"),
      ...prefixed("metadata:detail"),
      ...prefixed("source-search"),
      ...gamesGetIpc
    ];

    const slowest = [...detailSpans]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 30);
    const byGame = new Map<string, ProfileSpanSummary[]>();
    for (const span of detailSpans) {
      const gameId = typeof span.details?.gameId === "string"
        ? span.details.gameId
        : typeof span.details?.id === "string"
          ? span.details.id
          : undefined;
      if (!gameId) continue;
      const spans = byGame.get(gameId) ?? [];
      spans.push(span);
      byGame.set(gameId, spans);
    }
    const slowestGames = [...byGame.entries()]
      .map(([gameId, spans]) => {
        const outer = spans.find((span) => span.name === "renderer:detail-open");
        const title = spans.find((span) => typeof span.details?.title === "string")?.details?.title;
        return {
          gameId,
          title,
          totalMs: outer?.durationMs ?? round(spans.reduce((sum, span) => sum + span.durationMs, 0)),
          source: outer?.details?.source,
          hasRichDetail: spans.find((span) => Object.prototype.hasOwnProperty.call(span.details ?? {}, "hasRichDetail"))?.details?.hasRichDetail,
          screenshots: spans.find((span) => typeof span.details?.screenshots === "number")?.details?.screenshots,
          sourceMatches: spans.find((span) => typeof span.details?.sourceMatches === "number")?.details?.sourceMatches,
          slowestSteps: [...spans].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)
        };
      })
      .sort((a, b) => Number(b.totalMs) - Number(a.totalMs))
      .slice(0, 20);

    return {
      opens: timingStats(byName("renderer:detail-open"), (span) => String(span.details?.title ?? span.details?.id ?? span.name)),
      rendererGamesGet: timingStats(byName("renderer:detail-open:games-get"), (span) => String(span.details?.title ?? span.details?.id ?? span.name)),
      ipcGamesGet: timingStats(gamesGetIpc, (span) => String(span.details?.channel ?? span.name)),
      dbRead: timingStats(byName("detail:get:db-read"), (span) => String(span.details?.title ?? span.details?.gameId ?? span.name)),
      sourceMatches: timingStats([...byName("sources:search"), ...byName("sources:search-title")], (span) => String(span.details?.title ?? span.details?.gameId ?? span.name)),
      rawCacheLookup: timingStats(byName("metadata:detail:raw-cache-lookup"), (span) => String(span.details?.title ?? span.details?.appid ?? span.name)),
      rawCacheNormalize: timingStats(byName("metadata:detail:raw-cache-normalize"), (span) => String(span.details?.title ?? span.details?.appid ?? span.name)),
      steamFetch: timingStats(byName("metadata:detail:steam-fetch"), (span) => String(span.details?.title ?? span.details?.appid ?? span.name)),
      metadataAssetCache: timingStats(byName("metadata:detail:asset-cache"), (span) => String(span.details?.title ?? span.details?.appid ?? span.name)),
      metadataApply: timingStats(byName("metadata:detail:apply"), (span) => String(span.details?.title ?? span.details?.appid ?? span.name)),
      rendererApplyState: timingStats(byName("renderer:detail-open:apply-state"), (span) => String(span.details?.title ?? span.details?.id ?? span.name)),
      slowest,
      slowestGames
    };
  }

  private steamSyncReport(): Record<string, unknown> {
    const syncSpans = this.completedSpans.filter((span) => span.category === "steam-sync");
    const metadataSpans = this.completedSpans.filter((span) => span.category === "metadata");
    const byName = (name: string) => syncSpans.filter((span) => span.name === name);
    const providerGroups = new Map<string, ProfileSpanSummary[]>();
    for (const span of metadataSpans.filter((entry) => entry.name.startsWith("metadata:provider"))) {
      const provider = String(span.details?.provider ?? span.details?.providerId ?? "unknown");
      const spans = providerGroups.get(provider) ?? [];
      spans.push(span);
      providerGroups.set(provider, spans);
    }
    const metadataProviders = Object.fromEntries([...providerGroups.entries()].map(([provider, spans]) => [provider, timingStats(spans)]));
    const runs = syncSpans
      .filter((span) => span.name === "steam-sync:run")
      .map((run) => ({
        id: String(run.details?.syncRunId ?? run.id),
        trigger: run.details?.trigger ?? "manual",
        startedAtElapsedMs: run.startedAtElapsedMs,
        durationMs: run.durationMs,
        scanned: run.details?.scanned ?? 0,
        upserted: run.details?.upserted ?? 0,
        installed: run.details?.installed ?? 0,
        refreshStaleMetadata: Boolean(run.details?.refreshStaleMetadata),
        categories: {
          settingsLoad: timingStats(byName("steam-sync:settings-load")),
          decryptSecrets: timingStats(byName("steam-sync:decrypt-secrets")),
          ownedGamesFetch: timingStats(byName("steam-sync:owned-games-fetch")),
          familyTokenRefresh: timingStats(byName("steam-sync:family-token-refresh")),
          familyGroupFetch: timingStats(byName("steam-sync:family-group-fetch")),
          familySharedFetch: timingStats(byName("steam-sync:family-shared-fetch")),
          localInstallScan: timingStats(byName("steam-sync:local-install-scan")),
          sqliteUpsertChunks: timingStats(byName("steam-sync:sqlite-upsert-chunk")),
          pruneProviderSources: timingStats(byName("steam-sync:prune-provider-sources")),
          metadataRefreshTotal: timingStats(byName("steam-sync:metadata-refresh-total")),
          metadataProviders,
          assetCaching: timingStats(byName("steam-sync:asset-cache-metadata-patch")),
          metadataApply: timingStats(byName("steam-sync:metadata-apply")),
          richBackfillQueue: timingStats(byName("steam-sync:rich-backfill-queue"))
        },
        slowestGames: this.slowestSteamGames(metadataSpans),
        failures: [...syncSpans, ...metadataSpans]
          .filter((span) => span.status === "error")
          .slice(-100)
          .map((span) => ({
            appid: typeof span.details?.appid === "string" ? span.details.appid : undefined,
            title: typeof span.details?.title === "string" ? span.details.title : undefined,
            stage: span.name,
            message: typeof span.details?.error === "string" ? span.details.error : "failed",
            elapsedMs: span.startedAtElapsedMs + span.durationMs
          }))
      }));
    return { runs, providers: metadataProviders, stages: timingStats(syncSpans) };
  }

  private slowestSteamGames(metadataSpans: ProfileSpanSummary[]): Array<Record<string, unknown>> {
    const byGame = new Map<string, ProfileSpanSummary[]>();
    for (const span of metadataSpans) {
      const appid = typeof span.details?.appid === "string" ? span.details.appid : undefined;
      if (!appid) continue;
      const spans = byGame.get(appid) ?? [];
      spans.push(span);
      byGame.set(appid, spans);
    }
    return [...byGame.entries()]
      .map(([appid, spans]) => {
        const stages: Record<string, number> = {};
        const providers: Record<string, number> = {};
        for (const span of spans) {
          stages[span.name] = round((stages[span.name] ?? 0) + span.durationMs);
          const provider = typeof span.details?.provider === "string" ? span.details.provider : undefined;
          if (provider) providers[provider] = round((providers[provider] ?? 0) + span.durationMs);
        }
        return {
          appid,
          title: spans.find((span) => typeof span.details?.title === "string")?.details?.title,
          totalMs: round(spans.reduce((sum, span) => sum + span.durationMs, 0)),
          stages,
          providers,
          cache: {
            localAssetHits: spans.filter((span) => span.details?.cacheStatus === "hit").length,
            localAssetMisses: spans.filter((span) => span.details?.cacheStatus === "missing").length,
            remoteFetches: spans.filter((span) => span.details?.remoteFetch === true).length
          },
          warnings: spans.flatMap((span) => typeof span.details?.warning === "string" ? [span.details.warning] : [])
        };
      })
      .sort((a, b) => Number(b.totalMs) - Number(a.totalMs))
      .slice(0, 50);
  }

  private ipcReport(): Record<string, unknown> {
    const spans = this.completedSpans.filter((span) => span.category === "ipc");
    const byChannel = new Map<string, ProfileSpanSummary[]>();
    for (const span of spans) {
      const channel = String(span.details?.channel ?? span.name);
      const entries = byChannel.get(channel) ?? [];
      entries.push(span);
      byChannel.set(channel, entries);
    }
    return {
      stats: timingStats(spans),
      channels: Object.fromEntries([...byChannel.entries()].map(([channel, channelSpans]) => [channel, timingStats(channelSpans)])),
      errors: spans.filter((span) => span.status === "error").slice(-100)
    };
  }

  private runtimeFrameReport(): Record<string, unknown> {
    const frameDrops = this.metrics.filter((metric) => metric.category === "runtime-frame" && metric.name === "renderer:frame-delta");
    const colorBends = this.metrics.filter((metric) => metric.category === "runtime-frame" && metric.name === "renderer:color-bends-render");
    const reactCommits = this.metrics.filter((metric) => metric.category === "react-render" && metric.name === "react:commit");
    const interactions = this.completedSpans.filter((span) => span.category === "runtime-interaction");

    const droppedFrames = (metric: ProfileMetric) => typeof metric.details?.droppedFrames === "number" ? metric.details.droppedFrames : 0;
    const groupMetrics = (metrics: ProfileMetric[], keyFor: (metric: ProfileMetric) => string) => Object.fromEntries(
      [...metrics.reduce((groups, metric) => {
        const key = keyFor(metric);
        const entries = groups.get(key) ?? [];
        entries.push(metric);
        groups.set(key, entries);
        return groups;
      }, new Map<string, ProfileMetric[]>()).entries()]
        .map(([key, metricsForKey]) => [key, {
          ...metricStats(metricsForKey, (metric) => String(metric.details?.activeInteractionName ?? metric.name)),
          droppedFrames: metricsForKey.reduce((sum, metric) => sum + droppedFrames(metric), 0)
        }])
    );

    const contextKey = (metric: ProfileMetric): string => {
      const route = String(metric.details?.route ?? "unknown");
      const area = String(metric.details?.area ?? route);
      if (area === "big-picture") {
        return `big-picture/${String(metric.details?.bpViewMode ?? "unknown")}/${String(metric.details?.bpTabLabel ?? metric.details?.bpTabId ?? "unknown")}`;
      }
      if (area === "library") {
        return `library/${String(metric.details?.activeGroupName ?? metric.details?.activeGroupId ?? "all")}`;
      }
      return `${area}/${route}`;
    };

    const interactionKey = (metric: ProfileMetric): string => String(metric.details?.activeInteractionName ?? "none");
    const reactKey = (metric: ProfileMetric): string => `${String(metric.details?.id ?? "unknown")}/${String(metric.details?.phase ?? "unknown")}`;

    return {
      frameDrops: {
        totalEvents: frameDrops.length,
        totalDroppedFrames: frameDrops.reduce((sum, metric) => sum + droppedFrames(metric), 0),
        worstFrameMs: frameDrops.length ? Math.max(...frameDrops.map((metric) => metric.value)) : 0,
        stats: metricStats(frameDrops, (metric) => contextKey(metric)),
        byContext: groupMetrics(frameDrops, contextKey),
        byInteraction: groupMetrics(frameDrops, interactionKey),
        slowest: metricStats(frameDrops, (metric) => `${contextKey(metric)} ${String(metric.details?.activeInteractionName ?? "")}`.trim()).slowest
      },
      interactions: {
        stats: timingStats(interactions, (span) => span.name),
        byName: Object.fromEntries(
          [...interactions.reduce((groups, span) => {
            const entries = groups.get(span.name) ?? [];
            entries.push(span);
            groups.set(span.name, entries);
            return groups;
          }, new Map<string, ProfileSpanSummary[]>()).entries()]
            .map(([name, spans]) => [name, timingStats(spans, (span) => String(span.details?.bpTabLabel ?? span.details?.activeGroupName ?? span.name))])
        ),
        slowest: timingStats(interactions, (span) => span.name).slowest
      },
      reactCommits: {
        stats: metricStats(reactCommits, reactKey),
        byComponent: groupMetrics(reactCommits, (metric) => String(metric.details?.id ?? "unknown")),
        slowest: metricStats(reactCommits, reactKey).slowest
      },
      colorBends: {
        stats: metricStats(colorBends, (metric) => `${String(metric.details?.canvasWidth ?? "?")}x${String(metric.details?.canvasHeight ?? "?")}`),
        slowest: metricStats(colorBends).slowest
      }
    };
  }

  private resourceReport(): Record<string, unknown> {
    const metrics = this.metrics.filter((metric) => metric.category === "resource");
    const samples = metrics.filter((metric) => metric.name === "resource:sample");
    const byMode = new Map<string, ProfileMetric[]>();
    for (const sample of samples) {
      const mode = String(sample.details?.mode ?? "unknown");
      const entries = byMode.get(mode) ?? [];
      entries.push(sample);
      byMode.set(mode, entries);
    }

    const fieldStats = (field: string, rows: ProfileMetric[] = samples): Record<string, unknown> => {
      const values = rows
        .map((metric) => metric.details?.[field])
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (values.length === 0) {
        return { count: 0 };
      }
      const total = values.reduce((sum, value) => sum + value, 0);
      return {
        count: values.length,
        min: round(Math.min(...values)),
        max: round(Math.max(...values)),
        avg: round(total / values.length),
        p50: percentile(values, 50),
        p95: percentile(values, 95)
      };
    };

    const modeStats = Object.fromEntries([...byMode.entries()].map(([mode, rows]) => [mode, {
      samples: rows.length,
      mainRssMb: fieldStats("mainRssMb", rows),
      totalElectronWorkingSetMb: fieldStats("totalElectronWorkingSetMb", rows),
      totalElectronCpuPercent: fieldStats("totalElectronCpuPercent", rows),
      nativeBridgeRssMb: fieldStats("nativeBridgeRssMb", rows),
      rendererProcessCount: fieldStats("rendererProcessCount", rows)
    }]));

    return {
      samples: samples.length,
      mainRssMb: fieldStats("mainRssMb"),
      heapUsedMb: fieldStats("heapUsedMb"),
      totalElectronWorkingSetMb: fieldStats("totalElectronWorkingSetMb"),
      totalElectronCpuPercent: fieldStats("totalElectronCpuPercent"),
      nativeBridgeRssMb: fieldStats("nativeBridgeRssMb"),
      rendererProcessCount: fieldStats("rendererProcessCount"),
      byMode: modeStats,
      latest: samples.at(-1)?.details,
      slowestCpuSamples: [...samples]
        .sort((a, b) => Number(b.details?.totalElectronCpuPercent ?? 0) - Number(a.details?.totalElectronCpuPercent ?? 0))
        .slice(0, 20)
        .map((metric) => ({ elapsedMs: metric.elapsedMs, cpuPercent: metric.details?.totalElectronCpuPercent, details: metric.details }))
    };
  }

  private processReport(processName: ProfileProcess): Record<string, unknown> {
    const spans = this.completedSpans.filter((span) => span.process === processName);
    return {
      spans: timingStats(spans),
      eventLoop: {
        freezes: this.freezes.filter((freeze) => freeze.process === processName),
        metrics: this.metrics.filter((metric) => metric.process === processName && metric.category === "event-loop").slice(-500)
      },
      slowest: timingStats(spans).slowest
    };
  }

  private async initialize(root: string): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await this.pruneOldRuns(root);
    this.point("startup", "profile:session-start", { runDir: this.runDir, eventsPath: this.eventsPath });
  }

  private async pruneOldRuns(root: string): Promise<void> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const dirs = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = join(root, entry.name);
          const info = await stat(fullPath);
          return { fullPath, mtimeMs: info.mtimeMs };
        }));
      const stale = dirs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(10);
      await Promise.all(stale.map((entry) => rm(entry.fullPath, { recursive: true, force: true })));
    } catch {
      // Retention is best-effort; profiling must never block app startup.
    }
  }
}
