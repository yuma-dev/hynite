import type { HyniteApi } from "../preload";
import type { AppSettings, SettingsBackupInfo } from "@hynite/core";

declare global {
  interface Window {
    hynite: HyniteApi;
    hyniteDebugSplash?: (durationMs?: number) => void;
    __hyniteSettings?: {
      list(): Promise<SettingsBackupInfo[]>;
      restore(id: string): Promise<AppSettings>;
    };
  }
}

export {};
