import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type DiagnosticLogEntry = {
  level: "info" | "warning" | "error";
  phase: string;
  message: string;
  details?: Record<string, unknown>;
};

export class DiagnosticLogService {
  private queue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  log(entry: DiagnosticLogEntry): void {
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    })}\n`;

    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
      })
      .catch((error: unknown) => {
        console.warn("Failed to write metadata diagnostics", error);
      });
  }
}
