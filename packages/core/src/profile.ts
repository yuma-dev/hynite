export type ProfileProcess = "main" | "renderer";

export type ProfileSpanStatus = "ok" | "error" | "cancelled";

export type ProfileEvent =
  | {
      kind: "point";
      ts: string;
      elapsedMs: number;
      process: ProfileProcess;
      category: string;
      name: string;
      details?: Record<string, unknown>;
    }
  | {
      kind: "span-start";
      id: string;
      ts: string;
      elapsedMs: number;
      process: ProfileProcess;
      category: string;
      name: string;
      details?: Record<string, unknown>;
    }
  | {
      kind: "span-end";
      id: string;
      ts: string;
      elapsedMs: number;
      durationMs: number;
      process: ProfileProcess;
      category: string;
      name: string;
      status: ProfileSpanStatus;
      details?: Record<string, unknown>;
    };

export type ProfileSpanHandle = {
  id: string;
  end(status?: ProfileSpanStatus, details?: Record<string, unknown>): void;
};

export type ProfileSink = {
  point(category: string, name: string, details?: Record<string, unknown>, process?: ProfileProcess): void;
  startSpan(category: string, name: string, details?: Record<string, unknown>, process?: ProfileProcess): ProfileSpanHandle;
  metric(category: string, name: string, value: number, details?: Record<string, unknown>, process?: ProfileProcess): void;
};

export type TimingStats = {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  slowest: Array<{
    label: string;
    durationMs: number;
    details?: Record<string, unknown>;
  }>;
};

export type ProfileSpanSummary = {
  id: string;
  process: ProfileProcess;
  category: string;
  name: string;
  startedAtElapsedMs: number;
  durationMs: number;
  status: ProfileSpanStatus;
  details?: Record<string, unknown>;
};

export type ProfileCategorySummary = {
  category: string;
  durationMs: number;
  count: number;
  p95Ms: number;
};
