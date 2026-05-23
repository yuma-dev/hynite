import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, extname } from "node:path";
import { shell } from "electron";
import type { LaunchSession } from "@hynite/core";
import type { HyniteRepository } from "@hynite/db";

function isElevationRequired(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as NodeJS.ErrnoException;
  // EACCES = CreateProcess denied; happens when the exe requires UAC elevation.
  return e.code === "EACCES";
}

function spawnElevated(executablePath: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Start-Process uses ShellExecuteEx which surfaces UAC prompts for manifests
    // that request elevation, exactly like double-clicking in Explorer.
    const escaped = executablePath.replace(/'/g, "''");
    const escapedCwd = cwd.replace(/'/g, "''");
    const child = spawn("powershell.exe", [
      "-NonInteractive", "-NoProfile", "-Command",
      `Start-Process -FilePath '${escaped}' -WorkingDirectory '${escapedCwd}'`
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Elevated launch failed (exit code ${code})`));
    });
  });
}

const SHELL_FALLBACK_EXTENSIONS = new Set([".lnk", ".url", ".desktop"]);
const BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

export type LaunchTrackerEvent =
  | { kind: "started"; gameId: string; session: LaunchSession }
  | { kind: "exited"; gameId: string; sessionId: string; minutes: number; exitCode?: number };

export type LaunchTrackerListener = (event: LaunchTrackerEvent) => void;

export class LaunchTracker {
  private readonly listeners = new Set<LaunchTrackerListener>();

  constructor(private readonly repository: HyniteRepository) {}

  on(listener: LaunchTrackerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LaunchTrackerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn("LaunchTracker listener failed", error);
      }
    }
  }

  /**
   * Spawn a local game executable and record playtime when it exits.
   * Basic v1: only watches the directly-spawned process. Games that bootstrap
   * a launcher and exit (EAC, BattlEye, Bethesda) will under-report playtime.
   */
  async spawnAndTrack(gameId: string, executablePath: string, workingDirectory?: string): Promise<LaunchSession> {
    const cwd = workingDirectory ?? dirname(executablePath);
    const ext = extname(executablePath).toLowerCase();
    const startedAt = Date.now();
    const session: LaunchSession = {
      id: randomUUID(),
      startedAt: new Date(startedAt).toISOString()
    };

    const markStarted = (): void => {
      try {
        this.repository.addPlaytime(gameId, 0, session.startedAt);
      } catch (error) {
        console.warn(`Failed to persist local game launch for ${gameId}`, error);
      }
      this.emit({ kind: "started", gameId, session });
    };

    // Shortcut/URL files — must go through the OS shell. We can't track exit, so playtime
    // is recorded only when the user re-launches and the shell handles the resolved target.
    if (SHELL_FALLBACK_EXTENSIONS.has(ext)) {
      const errorMessage = await shell.openPath(executablePath);
      if (errorMessage) {
        const error = new Error(errorMessage) as NodeJS.ErrnoException;
        error.code = "EOPENPATH";
        error.path = executablePath;
        error.syscall = "openPath";
        throw error;
      }
      markStarted();
      return session;
    }

    // Batch files need a shell to interpret them.
    const useShell = BATCH_EXTENSIONS.has(ext);
    const child = spawn(
      executablePath,
      [],
      {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        shell: useShell
      }
    );

    session.pid = child.pid;

    let spawned = false;
    const spawnStarted = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        spawned = true;
        markStarted();
        resolve();
      });
      child.once("error", (error) => {
        console.warn(`Local game launch error for ${gameId}`, error);
        if (!spawned) {
          if (isElevationRequired(error) && process.platform === "win32") {
            // The exe requires admin. Fall back to PowerShell Start-Process which
            // surfaces the UAC prompt, same as double-clicking in Explorer.
            spawnElevated(executablePath, cwd)
              .then(() => { markStarted(); resolve(); })
              .catch(reject);
          } else {
            reject(error);
          }
        }
      });
    });

    child.on("exit", (code) => {
      const minutes = Math.round((Date.now() - startedAt) / 60000);
      try {
        this.repository.addPlaytime(gameId, minutes);
      } catch (error) {
        console.warn(`Failed to persist playtime for ${gameId}`, error);
      }
      this.emit({ kind: "exited", gameId, sessionId: session.id, minutes, exitCode: code ?? undefined });
    });

    child.unref();
    await spawnStarted;
    return session;
  }
}
