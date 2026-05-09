import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type StartupProfileScope = "main" | "renderer";

export type StartupProfileEntry = {
  scope: StartupProfileScope;
  phase: string;
  message: string;
  details?: Record<string, unknown>;
  rendererElapsedMs?: number;
};

export class StartupProfileService {
  readonly enabled: boolean;
  private readonly startedAt = performance.now();

  constructor(private readonly filePath: string) {
    this.enabled = process.env.HYNITE_STARTUP_PROFILE === "1" || process.env.HYNITE_STARTUP_PROFILE === "true";
  }

  log(entry: StartupProfileEntry): void {
    if (!this.enabled) {
      return;
    }

    const elapsedMs = Math.round((performance.now() - this.startedAt) * 10) / 10;
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      elapsedMs,
      ...entry
    })}\n`;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line, "utf8");
      console.log(`[startup-profile +${elapsedMs}ms] ${entry.scope} ${entry.phase}: ${entry.message}`);
    } catch (error) {
      console.warn("Failed to write startup profile", error);
    }
  }
}
