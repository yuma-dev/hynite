import type { HyniteApi } from "../preload";

declare global {
  interface Window {
    hynite: HyniteApi;
  }
}

export {};

