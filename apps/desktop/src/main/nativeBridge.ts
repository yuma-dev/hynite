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
};

export class NativeBridge {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest<unknown>>();

  async resolveExecutable(path: string): Promise<ExecutableInfo> {
    return { path, exists: existsSync(path) };
  }

  async launchGame(input: LaunchGameRequest): Promise<LaunchSession> {
    if (input.command?.startsWith("steam://")) {
      await shell.openExternal(input.command);
    } else if (input.executablePath) {
      await shell.openPath(input.executablePath);
    } else {
      throw new Error("No launch command or executable path is available.");
    }

    return {
      id: randomUUID(),
      startedAt: new Date().toISOString()
    };
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

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const child = this.ensureProcess();
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
    });
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) {
      return this.process;
    }

    const projectPath = this.findBridgeProject();
    const child = spawn("dotnet", ["run", "--project", projectPath], {
      cwd: dirname(projectPath),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => console.warn("Native bridge:", chunk.trim()));
    child.on("exit", () => {
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

  private findBridgeProject(): string {
    const candidates = [
      resolve(process.cwd(), "native/Hynite.NativeBridge/Hynite.NativeBridge.csproj"),
      resolve(__dirname, "../../../native/Hynite.NativeBridge/Hynite.NativeBridge.csproj"),
      resolve(__dirname, "../../native/Hynite.NativeBridge/Hynite.NativeBridge.csproj"),
      join(process.resourcesPath ?? "", "native/Hynite.NativeBridge/Hynite.NativeBridge.csproj")
    ];

    const projectPath = candidates.find((candidate) => existsSync(candidate));
    if (!projectPath) {
      throw new Error("Could not find Hynite.NativeBridge project.");
    }

    return projectPath;
  }
}
