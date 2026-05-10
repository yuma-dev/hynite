import type { HyniteApi } from "../preload";

declare global {
  interface Window {
    hynite: HyniteApi;
    hyniteDebugSplash?: (durationMs?: number) => void;
  }
}

export {};
