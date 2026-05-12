import type { ProfileEvent, ProfileProcess, ProfileSpanHandle, ProfileSpanStatus } from "@hynite/core";

const rendererStartedAt = performance.now();
let rendererHeartbeatStarted = false;
let activeImageLoads = 0;

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

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function elapsed(): number {
  return round(performance.now() - rendererStartedAt);
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sourceKind(src: string): string {
  if (src.startsWith("hynite-asset://")) return "hynite-asset";
  if (src.startsWith("http://")) return "http";
  if (src.startsWith("https://")) return "https";
  if (src.startsWith("data:")) return "data";
  return "app-asset";
}

function sourceDetails(src: string): Record<string, unknown> {
  try {
    const url = new URL(src, window.location.href);
    return {
      sourceKind: sourceKind(src),
      host: url.host || undefined,
      extension: url.pathname.includes(".") ? url.pathname.slice(url.pathname.lastIndexOf(".")).toLocaleLowerCase() : undefined,
      asset: url.protocol === "hynite-asset:" ? url.pathname.split("/").pop()?.slice(0, 12) : undefined
    };
  } catch {
    return { sourceKind: sourceKind(src) };
  }
}

function send(record: ProfileEvent | ProfileMetric): void {
  window.hynite.debug.profileRecord(record as unknown as Record<string, unknown>);
}

export function isProfileEnabled(): boolean {
  return Boolean(window.hynite.debug.profileEnabled);
}

export function activeProfileImageLoadCount(): number {
  return activeImageLoads;
}

export function profileStartup(phase: string, message: string, details?: Record<string, unknown>): void {
  window.hynite.debug.profile({
    phase,
    message,
    details,
    rendererElapsedMs: elapsed()
  });
}

export function profilePoint(category: string, name: string, details?: Record<string, unknown>): void {
  send({
    kind: "point",
    ts: new Date().toISOString(),
    elapsedMs: elapsed(),
    process: "renderer",
    category,
    name,
    details
  });
}

export function profileMetric(category: string, name: string, value: number, details?: Record<string, unknown>): void {
  send({
    kind: "metric",
    ts: new Date().toISOString(),
    elapsedMs: elapsed(),
    process: "renderer",
    category,
    name,
    value: round(value),
    details
  });
}

export function profileSpan(category: string, name: string, details?: Record<string, unknown>): ProfileSpanHandle {
  const spanId = id();
  const startedAt = performance.now();
  const start: ProfileEvent = {
    kind: "span-start",
    id: spanId,
    ts: new Date().toISOString(),
    elapsedMs: elapsed(),
    process: "renderer",
    category,
    name,
    details
  };
  window.hynite.debug.profileSpanStart(start as unknown as Record<string, unknown>);

  let ended = false;
  return {
    id: spanId,
    end(status: ProfileSpanStatus = "ok", endDetails?: Record<string, unknown>) {
      if (ended) return;
      ended = true;
      const end: ProfileEvent = {
        kind: "span-end",
        id: spanId,
        ts: new Date().toISOString(),
        elapsedMs: elapsed(),
        durationMs: round(performance.now() - startedAt),
        process: "renderer",
        category,
        name,
        status,
        details: endDetails
      };
      window.hynite.debug.profileSpanEnd(end as unknown as Record<string, unknown>);
    }
  };
}

export function profileRendererFreeze(durationMs: number, detectedBy: "heartbeat" | "longtask", details?: Record<string, unknown>): void {
  profilePoint("event-loop", "renderer:freeze", { durationMs: round(durationMs), detectedBy, ...details });
}

export function startRendererHeartbeat(): void {
  if (rendererHeartbeatStarted) {
    return;
  }

  rendererHeartbeatStarted = true;
  let lastBeatAt = performance.now();
  window.setInterval(() => {
    const now = performance.now();
    const driftMs = round(now - lastBeatAt - 250);
    lastBeatAt = now;
    if (driftMs > 100) {
      profileMetric("event-loop", "renderer:event-loop-drift", driftMs);
      profileRendererFreeze(driftMs, "heartbeat");
    }
  }, 250);

  try {
    const Observer = window.PerformanceObserver;
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) {
        profileRendererFreeze(entry.duration, "longtask", {
          entryType: entry.entryType,
          name: entry.name,
          startTime: round(entry.startTime)
        });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long task timing is best-effort and browser-support dependent.
  }
}

export function profileImageStart(src: string, details: Record<string, unknown>): ProfileSpanHandle {
  activeImageLoads += 1;
  const span = profileSpan("renderer-assets", "renderer-assets:image-load", {
    ...sourceDetails(src),
    ...details
  });
  let ended = false;
  return {
    id: span.id,
    end(status?: ProfileSpanStatus, endDetails?: Record<string, unknown>) {
      if (ended) return;
      ended = true;
      activeImageLoads = Math.max(0, activeImageLoads - 1);
      span.end(status, endDetails);
    }
  };
}

export function profileImageError(src: string, details: Record<string, unknown>, error?: string): void {
  const span = profileSpan("renderer-assets", "renderer-assets:image-error", {
    ...sourceDetails(src),
    ...details
  });
  span.end("error", { error });
}
