import type { HyniteApi } from "../preload";
import type { AppSettings, SettingsBackupInfo } from "@hynite/core";

declare global {
  /** Injected at build time by electron.vite.config.ts from apps/desktop package.json. */
  const __APP_VERSION__: string;

  interface Window {
    hynite: HyniteApi;
    hyniteDebugSplash?: (durationMs?: number) => void;
    /** TEMPORARY GlitchTip pipeline test — remove before next release. */
    __hyniteTestCrash?: (mode?: "captured" | "throw") => string | void;
    __hyniteSettings?: {
      list(): Promise<SettingsBackupInfo[]>;
      restore(id: string): Promise<AppSettings>;
    };
  }
}

export {};
