import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { shell } from "electron";
import type {
  EncryptedSecret,
  ExecutableInfo,
  LaunchGameRequest,
  LaunchSession,
  SecretInput,
} from "@hynite/core";

export class NativeBridge {
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
}
