import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { shell } from "electron";
import type {
  EncryptedSecret,
  ExecutableInfo,
  LaunchGameRequest,
  LaunchSession,
  SecretInput,
} from "@hynite/core";

type RpcResponse<T> = {
  id?: string;
  result?: T;
  error?: { message: string };
};

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type BridgeLaunchTarget =
  | { kind: "executable"; path: string }
  | { kind: "project"; path: string };

export type NativeSteamAppInfo = {
  appid: number;
  name?: string;
  type?: string;
  parent?: string;
  clienticon?: string;
  icon?: string;
  steamReleaseDate?: string;
  headerImage?: Record<string, string>;
  smallCapsule?: Record<string, string>;
  associations?: Array<{ name?: string; type?: string }>;
  libraryAssetsFull?: {
    libraryCapsule?: { image?: Record<string, string>; image2x?: Record<string, string> };
    libraryHero?: { image?: Record<string, string>; image2x?: Record<string, string> };
    libraryLogo?: { image?: Record<string, string>; image2x?: Record<string, string> };
  };
  libraryAssets?: Record<string, string>;
  storeTags?: Record<string, string>;
  extended?: {
    developer?: string;
    publisher?: string;
    homepage?: string;
  };
  raw?: unknown;
};

export type NativeFileVersionInfo = {
  path: string;
  exists: boolean;
  size?: number;
  productName?: string | null;
  fileDescription?: string | null;
  fileVersion?: string | null;
  productVersion?: string | null;
  companyName?: string | null;
  originalFilename?: string | null;
  internalName?: string | null;
  legalCopyright?: string | null;
  error?: string;
};

export type NativePrefetchLastRunTime = {
  path: string;
  lastRunAt: string | null;
};

export type NativeRunningProcess = {
  path: string;
  pid: number;
  startedAt?: string | null;
};

export class NativeBridge {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly options: { idleTimeoutMs?: number } = {}) {}

  async resolveExecutable(path: string): Promise<ExecutableInfo> {
    return { path, exists: existsSync(path) };
  }

  async launchGame(input: LaunchGameRequest): Promise<LaunchSession> {
    if (input.command?.startsWith("steam://")) {
      await shell.openExternal(input.command);
    } else if (input.executablePath) {
      if (process.platform === "win32") {
        await this.launchWindowsExecutable(input.executablePath, input.workingDirectory);
      } else {
        const errorMessage = await shell.openPath(input.executablePath);
        if (errorMessage) {
          const error = new Error(errorMessage) as NodeJS.ErrnoException;
          error.code = "EOPENPATH";
          error.path = input.executablePath;
          error.syscall = "openPath";
          throw error;
        }
      }
    } else {
      throw new Error("No launch command or executable path is available.");
    }

    return {
      id: randomUUID(),
      startedAt: new Date().toISOString()
    };
  }

  private launchWindowsExecutable(executablePath: string, workingDirectory?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cwd = workingDirectory ?? dirname(executablePath);
      // Escape single quotes for PowerShell single-quoted strings
      const escapedPath = executablePath.replace(/'/g, "''");
      const escapedCwd = cwd.replace(/'/g, "''");
      // Start-Process uses ShellExecuteEx which properly surfaces UAC prompts
      // for executables with elevation manifests, unlike shell.openPath.
      const child = spawn("powershell.exe", [
        "-NonInteractive", "-NoProfile", "-Command",
        `Start-Process -FilePath '${escapedPath}' -WorkingDirectory '${escapedCwd}'`
      ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `Failed to launch executable (exit code ${code})`));
        }
      });
    });
  }

  async openFolder(path: string): Promise<void> {
    await shell.openPath(path);
  }

  async encryptSecret(input: SecretInput): Promise<EncryptedSecret> {
    return {
      cipherText: Buffer.from(input.value, "utf8").toString("base64"),
      scope: input.scope
    };
  }

  async decryptSecret(input: EncryptedSecret): Promise<string> {
    return Buffer.from(input.cipherText, "base64").toString("utf8");
  }

  async getSteamAppInfo(appid: string, language = "english"): Promise<NativeSteamAppInfo | undefined> {
    if (!/^\d+$/.test(appid)) {
      return undefined;
    }

    try {
      return await this.request<NativeSteamAppInfo>("steamGetAppInfo", { appid: Number(appid), language });
    } catch (error) {
      console.warn("Native Steam appinfo failed", error);
      return undefined;
    }
  }

  async pollGamepad(): Promise<{ connected: boolean; pressed: number[] }> {
    try {
      return await this.request<{ connected: boolean; pressed: number[] }>("pollGamepad", {});
    } catch {
      return { connected: false, pressed: [] };
    }
  }

  async getFileVersionInfo(paths: string[]): Promise<NativeFileVersionInfo[]> {
    if (paths.length === 0) {
      return [];
    }
    try {
      const response = await this.request<{ results: NativeFileVersionInfo[] }>("getFileVersionInfo", { paths });
      return response.results ?? [];
    } catch (error) {
      console.warn("Native getFileVersionInfo failed", error);
      return paths.map((path) => ({ path, exists: existsSync(path) }));
    }
  }

  async getPrefetchLastRunTimes(paths: string[]): Promise<NativePrefetchLastRunTime[]> {
    if (paths.length === 0) return [];
    try {
      const response = await this.request<{ results: NativePrefetchLastRunTime[] }>(
        "getPrefetchLastRunTimes", { paths }
      );
      return response.results ?? [];
    } catch (error) {
      console.warn("Native getPrefetchLastRunTimes failed", error);
      return paths.map((path) => ({ path, lastRunAt: null }));
    }
  }

  async getRunningProcesses(paths: string[]): Promise<NativeRunningProcess[]> {
    if (paths.length === 0) return [];
    try {
      const response = await this.request<{ results: NativeRunningProcess[] }>(
        "getRunningProcesses", { paths }
      );
      return response.results ?? [];
    } catch (error) {
      console.warn("Native getRunningProcesses failed", error);
      return [];
    }
  }

  dispose(): void {
    this.clearIdleTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Native bridge disposed."));
    }
    this.pending.clear();
    this.buffer = "";
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = undefined;
  }

  getProcessInfo(): { pid?: number; running: boolean } {
    return {
      pid: this.process?.pid,
      running: Boolean(this.process && !this.process.killed)
    };
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const child = this.ensureProcess();
    this.clearIdleTimer();
    const id = randomUUID();
    return new Promise<T>((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native bridge request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: resolveRequest as (value: unknown) => void, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, "utf8", (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(id);
          }
          reject(error);
        }
      });
    }).finally(() => {
      this.scheduleIdleDispose();
    });
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) {
      return this.process;
    }

    const target = this.findBridgeLaunchTarget();
    const child = target.kind === "executable"
      ? spawn(target.path, [], {
          cwd: dirname(target.path),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        })
      : spawn("dotnet", ["run", "--project", target.path], {
          cwd: dirname(target.path),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => console.warn("Native bridge:", chunk.trim()));
    child.on("exit", () => {
      this.clearIdleTimer();
      this.process = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Native bridge exited."));
      }
      this.pending.clear();
    });

    this.process = child;
    return child;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleDispose(): void {
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 60_000;
    if (idleTimeoutMs <= 0 || this.pending.size > 0 || !this.process || this.process.killed) {
      return;
    }

    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.pending.size === 0) {
        this.dispose();
      }
    }, idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let lineEnd = this.buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (line) {
        this.handleResponse(line);
      }
      lineEnd = this.buffer.indexOf("\n");
    }
  }

  private handleResponse(line: string): void {
    let response: RpcResponse<unknown>;
    try {
      response = JSON.parse(line) as RpcResponse<unknown>;
    } catch {
      console.warn("Native bridge returned non-JSON output", line);
      return;
    }

    if (!response.id) {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private findBridgeLaunchTarget(): BridgeLaunchTarget {
    // Only look for a pre-built exe when packaged; in dev the SDK is used via dotnet run.
    const executableCandidates = [
      join(process.resourcesPath ?? "", "native/Hynite.NativeBridge/Hynite.NativeBridge.exe")
    ];

    const executablePath = executableCandidates.find((candidate) => existsSync(candidate));
    if (executablePath) {
      return { kind: "executable", path: executablePath };
    }

    const projectCandidates = [
      resolve(process.cwd(), "native/Hynite.NativeBridge/Hynite.NativeBridge.csproj"),
      resolve(__dirname, "../../../native/Hynite.NativeBridge/Hynite.NativeBridge.csproj"),
      resolve(__dirname, "../../native/Hynite.NativeBridge/Hynite.NativeBridge.csproj"),
      join(process.resourcesPath ?? "", "native/Hynite.NativeBridge/Hynite.NativeBridge.csproj")
    ];

    const projectPath = projectCandidates.find((candidate) => existsSync(candidate));
    if (!projectPath) {
      throw new Error("Could not find Hynite.NativeBridge executable or project.");
    }

    return { kind: "project", path: projectPath };
  }
}
