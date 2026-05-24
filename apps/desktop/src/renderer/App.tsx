import { AnimatePresence, motion } from "framer-motion";
import Hls from "hls.js";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bug,
  ChevronDown,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Check,
  Clock3,
  Crop,
  Download,
  ExternalLink,
  Film,
  Folder,
  FolderOpen,
  Globe2,
  HardDrive,
  Home,
  Images,
  Info,
  KeyRound,
  Library,
  Link2,
  LogOut,
  Maximize2,
  Minimize2,
  Minus,
  Monitor,
  Music2,
  Pencil,
  Play,
  Plus,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Trophy,
  Tv,
  Users,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import { memo, Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { defaultHomeLayout, defaultLibraryView, defaultWishlistView, gameActivityTime, makeGameId, makeSortTitle, resolveLaunchableSteamAccounts, type AppSettings, type BackgroundWorkload, type ControllerActionId, type ControllerButtonBinding, type ControllerSettings, type DownloadSourceInfo, type Game, type GameAssetCandidate, type GameAssetKind, type GameAssetProvider, type GameAssetUpdate, type GameDetail, type GameGroup, type HomeLayout, type HomeModel, type HomeModule, type InstallState, type LibraryDateFilter, type LibraryFilters, type LibraryOwnership, type LibrarySortField, type LibrarySortDirection, type LibraryView, type ManualGameGroup, type MusicSettings, type OnboardingState, type PlayerMode, type ProviderId, type SettingsBackupInfo, type SettingsHealthWarning, type SoundEffectId, type SoundEffectPlayback, type SoundEffectSettings, type SoundSettings, type SourceExactMatch, type SourceImportResult, type SourceMatch, type SpotlightState, type SteamAccountSettings, type SteamLocalAccount, type SteamSearchResult, type SteamStoreEmbedInfo, type SteamWishlistItem, type SyncStatus, type WishlistSortField, type WishlistView, type WishlistViewMode } from "@hynite/core";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { adjustCardsPerRow, AddModuleButton, HomeEditBar, HomeEmptyState, HomeGridBlock, ModuleConfigPanel, ModuleEditChrome, SortableModule, newDraftModule, resolveLayout, resolveModuleGames, type HomeResolveContext } from "./homeModules";
import { isProfileEnabled, profileImageError, profileImageStart, profilePoint, profileSpan, profileStartup } from "./startupProfile";
import { profileReactRender, startRuntimeFrameProfiler, startRuntimeInteraction, updateRuntimeProfileContext } from "./runtimeFrameProfile";
import { LocalGamesScreen } from "./LocalGamesScreen";
import { BigPictureScreen } from "./BigPictureScreen";
import { OnboardingExperience } from "./onboarding/OnboardingExperience";
import { normalizeSoundSettings, soundEngine, SOUND_EFFECT_DEFINITIONS } from "./sound";
import { musicEngine, normalizeMusicSettings, type MusicStatus } from "./music";
import { bindingLabel, bindingPressed, controllerBindingOrder, CONTROLLER_ACTION_HELP, CONTROLLER_ACTION_LABELS, firstPressedBinding, normalizeControllerSettings, pressedButtonIndexes, readGamepadState } from "./controllerInput";
import { acceleratorFromHotkeyInput } from "../shared/hotkey";
import type { LaunchOutcome, UpdaterStatus } from "../preload";
import { reportLaunchFailure } from "./observability";
import logo64Url from "../../../../assets/icons/logo-64.png?url";
import logo128Url from "../../../../assets/icons/logo-128.png?url";
import logo256Url from "../../../../assets/icons/logo-256.png?url";
import logo1024Url from "../../../../assets/icons/logo-1024.png?url";

type SteamSwitchPrompt = {
  gameId: string;
  gameTitle: string;
  fromLabel: string;
  toLabel: string;
  targetSteamId: string;
  resolve: (confirmed: boolean) => void;
};

type LaunchGameInput = string | Game | GameDetail;

type LaunchGameEventDetail = {
  id: string;
  game?: Game | GameDetail;
  preferredSteamId?: string;
  handled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type LaunchHandoffState = {
  token: number;
  game: Game | GameDetail;
  backgroundUrl?: string;
  logoUrl?: string;
  reduceMotion: boolean;
};

type LaunchFailureOutcome = Extract<LaunchOutcome, { kind: "launch-failed" }>;
type LaunchFailurePromptState = LaunchFailureOutcome & {
  reportStatus?: "idle" | "sending" | "sent" | "failed";
  reportEventId?: string;
  reportError?: string;
};

const STEAM_SWITCH_CONFIRM_EVENT = "hynite:steam-switch-confirm";
const LAUNCH_GAME_EVENT = "hynite:launch-game";
const LAUNCH_FAILURE_EVENT = "hynite:launch-failure";
const TRAILER_AUDIO_STORAGE_KEY = "hynite:trailer-audio:v1";
const TWITCH_DEVELOPER_APPS_URL = "https://dev.twitch.tv/console/apps";
const LAUNCH_HANDOFF_PREVIEW_MS = 1800;
const LAUNCH_HANDOFF_REDUCED_PREVIEW_MS = 450;
const LAUNCH_HANDOFF_MAX_MS = 40_000;

function readTrailerAudioState(): { volume: number; muted: boolean } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TRAILER_AUDIO_STORAGE_KEY) ?? "{}") as { volume?: unknown; muted?: unknown };
    const volume = typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
      ? Math.min(1, Math.max(0, parsed.volume))
      : 1;
    return { volume, muted: parsed.muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

function writeTrailerAudioState(value: { volume: number; muted: boolean }): void {
  try {
    window.localStorage.setItem(TRAILER_AUDIO_STORAGE_KEY, JSON.stringify({
      volume: Math.min(1, Math.max(0, value.volume)),
      muted: value.muted
    }));
  } catch {
    // Ignore storage failures; trailer controls still work for the current element.
  }
}

function homeDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem("hynite:homeDebug") === "1";
  } catch {
    return false;
  }
}

function homeDebug(message: string, details?: Record<string, unknown>): void {
  if (homeDebugEnabled()) {
    console.info(`[home] ${message}`, details ?? {});
  }
}

function homeHasDiscoveryContent(home: HomeModel | undefined): boolean {
  return Boolean(home && home.popularNow.length > 0);
}

function requestSteamSwitchConfirmation(prompt: Omit<SteamSwitchPrompt, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    const detail = { ...prompt, handled: false, resolve };
    window.dispatchEvent(new CustomEvent(STEAM_SWITCH_CONFIRM_EVENT, { detail }));
    if (!detail.handled) {
      resolve(false);
    }
  });
}

function dispatchLaunchFailure(failure: LaunchFailureOutcome): void {
  window.dispatchEvent(new CustomEvent(LAUNCH_FAILURE_EVENT, { detail: failure }));
}

function launchFailureFromCaughtError(gameId: string, error: unknown): LaunchFailureOutcome {
  return {
    kind: "launch-failed",
    gameId,
    message: "Hynite could not start this game.",
    technicalMessage: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

async function runLaunchFlow(id: string, preferredSteamId?: string): Promise<boolean> {
  let result: LaunchOutcome;
  try {
    result = await window.hynite.games.launch(id, preferredSteamId);
  } catch (error) {
    dispatchLaunchFailure(launchFailureFromCaughtError(id, error));
    return false;
  }
  if (result.kind === "launched") {
    soundEngine.play("gameLaunch");
    musicEngine.onGameLaunch();
    return true;
  }
  if (result.kind === "launch-failed") {
    dispatchLaunchFailure(result);
    return false;
  }
  if (result.kind === "no-account") {
    window.alert(result.reason);
    return false;
  }
  if (result.kind === "requires-switch") {
    const fromLabel = result.currentAccountName ?? "the currently active account";
    const toLabel = result.target.personaName
      ? `${result.target.personaName} (${result.target.accountName})`
      : result.target.accountName;
    const confirmed = await requestSteamSwitchConfirmation({
      gameId: result.gameId,
      gameTitle: result.gameTitle,
      fromLabel,
      toLabel,
      targetSteamId: result.target.steamId
    });
    if (!confirmed) return false;
    let switchResult: LaunchOutcome;
    try {
      switchResult = await window.hynite.steam.switchAndLaunch(result.gameId, result.target.steamId);
    } catch (error) {
      dispatchLaunchFailure(launchFailureFromCaughtError(result.gameId, error));
      return false;
    }
    if (switchResult.kind === "launched") {
      soundEngine.play("gameLaunch");
      musicEngine.onGameLaunch();
      return true;
    }
    if (switchResult.kind === "launch-failed") {
      dispatchLaunchFailure(switchResult);
      return false;
    }
    if (switchResult.kind === "no-account") {
      window.alert(switchResult.reason);
    }
  }
  return false;
}

function launchInputId(input: LaunchGameInput): string {
  return typeof input === "string" ? input : input.id;
}

async function launchGame(input: LaunchGameInput, preferredSteamId?: string): Promise<void> {
  const id = launchInputId(input);
  const game = typeof input === "string" ? undefined : input;
  const handledPromise = new Promise<void>((resolve, reject) => {
    const detail: LaunchGameEventDetail = {
      id,
      game,
      preferredSteamId,
      handled: false,
      resolve,
      reject
    };
    window.dispatchEvent(new CustomEvent(LAUNCH_GAME_EVENT, { detail }));
    if (!detail.handled) {
      void runLaunchFlow(id, preferredSteamId).then(() => resolve()).catch(reject);
    }
  });
  return handledPromise;
}

type Route = "home" | "steam" | "library" | "wishlist" | "search" | "local" | "settings";

type RailIcon = ComponentType<{ size?: string | number; className?: string }>;

function BootstrapSteamIcon({ size = 17, className }: { size?: string | number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      fill="currentColor"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M.329 10.333A8.01 8.01 0 0 0 7.99 16C12.414 16 16 12.418 16 8s-3.586-8-8.01-8A8.006 8.006 0 0 0 0 7.468l4.412 1.823A2.198 2.198 0 0 1 5.7 8.95l1.993-2.89v-.04a3.046 3.046 0 0 1 3.042-3.043 3.046 3.046 0 0 1 3.042 3.043 3.047 3.047 0 0 1-3.111 3.043l-2.85 2.034a2.2 2.2 0 0 1-4.285.62L.329 10.333Z" />
      <path d="M4.868 12.683a1.715 1.715 0 0 0 1.318-3.165 1.705 1.705 0 0 0-1.263-.02l1.023.424a1.261 1.261 0 1 1-.97 2.33l-1.015-.42a1.705 1.705 0 0 0 1.907.85Zm7.705-6.664a1.837 1.837 0 0 0-1.835-1.834 1.837 1.837 0 0 0-1.835 1.834 1.837 1.837 0 0 0 1.835 1.835 1.837 1.837 0 0 0 1.835-1.835Zm-3.21 0a1.377 1.377 0 1 1 2.754 0 1.377 1.377 0 0 1-2.754 0Z" />
    </svg>
  );
}

const routes: Array<{ id: Route; label: string; icon: RailIcon }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "steam", label: "Steam", icon: BootstrapSteamIcon },
  { id: "library", label: "Library", icon: Library },
  { id: "wishlist", label: "Wishlist", icon: CalendarDays },
  { id: "search", label: "Search", icon: Search },
  { id: "local", label: "Add games", icon: Plus },
  { id: "settings", label: "Settings", icon: Settings }
];

const HERO_AUTOPLAY_MS = 9000;
const HOME_REFRESH_DEBOUNCE_MS = 250;
const HOME_STALE_RETRY_DELAY_MS = 2000;
const HOME_STALE_RETRY_MAX = 1;
const HOME_DISCOVERY_LOADING_MAX_MS = 15_000;
const HOME_DETAIL_INTENT_PREFETCH_DELAY_MS = 150;
const HOME_ROW_BATCH_SIZE = 12;
const HOME_ROW_STEP_ITEMS = 3;
const LIBRARY_GRID_INITIAL_SIZE = 48;
const LIBRARY_GRID_BATCH_SIZE = 24;
const DEFAULT_CARDS_PER_ROW = 6;
const MIN_CARDS_PER_ROW = 4;
const MAX_CARDS_PER_ROW = 12;
const DOWNLOAD_MATCH_BATCH_SIZE = 20;
const DOWNLOAD_MATCH_SEARCH_LIMIT = 500;
const sourceAvailabilityCache = new Map<string, SourceExactMatch[]>();

function BrandLogo({ className, sizes }: { className?: string; sizes: string }) {
  return (
    <img
      className={className}
      src={logo128Url}
      srcSet={`${logo64Url} 64w, ${logo128Url} 128w, ${logo256Url} 256w`}
      sizes={sizes}
      alt="Hynite"
      draggable={false}
    />
  );
}

function TitleBar({ onEnterBigPicture }: { onEnterBigPicture: () => void }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.hynite.window.isMaximized().then(setMaximized);
    return window.hynite.window.onMaximizeChanged(setMaximized);
  }, []);

  return (
    <header className="titlebar">
      <span className="titlebar-drag" />
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          tabIndex={-1}
          onClick={onEnterBigPicture}
          aria-label="Big Picture mode (F11)"
          title="Big Picture (F11)"
        >
          <Tv size={13} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          tabIndex={-1}
          onClick={() => void window.hynite.window.minimize()}
          aria-label="Minimize"
        >
          <Minus size={11} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          tabIndex={-1}
          onClick={() => void window.hynite.window.maximize()}
          aria-label={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
        </button>
        <button
          type="button"
          className="titlebar-btn close"
          tabIndex={-1}
          onClick={() => void window.hynite.window.close()}
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </div>
    </header>
  );
}

function StartupLoading() {
  return <main className="startup-screen" />;
}

function ProfileScope({ id, children }: { id: string; children: ReactNode }) {
  if (!isProfileEnabled()) {
    return <>{children}</>;
  }
  return (
    <Profiler id={id} onRender={profileReactRender}>
      {children}
    </Profiler>
  );
}

function fallbackArt(game: Game): CSSProperties {
  const seed = [...game.title].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const hue = seed % 360;
  return {
    "--cover-a": `oklch(0.48 0.12 ${hue})`,
    "--cover-b": `oklch(0.2 0.08 ${(hue + 80) % 360})`
  } as CSSProperties;
}

function isVerifiedVerticalCoverUrl(value: string | undefined): boolean {
  return Boolean(value && (/(?:\/|%2f)library_(?:600x900|capsule)(?:_2x)?\.(?:jpg|png|webp)(?:\?|$)/i.test(value) || /steamgriddb\.com\/grid\//i.test(value)));
}

function steamLibraryCapsuleGuess(game: Game): string | undefined {
  const appId = game.sourceIds.find((s) => s.provider === "steam")?.externalId;
  if (!appId) return undefined;
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}

function primaryCover(game: Game, options: { allowDisplayFallback?: boolean } = {}): string | undefined {
  const verticalCover = game.libraryCapsuleUrl ?? (isVerifiedVerticalCoverUrl(game.coverUrl) ? game.coverUrl : undefined);
  if (verticalCover) {
    return verticalCover;
  }

  // Steam discovery results (popularNow/recommended/newAndNotable) often arrive with only headerUrl.
  // Try the standard CDN path for a vertical capsule first — most popular games have it.
  // If it 404s the gradient fallback shows, which still looks better than a stretched banner.
  if (!options.allowDisplayFallback) {
    return undefined;
  }
  return steamLibraryCapsuleGuess(game)
    ?? game.headerUrl
    ?? game.backgroundUrl
    ?? game.trailerPosterUrl
    ?? game.screenshots[0]?.thumbnailUrl
    ?? game.screenshots[0]?.fullUrl;
}

function heroStill(game: Game): string | undefined {
  return game.headerUrl ?? game.trailerPosterUrl ?? game.screenshots[0]?.fullUrl ?? game.backgroundUrl;
}

function launchHandoffBackground(game: Game | GameDetail): string | undefined {
  return game.backgroundUrl ?? game.headerUrl ?? game.trailerPosterUrl ?? game.screenshots[0]?.fullUrl ?? primaryCover(game);
}

function loadSplashAsset(url: string | undefined, role: "launch-handoff-background" | "launch-handoff-logo", game?: Game | GameDetail): Promise<string | undefined> {
  if (!url) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    const span = profileImageStart(url, { role, gameId: game?.id, title: game?.title, lazy: false });
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      const decoded = typeof image.decode === "function" ? image.decode() : Promise.resolve();
      void decoded.then(() => {
        span.end("ok", { role, gameId: game?.id, title: game?.title, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
        resolve(url);
      }).catch((error: unknown) => {
        span.end("ok", { role, gameId: game?.id, title: game?.title, decodeError: error instanceof Error ? error.message : String(error) });
        resolve(url);
      });
    };
    image.onerror = () => {
      profileImageError(url, { role, gameId: game?.id, title: game?.title, lazy: false });
      span.end("error", { role, gameId: game?.id, title: game?.title });
      resolve(undefined);
    };
    image.src = url;
  });
}

async function loadLaunchHandoffAssets(game: Game | GameDetail): Promise<{ backgroundUrl?: string; logoUrl?: string }> {
  const span = profileSpan("renderer-assets", "renderer-assets:launch-handoff-assets", { gameId: game.id, title: game.title });
  const [backgroundUrl, logoUrl] = await Promise.all([
    loadSplashAsset(launchHandoffBackground(game), "launch-handoff-background", game),
    loadSplashAsset(game.logoUrl, "launch-handoff-logo", game)
  ]);
  span.end("ok", { gameId: game.id, title: game.title, hasBackground: Boolean(backgroundUrl), hasLogo: Boolean(logoUrl) });
  return { backgroundUrl, logoUrl };
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setPrefersReducedMotion(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return prefersReducedMotion;
}

function LaunchHandoffOverlay({ state }: { state: LaunchHandoffState }) {
  const reduced = state.reduceMotion;
  const backgroundStyle = state.backgroundUrl ? { backgroundImage: `url(${state.backgroundUrl})` } : undefined;

  return (
    <motion.div
      className={reduced ? "launch-handoff reduce-motion" : "launch-handoff"}
      style={fallbackArt(state.game)}
      aria-hidden="true"
      initial={reduced ? { opacity: 0 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0.08 : 0.18, ease: "easeOut" }}
    >
      <div className="launch-handoff-bg launch-handoff-bg-blur" style={backgroundStyle} />
      <motion.div
        className="launch-handoff-bg launch-handoff-bg-main"
        style={backgroundStyle}
        initial={reduced ? false : { opacity: 0.2, scale: 1.045 }}
        animate={reduced ? { opacity: 0.84 } : { opacity: 0.88, scale: 1 }}
        transition={{ duration: reduced ? 0.01 : 1.25, ease: "easeOut" }}
      />
      <div className="launch-handoff-tint" />
      <motion.div
        className="launch-handoff-identity"
        initial={reduced ? false : { opacity: 0, scale: 0.965, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: reduced ? 0.01 : 0.32, ease: "easeOut", delay: reduced ? 0 : 0.08 }}
      >
        {state.logoUrl ? (
          <img className="launch-handoff-logo" src={state.logoUrl} alt="" draggable={false} />
        ) : (
          <h1>{state.game.title}</h1>
        )}
        <span className="launch-handoff-line">
          <span />
        </span>
      </motion.div>
    </motion.div>
  );
}

function plainSummary(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const text = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  return text || undefined;
}

function heroDescription(game: Game): string | undefined {
  return plainSummary(game.shortDescription) ?? plainSummary(game.aboutText);
}

type ImageViewerItem = {
  url: string;
  label: string;
};

type AssetFitMode = "contain" | "crop";

const ASSET_SLOTS: Array<{ kind: GameAssetKind; label: string; ratio: string; className: string }> = [
  { kind: "grid", label: "Grid", ratio: "2:3", className: "grid" },
  { kind: "hero", label: "Hero", ratio: "16:9", className: "hero" },
  { kind: "logo", label: "Logo", ratio: "transparent", className: "logo" },
  { kind: "icon", label: "Icon", ratio: "1:1", className: "icon" },
  { kind: "header", label: "Header", ratio: "16:9", className: "header" },
  { kind: "poster", label: "Poster", ratio: "16:9", className: "poster" }
];

const ASSET_PROVIDERS: Array<{ provider: GameAssetProvider | "all"; label: string }> = [
  { provider: "all", label: "All" },
  { provider: "current", label: "Current" },
  { provider: "steamgriddb", label: "SteamGridDB" },
  { provider: "steam", label: "Steam" },
  { provider: "igdb", label: "IGDB" },
  { provider: "custom", label: "Custom" }
];

function assetSlot(kind: GameAssetKind) {
  return ASSET_SLOTS.find((slot) => slot.kind === kind) ?? ASSET_SLOTS[0]!;
}

function gameAssetUrl(game: Game, kind: GameAssetKind): string | undefined {
  if (kind === "grid") return game.libraryCapsuleUrl ?? game.coverUrl;
  if (kind === "hero") return game.backgroundUrl;
  if (kind === "logo") return game.logoUrl;
  if (kind === "icon") return game.communityIconUrl;
  if (kind === "header") return game.headerUrl;
  return game.trailerPosterUrl;
}

function providerLabel(provider: GameAssetProvider): string {
  return ASSET_PROVIDERS.find((entry) => entry.provider === provider)?.label ?? provider;
}

function outputSizeForAsset(kind: GameAssetKind): { width: number; height: number } {
  if (kind === "grid") return { width: 600, height: 900 };
  if (kind === "icon") return { width: 512, height: 512 };
  if (kind === "logo") return { width: 960, height: 360 };
  return { width: 1920, height: 1080 };
}

function loadImageForCrop(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be loaded for cropping."));
    image.src = url;
  });
}

async function cropAssetToDataUrl(url: string, kind: GameAssetKind, crop: { x: number; y: number; zoom: number }): Promise<string> {
  const image = await loadImageForCrop(url);
  const { width, height } = outputSizeForAsset(kind);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is unavailable.");
  }
  context.clearRect(0, 0, width, height);
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * crop.zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const spareX = Math.max(0, drawWidth - width);
  const spareY = Math.max(0, drawHeight - height);
  const offsetX = (crop.x / 100) * spareX;
  const offsetY = (crop.y / 100) * spareY;
  const x = (width - drawWidth) / 2 - offsetX;
  const y = (height - drawHeight) / 2 - offsetY;
  context.drawImage(image, x, y, drawWidth, drawHeight);
  return canvas.toDataURL(kind === "grid" || kind === "header" || kind === "hero" || kind === "poster" ? "image/jpeg" : "image/png", 0.92);
}

function formatHours(minutes?: number): string {
  if (!minutes) {
    return "No playtime";
  }

  return `${Math.round(minutes / 60)}h played`;
}

function formatCompactPlaytime(minutes?: number): string {
  if (!minutes) {
    return "0h";
  }
  return `${Math.round(minutes / 60)}h`;
}

function formatRelativeAgo(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;

  if (elapsedMs < minute) return "now";
  if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}m ago`;
  if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}h ago`;
  if (elapsedMs < month) return `${Math.floor(elapsedMs / day)}d ago`;
  if (elapsedMs < year) return `${Math.floor(elapsedMs / month)}mo ago`;
  return `${Math.floor(elapsedMs / year)}y ago`;
}

function formatCoverActivity(game: Game): string {
  const playtime = formatCompactPlaytime(game.playtimeMinutes);
  const lastPlayed = formatRelativeAgo(game.lastPlayedAt);
  return lastPlayed ? `${lastPlayed} - ${playtime}` : formatHours(game.playtimeMinutes);
}

function formatNumber(value?: number): string {
  return value === undefined ? "Unknown" : value.toLocaleString();
}

function formatDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function twoDigit(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUploadedAt(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return [
    `${twoDigit(parsed.getDate())}.${twoDigit(parsed.getMonth() + 1)}.${twoDigit(parsed.getFullYear() % 100)}`,
    `${twoDigit(parsed.getHours())}:${twoDigit(parsed.getMinutes())}`
  ].join(" ");
}

function steamStoreUrl(game: Game): string | undefined {
  const steamId = game.sourceIds.find((source) => source.provider === "steam")?.externalId;
  return game.discovery?.storeUrl ?? (steamId ? `https://store.steampowered.com/app/${encodeURIComponent(steamId)}` : undefined);
}

function gameFromSteamSearchResult(result: SteamSearchResult): Game {
  return {
    id: makeGameId("steam", result.appId),
    title: result.title,
    sortTitle: makeSortTitle(result.title),
    sourceIds: [{ provider: "steam", externalId: result.appId }],
    installState: "not_installed",
    headerUrl: result.capsuleUrl,
    screenshots: [],
    shortDescription: result.reviewSummary,
    contentDescriptors: [],
    discovery: {
      score: 0,
      signal: "Steam Store",
      priceText: result.price,
      storeUrl: `https://store.steampowered.com/app/${encodeURIComponent(result.appId)}/`,
      sources: ["Steam Store"]
    },
    genres: [],
    tags: [],
    playerModes: [],
    developers: [],
    publishers: [],
    releaseDate: result.releaseDate,
    metadataStatus: "partial"
  };
}

function openExternalUrl(url?: string): void {
  if (!url || url.startsWith("#")) {
    return;
  }

  try {
    const parsed = new URL(url, "https://store.steampowered.com");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      void window.hynite.native.openExternal(parsed.toString()).catch(console.error);
    }
  } catch {
    // Ignore malformed provider links.
  }
}

type SteamWebviewElement = HTMLElement & {
  reload(): void;
  loadURL(url: string): void;
  insertCSS(css: string): Promise<string>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
};

const STEAM_STORE_THEME_CSS = `
  html,
  body,
  body.v6,
  .responsive_page_frame,
  .responsive_page_content,
  .responsive_page_template_content {
    background: #050608 !important;
  }

  body,
  input,
  textarea,
  select,
  button {
    font-family: Inter, "Segoe UI", Arial, sans-serif !important;
  }

  ::-webkit-scrollbar {
    width: 8px !important;
    height: 8px !important;
  }

  ::-webkit-scrollbar-track {
    background: transparent !important;
  }

  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.22) !important;
    border-radius: 999px !important;
  }

  #global_header,
  .banner_open_in_steam {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
    min-height: 0 !important;
    max-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
  }

  #store_header,
  .responsive_header {
    background: rgba(5, 6, 8, 0.96) !important;
    box-shadow: none !important;
  }

  .home_page_gutter,
  .home_ctn,
  .page_content_ctn,
  .search_results,
  .tab_content_ctn {
    background-color: #050608 !important;
  }

  .home_cluster_ctn,
  .home_ctn.tab_container {
    background: none !important;
    background-color: transparent !important;
    box-shadow: none !important;
  }

  .btnv6_blue_hoverfade,
  .btn_green_steamui,
  .btn_blue_steamui,
  .btn_medium {
    border-radius: 8px !important;
  }
`;

const STEAM_STORE_PREPARE_JS = `
(() => {
  const selectors = "#global_header, .banner_open_in_steam";
  const removeSteamChrome = () => {
    document.querySelectorAll(selectors).forEach((node) => node.remove());
  };
  removeSteamChrome();
  if (!window.__hyniteSteamChromeObserverInstalled && document.documentElement) {
    window.__hyniteSteamChromeObserverInstalled = true;
    new MutationObserver(removeSteamChrome).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
`;

async function prepareSteamStoreWebview(webview: SteamWebviewElement): Promise<void> {
  await webview.insertCSS(STEAM_STORE_THEME_CSS);
  await webview.executeJavaScript(STEAM_STORE_PREPARE_JS, false).catch(() => undefined);
}

function isSteamEmbedNavigationAllowed(url?: string): boolean {
  if (!url || url === "about:blank") {
    return true;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host === "steampowered.com" ||
      host.endsWith(".steampowered.com") ||
      host === "steamcommunity.com" ||
      host.endsWith(".steamcommunity.com")
    );
  } catch {
    return false;
  }
}

const markdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          if (!href) {
            return;
          }
          event.preventDefault();
          openExternalUrl(href);
        }}
      >
        {children}
      </a>
    );
  },
  img({ node: _node, src, alt }) {
    return src ? <img src={src} alt={alt ?? ""} loading="lazy" /> : null;
  }
};

function RichDescription({ value }: { value: string }) {
  return (
    <div className="rich-description">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={markdownComponents}>
        {value}
      </ReactMarkdown>
    </div>
  );
}

function activityLabel(game: Game): string {
  const played = Date.parse(game.lastPlayedAt ?? "") || 0;
  const added = Date.parse(game.addedAt ?? "") || 0;
  if (played >= added && played > 0) {
    const today = new Date().toDateString();
    const date = new Date(played);
    return date.toDateString() === today ? "Played today" : `Played ${formatDate(date.toISOString())}`;
  }

  if (added > 0) {
    return `Added ${formatDate(game.addedAt)}`;
  }

  return formatHours(game.playtimeMinutes);
}

function canLaunch(game: Game): boolean {
  return game.installState === "installed" || game.sourceIds.some((source) => source.provider === "steam");
}

function normalizeLibraryView(view?: LibraryView): LibraryView {
  return {
    filters: {
      ...defaultLibraryView.filters,
      ...(view?.filters ?? {})
    },
    sort: {
      ...defaultLibraryView.sort,
      ...(view?.sort ?? {})
    }
  };
}

function normalizeWishlistView(view?: WishlistView): WishlistView {
  return {
    sort: {
      ...defaultWishlistView.sort,
      ...(view?.sort ?? {})
    }
  };
}

function normalizeGroups(settings?: AppSettings): GameGroup[] {
  return settings?.gameGroups ?? [];
}

function normalizeCardsPerRow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_CARDS_PER_ROW, Math.max(MIN_CARDS_PER_ROW, Math.round(value)))
    : DEFAULT_CARDS_PER_ROW;
}

function cardGridStyle(cardsPerRow: number): CSSProperties {
  const normalized = normalizeCardsPerRow(cardsPerRow);
  return {
    "--cards-per-row": normalized,
    "--row-card-width": `max(96px, calc((100% - ${(normalized - 1) * 14}px) / ${normalized}))`
  } as CSSProperties;
}

function zoomSliderStyle(cardsPerRow: number): CSSProperties {
  const normalized = normalizeCardsPerRow(cardsPerRow);
  const percent = ((normalized - MIN_CARDS_PER_ROW) / (MAX_CARDS_PER_ROW - MIN_CARDS_PER_ROW)) * 100;
  return { "--zoom-fill": `${percent}%` } as CSSProperties;
}

function makeGroupId(kind: GameGroup["kind"]): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${random}`;
}

function updateGroupList(settings: AppSettings | undefined, nextGroups: GameGroup[]): AppSettings | undefined {
  return settings ? { ...settings, gameGroups: nextGroups } : undefined;
}

function gameLocationPath(game: Game): string | undefined {
  if (game.installDirectory) {
    return game.installDirectory;
  }
  if (!game.executablePath) {
    return undefined;
  }
  const normalized = game.executablePath.replace(/\//g, "\\");
  const index = normalized.lastIndexOf("\\");
  return index > 0 ? normalized.slice(0, index) : undefined;
}

function steamAppId(game: Game): string | undefined {
  return game.sourceIds.find((source) => source.provider === "steam")?.externalId;
}

function defaultSmartGroupName(query: string, view: LibraryView): string {
  const pills = buildActiveFilterPills(view.filters, () => undefined);
  if (query.trim()) {
    return query.trim();
  }
  return pills.length === 1 ? pills[0]!.label : "Filtered group";
}

function libraryQueryForView(search: string, view: LibraryView, group?: GameGroup) {
  const effectiveView = group?.kind === "smart" ? normalizeLibraryView(group.view) : normalizeLibraryView(view);
  const effectiveSearch = group?.kind === "smart" ? (group.search ?? "") : search;
  return {
    search: effectiveSearch,
    sort: effectiveView.sort.field,
    sortDirection: effectiveView.sort.direction,
    ...(group?.kind === "manual" ? { gameIds: group.gameIds } : {}),
    ...effectiveView.filters
  };
}

function heroMeta(game: Game): string[] {
  return [
    game.releaseDate ? `Released ${formatDate(game.releaseDate)}` : undefined,
    game.genres[0],
    game.developers[0],
    game.discovery?.storeCategory && game.discovery.storeCategory !== game.discovery.signal ? game.discovery.storeCategory : undefined
  ].filter(Boolean) as string[];
}

const GLOW_REACH_MULTIPLIER = 1.25;

type CardGeom = { el: HTMLElement; x: number; y: number; w: number; h: number; cx: number; cy: number };

function useSpotlightGrid(ref: RefObject<HTMLDivElement | null>, hoverDelayMs = 0) {
  const sourceCardRef = useRef<HTMLElement | null>(null);
  const targetsRef = useRef<Set<HTMLElement>>(new Set());
  const pendingRef = useRef<HTMLElement | null | "clear">(null);
  const rafRef = useRef<number | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const cacheRef = useRef<CardGeom[]>([]);
  const cacheIndexRef = useRef<Map<HTMLElement, CardGeom>>(new Map());
  const cacheDirtyRef = useRef(true);
  const cardSetWrittenRef = useRef<Set<HTMLElement>>(new Set());

  const refreshCache = useCallback(() => {
    const grid = ref.current;
    if (!grid) {
      cacheRef.current = [];
      cacheIndexRef.current = new Map();
      return;
    }
    const gridRect = grid.getBoundingClientRect();
    const sl = grid.scrollLeft;
    const st = grid.scrollTop;
    const list: CardGeom[] = [];
    const index = new Map<HTMLElement, CardGeom>();
    const nodes = grid.querySelectorAll<HTMLElement>(".game-cover, .wide-game");
    nodes.forEach((card) => {
      const r = card.getBoundingClientRect();
      const entry: CardGeom = {
        el: card,
        x: r.left - gridRect.left + sl,
        y: r.top - gridRect.top + st,
        w: r.width,
        h: r.height,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2
      };
      list.push(entry);
      index.set(card, entry);
    });
    cacheRef.current = list;
    cacheIndexRef.current = index;
    cacheDirtyRef.current = false;
    cardSetWrittenRef.current = new Set();
  }, [ref]);

  const applyClear = useCallback(() => {
    if (sourceCardRef.current) {
      sourceCardRef.current.classList.remove("is-glow-source");
      sourceCardRef.current = null;
    }
    targetsRef.current.forEach((c) => c.classList.remove("is-glow-target"));
    targetsRef.current.clear();
  }, []);

  const applySet = useCallback((card: HTMLElement) => {
    const grid = ref.current;
    if (!grid || sourceCardRef.current === card) {
      return;
    }
    const cover = card.dataset.coverSrc;
    if (!cover) {
      applyClear();
      return;
    }
    if (cacheDirtyRef.current) {
      refreshCache();
    }
    let source = cacheIndexRef.current.get(card);
    if (!source) {
      refreshCache();
      source = cacheIndexRef.current.get(card);
      if (!source) {
        return;
      }
    }

    const reach = Math.max(source.w, source.h) * GLOW_REACH_MULTIPLIER;
    const reachSq = reach * reach;
    const list = cacheRef.current;
    const next = new Set<HTMLElement>();
    const writtenCards = cardSetWrittenRef.current;

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || entry.el === card) {
        continue;
      }
      const dx = entry.cx - source.cx;
      const dy = entry.cy - source.cy;
      if (dx * dx + dy * dy > reachSq) {
        continue;
      }
      next.add(entry.el);
      if (!writtenCards.has(entry.el)) {
        entry.el.style.setProperty("--card-x", `${entry.x}px`);
        entry.el.style.setProperty("--card-y", `${entry.y}px`);
        writtenCards.add(entry.el);
      }
    }

    if (sourceCardRef.current && sourceCardRef.current !== card) {
      sourceCardRef.current.classList.remove("is-glow-source");
    }
    card.classList.add("is-glow-source");
    sourceCardRef.current = card;

    grid.style.setProperty("--source-bg", `url("${cover.replace(/"/g, '\\"')}")`);
    grid.style.setProperty("--source-x", `${source.x}px`);
    grid.style.setProperty("--source-y", `${source.y}px`);
    grid.style.setProperty("--source-w", `${source.w}px`);
    grid.style.setProperty("--source-h", `${source.h}px`);

    const prev = targetsRef.current;
    prev.forEach((p) => {
      if (!next.has(p)) {
        p.classList.remove("is-glow-target");
      }
    });
    next.forEach((n) => {
      if (!prev.has(n)) {
        n.classList.add("is-glow-target");
      }
    });
    targetsRef.current = next;
  }, [ref, applyClear, refreshCache]);

  const flush = useCallback(() => {
    rafRef.current = null;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next === "clear") {
      applyClear();
    } else if (next) {
      applySet(next);
    }
  }, [applySet, applyClear]);

  const schedule = useCallback((next: HTMLElement | "clear") => {
    pendingRef.current = next;
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flush);
    }
  }, [flush]);

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    cancelHoverTimer();
    schedule("clear");
  }, [schedule, cancelHoverTimer]);

  const onPointerOver = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const card = (e.target as HTMLElement | null)?.closest<HTMLElement>(".game-cover, .wide-game");
    if (card) {
      if (hoverDelayMs > 0 && sourceCardRef.current !== card) {
        cancelHoverTimer();
        hoverTimerRef.current = window.setTimeout(() => {
          hoverTimerRef.current = null;
          schedule(card);
        }, hoverDelayMs);
      } else {
        cancelHoverTimer();
        schedule(card);
      }
    } else {
      cancelHoverTimer();
      schedule("clear");
    }
  }, [schedule, cancelHoverTimer, hoverDelayMs]);

  useEffect(() => {
    const grid = ref.current;
    if (!grid) {
      return;
    }
    const invalidate = () => {
      cacheDirtyRef.current = true;
    };
    const ro = new ResizeObserver(invalidate);
    ro.observe(grid);
    const mo = new MutationObserver(invalidate);
    mo.observe(grid, { childList: true, subtree: false });
    grid.addEventListener("scroll", invalidate, { passive: true });
    window.addEventListener("resize", invalidate);
    return () => {
      ro.disconnect();
      mo.disconnect();
      grid.removeEventListener("scroll", invalidate);
      window.removeEventListener("resize", invalidate);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };
  }, [ref]);

  return { onPointerOver, onPointerLeave: clear };
}

function isFamilySharedOnly(game: Game): boolean {
  if (game.sourceIds.length === 0) {
    return false;
  }
  return game.sourceIds.every((source) => source.shareType === "family");
}

function familySharedOwners(game: Game): string[] {
  const owners = new Set<string>();
  for (const source of game.sourceIds) {
    for (const owner of source.familyOwnerSteamIds ?? []) {
      owners.add(owner);
    }
  }
  return [...owners];
}

const GameCover = memo(function GameCover({
  game,
  onSelect,
  onContextMenu,
  wide = false,
  inLibrary = true,
  badges,
  showLogo = true,
  profileDetails,
  onCoverLoad,
  onIntent,
  allowDisplayFallback = false
}: {
  game: Game;
  onSelect: (game: Game) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
  wide?: boolean;
  inLibrary?: boolean;
  badges?: ReactNode;
  showLogo?: boolean;
  profileDetails?: Record<string, unknown>;
  onCoverLoad?: (details: Record<string, unknown>) => void;
  onIntent?: (game: Game) => void;
  allowDisplayFallback?: boolean;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const primaryCoverUrl = primaryCover(game, { allowDisplayFallback });
  const fallbackCoverUrl = heroStill(game);
  const cover = coverFailed ? fallbackCoverUrl : primaryCoverUrl;
  const coverImgRef = useRef<HTMLImageElement | null>(null);
  const coverProfileRef = useRef<ReturnType<typeof profileImageStart> | undefined>();
  const coverProfileUrlRef = useRef<string | undefined>();
  const logoProfileRef = useRef<ReturnType<typeof profileImageStart> | undefined>();
  const profileDetailsRef = useRef<Record<string, unknown> | undefined>(profileDetails);
  const loadedCoverSrcRef = useRef<string | undefined>();
  const isInstalled = game.installState === "installed";
  const launchable = canLaunch(game);
  const activity = formatCoverActivity(game);
  const familyShared = isFamilySharedOnly(game);
  const familyOwnersTooltip = familyShared
    ? `Shared by Steam Family${familySharedOwners(game).length > 0 ? `: ${familySharedOwners(game).join(", ")}` : ""}`
    : undefined;

  useEffect(() => {
    profileDetailsRef.current = profileDetails;
  }, [profileDetails]);

  useEffect(() => {
    setCoverFailed(false);
  }, [game.id, primaryCoverUrl]);

  useLayoutEffect(() => {
    loadedCoverSrcRef.current = undefined;
    setImgLoaded(false);
  }, [cover]);

  const finishCoverLoad = useCallback((image: HTMLImageElement) => {
    const loadedSrc = image.currentSrc || image.src;
    if (!loadedSrc || loadedCoverSrcRef.current === loadedSrc) {
      return;
    }

    loadedCoverSrcRef.current = loadedSrc;
    setImgLoaded(true);
    if (coverProfileUrlRef.current === cover) {
      coverProfileRef.current?.end("ok", {
        ...profileDetailsRef.current,
        role: "cover",
        gameId: game.id,
        title: game.title,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        lazy: true
      });
      coverProfileRef.current = undefined;
      coverProfileUrlRef.current = undefined;
    }
    onCoverLoad?.({
      ...profileDetailsRef.current,
      gameId: game.id,
      title: game.title,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight
    });
  }, [cover, game.id, game.title, onCoverLoad]);

  useLayoutEffect(() => {
    if (!cover) {
      return;
    }

    const image = coverImgRef.current;
    if (!image?.complete) {
      return;
    }

    if (image.naturalWidth > 0) {
      finishCoverLoad(image);
    } else if (!coverFailed) {
      setCoverFailed(true);
    }
  }, [cover, coverFailed, finishCoverLoad]);

  useEffect(() => {
    if (!cover) return undefined;
    const details = { ...profileDetailsRef.current, role: "cover", gameId: game.id, title: game.title, lazy: true };
    const span = profileImageStart(cover, details);
    coverProfileRef.current = span;
    coverProfileUrlRef.current = cover;
    const image = coverImgRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      span.end("ok", { ...details, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight });
      coverProfileRef.current = undefined;
      coverProfileUrlRef.current = undefined;
      return undefined;
    }
    return () => {
      if (coverProfileRef.current === span) {
        span.end("cancelled", details);
        coverProfileRef.current = undefined;
        coverProfileUrlRef.current = undefined;
      }
    };
  }, [cover, game.id, game.title]);

  useEffect(() => {
    if (!showLogo || !game.logoUrl) return undefined;
    const details = { ...profileDetailsRef.current, role: "logo", gameId: game.id, title: game.title, lazy: true };
    const span = profileImageStart(game.logoUrl, details);
    logoProfileRef.current = span;
    return () => {
      if (logoProfileRef.current === span) {
        span.end("cancelled", details);
        logoProfileRef.current = undefined;
      }
    };
  }, [game.logoUrl, game.id, game.title, showLogo]);

  return (
    <div
      className={wide ? "wide-game" : "game-cover"}
      style={fallbackArt(game)}
      data-cover-src={cover ?? ""}
      role="button"
      tabIndex={0}
      aria-label={game.title}
      onClick={() => onSelect(game)}
      onPointerEnter={() => onIntent?.(game)}
      onFocus={() => onIntent?.(game)}
      onContextMenu={(event) => onContextMenu?.(event, game)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(game);
        }
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          onContextMenu?.(e, game);
        }
      }}
    >
      <span className="cover-art">
        {cover ? (
          <img
            ref={coverImgRef}
            className={imgLoaded ? "cover-img loaded" : "cover-img"}
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              finishCoverLoad(event.currentTarget);
            }}
            onError={() => {
              const details = { ...profileDetailsRef.current, role: "cover", gameId: game.id, title: game.title, lazy: true };
              profileImageError(cover, details);
              if (coverProfileUrlRef.current === cover) {
                coverProfileRef.current?.end("error", details);
                coverProfileRef.current = undefined;
                coverProfileUrlRef.current = undefined;
              }
              loadedCoverSrcRef.current = undefined;
              setImgLoaded(false);
              if (!coverFailed) setCoverFailed(true);
            }}
          />
        ) : null}
        <span className="cover-reveal">
          <span className="cover-logo">
            {showLogo && game.logoUrl ? (
              <img
                className="cover-logo-img"
                src={game.logoUrl}
                alt={game.title}
                loading="lazy"
                decoding="async"
                onLoad={(event) => {
                  logoProfileRef.current?.end("ok", {
                    ...profileDetailsRef.current,
                    role: "logo",
                    gameId: game.id,
                    title: game.title,
                    naturalWidth: event.currentTarget.naturalWidth,
                    naturalHeight: event.currentTarget.naturalHeight,
                    lazy: true
                  });
                  logoProfileRef.current = undefined;
                }}
                onError={() => {
                  if (game.logoUrl) {
                    profileImageError(game.logoUrl, { ...profileDetailsRef.current, role: "logo", gameId: game.id, title: game.title, lazy: true });
                  }
                  logoProfileRef.current?.end("error", { ...profileDetailsRef.current, role: "logo", gameId: game.id, title: game.title });
                  logoProfileRef.current = undefined;
                }}
              />
            ) : (
              <span className="cover-logo-fallback">{game.title}</span>
            )}
          </span>
          {isInstalled ? (
            <button
              className="cover-action cover-action-play"
              type="button"
              onClick={(e) => { e.stopPropagation(); void launchGame(game); }}
              aria-label={`Play ${game.title}`}
            >
              <Play size={22} fill="currentColor" />
            </button>
          ) : inLibrary && launchable ? (
            <button
              className="cover-action cover-action-download"
              type="button"
              onClick={(e) => { e.stopPropagation(); void launchGame(game); }}
              aria-label={`Download ${game.title}`}
            >
              <Download size={22} />
            </button>
          ) : (
            <button
              className="cover-action cover-action-details"
              type="button"
              onClick={(e) => { e.stopPropagation(); onSelect(game); }}
              aria-label={`View details for ${game.title}`}
            >
              <Info size={22} />
            </button>
          )}
          <span className="cover-playtime">{activity}</span>
        </span>
      </span>
      {familyShared ? (
        <span className="cover-family-badge" title={familyOwnersTooltip}>
          Family
        </span>
      ) : null}
      {badges ? <span className="cover-extra-badges">{badges}</span> : null}
    </div>
  );
});

function GameRow({
  title,
  description,
  games,
  cardsPerRow,
  onSelect,
  onGameContextMenu,
  onGameIntent,
  libraryGameIds
}: {
  title: string;
  description?: string;
  games: Game[];
  cardsPerRow: number;
  onSelect: (game: Game) => void;
  onGameContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
  onGameIntent?: (game: Game) => void;
  libraryGameIds?: Set<string>;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const spotlight = useSpotlightGrid(stripRef);
  const [visibleCount, setVisibleCount] = useState(HOME_ROW_BATCH_SIZE);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    setVisibleCount(HOME_ROW_BATCH_SIZE);
    setCanScrollLeft(false);
    window.requestAnimationFrame(() => {
      if (stripRef.current) {
        stripRef.current.scrollLeft = 0;
      }
    });
  }, [games]);

  const visibleGames = games.slice(0, visibleCount);
  const hasMoreGames = visibleCount < games.length;

  const updateScrollState = () => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }

    setCanScrollLeft(strip.scrollLeft > 2);
    setCanScrollRight(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2 || visibleCount < games.length);
  };

  const revealMore = () => {
    setVisibleCount((current) => Math.min(games.length, current + HOME_ROW_BATCH_SIZE));
  };

  const scrollByItems = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }

    if (direction > 0 && hasMoreGames) {
      revealMore();
    }

    const firstCard = strip.querySelector<HTMLElement>(".game-cover");
    const itemWidth = (firstCard?.offsetWidth ?? 150) + 14;
    window.requestAnimationFrame(() => {
      strip.scrollBy({ left: itemWidth * HOME_ROW_STEP_ITEMS * direction, behavior: "smooth" });
    });
  };

  const onRowScroll = () => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }

    if (strip.scrollLeft + strip.clientWidth > strip.scrollWidth - 220 && hasMoreGames) {
      revealMore();
    }
    updateScrollState();
  };

  useEffect(() => {
    updateScrollState();
  }, [visibleCount, games.length]);

  if (games.length === 0) {
    return null;
  }

  return (
    <motion.section className="game-row" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      <div className="cover-strip-shell">
        {canScrollLeft ? (
          <button className="row-arrow left" type="button" onClick={() => scrollByItems(-1)} aria-label={`Show previous ${title} games`}>
            <ChevronLeft size={18} />
          </button>
        ) : null}
        <div className="cover-strip" ref={stripRef} style={cardGridStyle(cardsPerRow)} onScroll={onRowScroll} onPointerOver={spotlight.onPointerOver} onPointerLeave={spotlight.onPointerLeave}>
          {visibleGames.map((game) => {
            const inLibrary = libraryGameIds ? libraryGameIds.has(game.id) : true;
            return (
              <GameCover
                key={game.id}
                game={game}
                onSelect={onSelect}
                onContextMenu={onGameContextMenu}
                onIntent={onGameIntent}
                inLibrary={inLibrary}
                allowDisplayFallback={!inLibrary}
              />
            );
          })}
        </div>
        {canScrollRight ? (
          <button className="row-arrow right" type="button" onClick={() => scrollByItems(1)} aria-label={`Show next ${title} games`}>
            <ChevronRight size={18} />
          </button>
        ) : null}
      </div>
    </motion.section>
  );
}

function SourceAvailabilityTag({ game, libraryGameIds }: { game: Game; libraryGameIds: Set<string> }) {
  const [matches, setMatches] = useState<SourceExactMatch[]>(() => sourceAvailabilityCache.get(game.title) ?? []);
  const isLibraryGame = libraryGameIds.has(game.id);

  useEffect(() => {
    if (isLibraryGame) {
      setMatches([]);
      return;
    }

    const cached = sourceAvailabilityCache.get(game.title);
    if (cached) {
      setMatches(cached);
      return;
    }

    let cancelled = false;
    void window.hynite.sources.exactTitleMatches(game.title)
      .then((nextMatches) => {
        sourceAvailabilityCache.set(game.title, nextMatches);
        if (!cancelled) {
          setMatches(nextMatches);
        }
      })
      .catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [game.id, game.title, isLibraryGame]);

  if (isLibraryGame || matches.length === 0) {
    return null;
  }

  const sourceText = matches.map((match) => `${match.sourceName} (${match.count})`).join(", ");
  return (
    <span className="source-match-tag" title={sourceText}>
      <Download size={13} />
      Available in sources
    </span>
  );
}

function isHlsUrl(value: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(value);
}

function TrailerPlayer({ sourceUrl, posterUrl, label }: { sourceUrl: string; posterUrl?: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [audioState, setAudioState] = useState(readTrailerAudioState);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    let hls: Hls | undefined;
    setFailed(false);
    video.removeAttribute("src");
    video.volume = audioState.volume;
    video.muted = audioState.muted;

    if (isHlsUrl(sourceUrl)) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = sourceUrl;
      } else if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setFailed(true);
          }
        });
        hls.loadSource(sourceUrl);
        hls.attachMedia(video);
      } else {
        setFailed(true);
      }
    } else {
      video.src = sourceUrl;
    }

    const onCanPlay = () => setFailed(false);
    const onError = () => setFailed(true);
    const onVolumeChange = () => {
      const next = { volume: video.volume, muted: video.muted };
      setAudioState(next);
      writeTrailerAudioState(next);
    };
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("error", onError);
    video.addEventListener("volumechange", onVolumeChange);
    video.load();

    return () => {
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
      video.removeEventListener("volumechange", onVolumeChange);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [sourceUrl]);

  return (
    <>
      <video ref={videoRef} controls playsInline preload="metadata" poster={posterUrl} aria-label={label} />
      {failed ? (
        <div className="media-error">
          <span>Trailer unavailable</span>
          <button className="secondary-action" type="button" onClick={() => openExternalUrl(sourceUrl)}>
            <ExternalLink size={15} />
            Open video
          </button>
        </div>
      ) : null}
    </>
  );
}

function Hero({
  home,
  settings,
  libraryGameIds,
  onSelect,
  onOpenSettings,
  onGameIntent,
  discoveryLoading
}: {
  home?: HomeModel;
  settings?: AppSettings;
  libraryGameIds: Set<string>;
  onSelect: (game: Game) => void;
  onOpenSettings: () => void;
  onGameIntent?: (game: Game) => void;
  discoveryLoading: boolean;
}) {
  const heroGames = useMemo(() => {
    const rows = home?.popularNow ?? [];
    return rows.filter((game, index) => rows.findIndex((candidate) => candidate.id === game.id) === index).slice(0, 20);
  }, [home]);
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroDirection, setHeroDirection] = useState<-1 | 1>(1);
  const [isHeroPaused, setHeroPaused] = useState(false);
  const [activeHeroImage, setActiveHeroImage] = useState<{ gameId: string; image: string } | undefined>();
  const autoTimerRef = useRef<number | undefined>(undefined);
  const timerStartedAtRef = useRef(0);
  const timerRemainingRef = useRef(HERO_AUTOPLAY_MS);
  const previousHeroIndexRef = useRef(0);
  const heroGame = heroGames[heroIndex % Math.max(heroGames.length, 1)];
  const selectedHeroImage = activeHeroImage && activeHeroImage.gameId === heroGame?.id ? activeHeroImage.image : undefined;
  const heroImage = selectedHeroImage ?? (heroGame ? heroStill(heroGame) : undefined);
  const heroShots = (heroGame?.screenshots ?? []).slice(0, 3);
  const description = heroGame ? heroDescription(heroGame) : undefined;
  const reduceHeroMotion = Boolean(settings?.reduceMotion);
  const heroImageKey = `${heroGame?.id ?? "empty"}:${heroImage ?? "fallback"}`;
  const loadingDiscovery = Boolean(discoveryLoading && heroGames.length === 0 && (settings?.steamAccounts.length || settings?.steamWebApiKey));

  useEffect(() => {
    setHeroDirection(1);
    setHeroIndex(0);
  }, [heroGames.length]);

  useEffect(() => {
    setActiveHeroImage(undefined);
  }, [heroGame?.id]);

  useEffect(() => {
    const indexChanged = previousHeroIndexRef.current !== heroIndex;
    if (indexChanged) {
      timerRemainingRef.current = HERO_AUTOPLAY_MS;
      previousHeroIndexRef.current = heroIndex;
    }

    if (autoTimerRef.current !== undefined) {
      if (isHeroPaused && !indexChanged) {
        const elapsed = performance.now() - timerStartedAtRef.current;
        timerRemainingRef.current = Math.max(0, timerRemainingRef.current - elapsed);
      }
      window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = undefined;
    }

    if (reduceHeroMotion || isHeroPaused || heroGames.length < 2) {
      timerRemainingRef.current = reduceHeroMotion || heroGames.length < 2 ? HERO_AUTOPLAY_MS : timerRemainingRef.current;
      return;
    }

    timerStartedAtRef.current = performance.now();
    autoTimerRef.current = window.setTimeout(() => {
      timerRemainingRef.current = HERO_AUTOPLAY_MS;
      setHeroDirection(1);
      setHeroIndex((index) => (index + 1) % heroGames.length);
    }, timerRemainingRef.current);
  }, [heroGames.length, heroIndex, isHeroPaused, reduceHeroMotion]);

  useEffect(() => {
    return () => {
      if (autoTimerRef.current !== undefined) {
        window.clearTimeout(autoTimerRef.current);
      }
    };
  }, []);

  const stepHero = (direction: -1 | 1) => {
    if (heroGames.length < 2) {
      return;
    }
    setHeroDirection(direction);
    setHeroIndex((index) => (index + direction + heroGames.length) % heroGames.length);
  };

  const selectHero = (index: number) => {
    if (index === heroIndex) {
      return;
    }
    setHeroDirection(index < heroIndex ? -1 : 1);
    setHeroIndex(index);
  };

  return (
    <section
      className={isHeroPaused ? "hero paused" : "hero"}
      onPointerEnter={() => {
        setHeroPaused(true);
        if (heroGame) onGameIntent?.(heroGame);
      }}
      onPointerLeave={() => setHeroPaused(false)}
      onFocus={() => {
        setHeroPaused(true);
        if (heroGame) onGameIntent?.(heroGame);
      }}
      onBlur={() => setHeroPaused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); stepHero(-1); }
        if (e.key === "ArrowRight") { e.preventDefault(); stepHero(1); }
      }}
    >
      {heroGame ? (
        <>
          <div className="hero-media">
            <AnimatePresence initial={false}>
              <motion.span
                key={heroImageKey}
                style={heroImage ? { backgroundImage: `url(${heroImage})` } : undefined}
                initial={reduceHeroMotion ? false : { opacity: 0, scale: 1.04 }}
                animate={{ opacity: 0.72, scale: 1.08 }}
                exit={reduceHeroMotion ? undefined : { opacity: 0, scale: 1.12 }}
                transition={{ duration: reduceHeroMotion ? 0 : 0.42, ease: "easeOut" }}
              />
            </AnimatePresence>
          </div>
          <div className="hero-shade" />
          <AnimatePresence initial={false} mode="wait">
            <motion.button
              key={heroImageKey}
              className="hero-cover"
              style={fallbackArt(heroGame)}
              onClick={() => onSelect(heroGame)}
              initial={reduceHeroMotion ? false : { opacity: 0, x: -18 * heroDirection, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={reduceHeroMotion ? undefined : { opacity: 0, x: 18 * heroDirection, scale: 0.98 }}
              transition={{ duration: reduceHeroMotion ? 0 : 0.28, ease: "easeOut" }}
            >
              <span style={heroImage ? { backgroundImage: `url(${heroImage})` } : undefined} />
            </motion.button>
          </AnimatePresence>
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={heroGame.id}
              className="hero-copy"
              initial={reduceHeroMotion ? false : { opacity: 0, x: -18 * heroDirection }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceHeroMotion ? undefined : { opacity: 0, x: 18 * heroDirection }}
              transition={{ duration: reduceHeroMotion ? 0 : 0.24, ease: "easeOut" }}
            >
              <h1>
                <button className="hero-title-button" type="button" onClick={() => onSelect(heroGame)}>
                  {heroGame.title}
                </button>
              </h1>
              {description ? <p>{description}</p> : null}
              <div className="hero-meta-grid">
                {heroMeta(heroGame).map((item) => (
                  <span key={item}>{item}</span>
                ))}
                {heroGame.discovery?.discountPercent ? <strong>-{heroGame.discovery.discountPercent}%</strong> : null}
              </div>
              {heroShots.length ? (
                <div className="hero-shot-grid">
                  {heroShots.map((shot, index) => (
                    <button
                      key={shot.fullUrl}
                      type="button"
                      className={selectedHeroImage === shot.fullUrl ? "active" : undefined}
                      style={{ backgroundImage: `url(${shot.thumbnailUrl})` }}
                      onClick={() => setActiveHeroImage({ gameId: heroGame.id, image: shot.fullUrl })}
                      aria-label={`Show screenshot ${index + 1} for ${heroGame.title}`}
                    />
                  ))}
                </div>
              ) : null}
              <div className="hero-actions">
                {heroGame.discovery?.storeUrl ? (
                  <button className="secondary-action" onClick={() => openExternalUrl(heroGame.discovery?.storeUrl)}>
                    <ExternalLink size={16} />
                    {heroGame.discovery?.priceText ?? "Store"}
                  </button>
                ) : null}
                <SourceAvailabilityTag game={heroGame} libraryGameIds={libraryGameIds} />
              </div>
            </motion.div>
          </AnimatePresence>
          {heroGames.length > 1 ? (
            <div className="hero-carousel">
              <button type="button" onClick={() => stepHero(-1)} aria-label="Previous featured game">
                <ChevronLeft size={14} />
              </button>
              <div className="hero-dots" aria-label="Featured games">
                {heroGames.map((game, index) => (
                  <button
                    key={game.id}
                    type="button"
                    className={index === heroIndex ? (reduceHeroMotion ? "active static" : "active") : undefined}
                    style={index === heroIndex && !reduceHeroMotion ? ({ "--dot-duration": `${HERO_AUTOPLAY_MS}ms` } as CSSProperties) : undefined}
                    onClick={() => selectHero(index)}
                    aria-label={`Show ${game.title}`}
                    aria-current={index === heroIndex ? "true" : undefined}
                  />
                ))}
              </div>
              <button type="button" onClick={() => stepHero(1)} aria-label="Next featured game">
                <ChevronRight size={14} />
              </button>
            </div>
          ) : null}
        </>
      ) : loadingDiscovery ? (
        <HomeHeroSkeleton />
      ) : (
        <div className="hero-empty">
          <h1 className="hero-logo-title">
            <BrandLogo className="hero-logo" sizes="clamp(72px, 8vw, 104px)" />
          </h1>
          <p>{settings?.steamAccounts.length || settings?.steamWebApiKey ? "Discovery is loading. Home updates when refresh finishes." : "Pair Steam in Settings to start the first library view."}</p>
          <button className="primary-action" onClick={onOpenSettings}>
            <Settings size={16} />
            Open settings
          </button>
        </div>
      )}
    </section>
  );
}

function HomeHeroSkeleton() {
  return (
    <div className="home-hero-skeleton" aria-label="Loading discovery">
      <span className="home-skeleton-title" />
      <span className="home-skeleton-line long" />
      <span className="home-skeleton-line" />
      <div className="home-skeleton-actions">
        <span />
        <span />
      </div>
    </div>
  );
}

function HomeScreen({
  home,
  settings,
  libraryGames,
  libraryGameIds,
  wishlistItems,
  groups,
  onSelect,
  onOpenSettings,
  onGameContextMenu,
  onGameIntent,
  onLayoutChange,
  discoveryLoading
}: {
  home?: HomeModel;
  settings?: AppSettings;
  libraryGames: Game[];
  libraryGameIds: Set<string>;
  wishlistItems: SteamWishlistItem[];
  groups: GameGroup[];
  onSelect: (game: Game) => void;
  onOpenSettings: () => void;
  onGameContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
  onGameIntent?: (game: Game) => void;
  onLayoutChange: (next: HomeLayout) => void;
  discoveryLoading: boolean;
}) {
  const cardsPerRow = normalizeCardsPerRow(settings?.cardsPerRow);
  const layout = useMemo(() => resolveLayout(settings?.home, defaultHomeLayout), [settings?.home]);
  const [editing, setEditing] = useState(false);
  const [configuringId, setConfiguringId] = useState<string | undefined>();
  const [draftModule, setDraftModule] = useState<HomeModule | undefined>();
  const randomSeed = useMemo(() => Math.floor(Math.random() * 0xffffffff), []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const ctx: HomeResolveContext = useMemo(() => ({
    home,
    libraryGames,
    wishlistItems,
    groups,
    randomSeed
  }), [home, libraryGames, wishlistItems, groups, randomSeed]);

  // Resolve once per module per ctx change. Without this the resolver returns a fresh
  // array on every render, which makes GameRow's `useEffect([games])` reset visibleCount
  // and scroll position constantly.
  const moduleGamesById = useMemo(() => {
    const map = new Map<string, Game[]>();
    const all = draftModule ? [...layout.modules, draftModule] : layout.modules;
    for (const module of all) {
      map.set(module.id, resolveModuleGames(module, ctx));
    }
    return map;
  }, [layout.modules, draftModule, ctx]);

  function update(next: HomeLayout) {
    onLayoutChange(next);
  }

  function updateModule(moduleId: string, patch: HomeModule) {
    if (draftModule && draftModule.id === moduleId) {
      setDraftModule(patch);
      return;
    }
    update({ ...layout, modules: layout.modules.map((m) => (m.id === moduleId ? patch : m)) });
  }

  function deleteModule(moduleId: string) {
    update({ ...layout, modules: layout.modules.filter((m) => m.id !== moduleId) });
    if (configuringId === moduleId) setConfiguringId(undefined);
  }

  function startDraft() {
    const next = newDraftModule();
    setDraftModule(next);
    setConfiguringId(next.id);
  }

  function cancelDraft() {
    setDraftModule(undefined);
    setConfiguringId(undefined);
  }

  function confirmDraft() {
    if (!draftModule) return;
    update({ ...layout, modules: [...layout.modules, draftModule] });
    setDraftModule(undefined);
    setConfiguringId(undefined);
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = layout.modules.findIndex((m) => m.id === active.id);
    const newIndex = layout.modules.findIndex((m) => m.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    update({ ...layout, modules: arrayMove(layout.modules, oldIndex, newIndex) });
  }

  function renderModule(module: HomeModule) {
    const games = moduleGamesById.get(module.id) ?? [];
    if (module.visual === "hero") {
      const heroModel = module.source.kind === "homeModel" && module.source.row === "popularNow"
        ? home
        : { ...(home ?? emptyHomeModel()), popularNow: games };
      return (
        <Hero
          home={heroModel}
          settings={settings}
          libraryGameIds={libraryGameIds}
          onSelect={onSelect}
          onOpenSettings={onOpenSettings}
          onGameIntent={onGameIntent}
          discoveryLoading={discoveryLoading}
        />
      );
    }
    if (module.visual === "grid") {
      return (
        <HomeGridBlock
          title={module.title}
          hideTitle={module.hideTitle}
          games={games}
          gridRows={module.gridRows ?? 2}
          cardsPerRow={cardsPerRow}
          cardGridStyleFor={cardGridStyle}
          cardSize={module.cardSize}
          renderCard={(game) => {
            const inLibrary = libraryGameIds.has(game.id);
            return (
              <GameCover
                key={game.id}
                game={game}
                onSelect={onSelect}
                onContextMenu={onGameContextMenu}
                onIntent={onGameIntent}
                inLibrary={inLibrary}
                allowDisplayFallback={!inLibrary}
              />
            );
          }}
        />
      );
    }
    const effectiveCardsPerRow = adjustCardsPerRow(cardsPerRow, module.cardSize);
    return (
      <div className={`home-scroller size-${module.cardSize ?? "default"}`}>
        <GameRow
          title={module.hideTitle ? "" : module.title}
          games={games}
          cardsPerRow={effectiveCardsPerRow}
          onSelect={onSelect}
          onGameContextMenu={onGameContextMenu}
          onGameIntent={onGameIntent}
          libraryGameIds={libraryGameIds}
        />
      </div>
    );
  }

  const configuringIsDraft = draftModule?.id === configuringId;
  const configuringModule = configuringIsDraft
    ? draftModule
    : (configuringId ? layout.modules.find((m) => m.id === configuringId) : undefined);

  const moduleList: Array<{ module: HomeModule; isDraft: boolean }> = [
    ...layout.modules.map((m) => ({ module: m, isDraft: false })),
    ...(draftModule ? [{ module: draftModule, isDraft: true }] : [])
  ];

  return (
    <main className={editing ? "page home-editing" : "page"}>
      <div className="home-page-toolbar">
        <button
          type="button"
          className={editing ? "home-edit-toggle active" : "home-edit-toggle"}
          onClick={() => {
            if (editing) cancelDraft();
            setEditing((v) => !v);
          }}
          aria-pressed={editing}
          aria-label={editing ? "Finish editing home layout" : "Edit home layout"}
          title={editing ? "Finish editing" : "Edit layout"}
        >
          {editing ? <Check size={16} /> : <Pencil size={16} />}
        </button>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={layout.modules.map((m) => m.id)} strategy={verticalListSortingStrategy}>
          {moduleList.map(({ module, isDraft }) => (
            <SortableModule key={module.id} id={module.id} editing={editing} isDraft={isDraft}>
              {({ listeners }) => (
                <>
                  {editing ? (
                    <ModuleEditChrome
                      title={isDraft ? `${module.title} (preview)` : module.title}
                      dragListeners={listeners}
                      onConfigure={() => setConfiguringId(module.id)}
                      onDelete={() => (isDraft ? cancelDraft() : deleteModule(module.id))}
                    />
                  ) : null}
                  <div className={editing ? "home-module-body editing" : "home-module-body"}>
                    {renderModule(module)}
                  </div>
                </>
              )}
            </SortableModule>
          ))}
        </SortableContext>
      </DndContext>

      {!editing && layout.modules.length === 0 ? (
        <HomeEmptyState onAdd={() => { setEditing(true); startDraft(); }} />
      ) : null}

      {editing ? <AddModuleButton onClick={startDraft} disabled={Boolean(draftModule)} /> : null}

      {editing ? (
        <HomeEditBar
          onDone={() => {
            cancelDraft();
            setEditing(false);
          }}
          onReset={() => {
            cancelDraft();
            update(defaultHomeLayout);
          }}
        />
      ) : null}

      {editing && configuringModule ? (
        <div
          className="home-module-config-overlay"
          onClick={() => (configuringIsDraft ? cancelDraft() : setConfiguringId(undefined))}
        >
          <div onClick={(event) => event.stopPropagation()}>
            <ModuleConfigPanel
              module={configuringModule}
              groups={groups}
              draft={configuringIsDraft}
              ctx={ctx}
              onChange={(next) => updateModule(configuringModule.id, next)}
              onCancel={cancelDraft}
              onConfirmAdd={confirmDraft}
              onClose={() => (configuringIsDraft ? cancelDraft() : setConfiguringId(undefined))}
            />
          </div>
        </div>
      ) : null}
    </main>
  );
}

function emptyHomeModel(): HomeModel {
  return {
    recentActivity: [],
    continuePlaying: [],
    mostPlayed: [],
    popularNow: [],
    recommended: [],
    newAndNotable: [],
    generatedAt: new Date().toISOString(),
    stale: false
  };
}

function SteamStoreScreen({
  settings,
  onSettingsChanged,
  onOpenSettings
}: {
  settings?: AppSettings;
  onSettingsChanged: (settings: AppSettings) => void;
  onOpenSettings: () => void;
}) {
  const webviewRef = useRef<SteamWebviewElement | null>(null);
  const [info, setInfo] = useState<SteamStoreEmbedInfo | undefined>();
  const [infoError, setInfoError] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [pageReady, setPageReady] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [infoRefreshKey, setInfoRefreshKey] = useState(0);
  const sessionCaptureInFlightRef = useRef(false);
  const navigationTokenRef = useRef(0);
  const hasPreparedOnceRef = useRef(false);
  const accountSessionKey = useMemo(
    () => (settings?.steamAccounts ?? [])
      .map((account) => `${account.steamId}:${account.pairedAt}:${account.familySession?.connectedAt ?? "none"}`)
      .join("|"),
    [settings?.steamAccounts]
  );

  useEffect(() => {
    let active = true;
    setInfo(undefined);
    setInfoError(undefined);
    hasPreparedOnceRef.current = false;
    setPageReady(false);
    void window.hynite.steam.storeEmbed()
      .then((next) => {
        if (!active) return;
        setInfo(next);
        setLoading(next.available);
        setLoadError(undefined);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setInfoError(error instanceof Error ? error.message : String(error));
        setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [accountSessionKey, infoRefreshKey]);

  const captureSession = useCallback(() => {
    if (!info?.available) {
      return;
    }
    if (sessionCaptureInFlightRef.current) {
      return;
    }
    sessionCaptureInFlightRef.current = true;
    void window.hynite.steam.captureStoreSession()
      .then((nextSettings) => {
        if (nextSettings) {
          onSettingsChanged(nextSettings);
          setInfo((current) => current?.available
            ? {
                ...current,
                loggedIn: true,
                account: {
                  ...current.account,
                  hasFamilySession: true
                }
              }
            : current);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        sessionCaptureInFlightRef.current = false;
      });
  }, [info, onSettingsChanged]);

  useEffect(() => {
    if (!info?.available) {
      return;
    }
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const handleStart = () => {
      navigationTokenRef.current += 1;
      if (!hasPreparedOnceRef.current) {
        setPageReady(false);
      }
      setLoading(true);
      setLoadError(undefined);
    };
    const handleDomReady = () => {
      void prepareSteamStoreWebview(webview).catch(() => undefined);
    };
    const handleStop = () => {
      const token = navigationTokenRef.current;
      void prepareSteamStoreWebview(webview)
        .then(() => {
          if (navigationTokenRef.current !== token) {
            return;
          }
          hasPreparedOnceRef.current = true;
          setPageReady(true);
          setLoadError(undefined);
          captureSession();
        })
        .catch((error: unknown) => {
          if (navigationTokenRef.current !== token) {
            return;
          }
          console.error("[steam-store] failed to prepare embedded Store page", error);
          setPageReady(hasPreparedOnceRef.current);
          setLoadError("Steam Store theme failed to apply.");
        })
        .finally(() => {
          if (navigationTokenRef.current === token) {
            setLoading(false);
          }
        });
    };
    const handleFail = (event: Event) => {
      const details = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (details.isMainFrame === false || details.errorCode === -3) {
        return;
      }
      setPageReady(hasPreparedOnceRef.current);
      setLoadError(details.errorDescription || "Steam Store failed to load.");
      setLoading(false);
    };
    const handleNavigation = (event: Event) => {
      const details = event as Event & { url?: string };
      if (!isSteamEmbedNavigationAllowed(details.url)) {
        event.preventDefault();
        openExternalUrl(details.url);
      }
    };
    const handleNewWindow = (event: Event) => {
      const details = event as Event & { url?: string };
      event.preventDefault();
      if (isSteamEmbedNavigationAllowed(details.url) && details.url) {
        navigationTokenRef.current += 1;
        if (!hasPreparedOnceRef.current) {
          setPageReady(false);
        }
        setLoading(true);
        setLoadError(undefined);
        webview.loadURL(details.url);
      } else {
        openExternalUrl(details.url);
      }
    };

    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-stop-loading", handleStop);
    webview.addEventListener("did-fail-load", handleFail);
    webview.addEventListener("will-navigate", handleNavigation);
    webview.addEventListener("new-window", handleNewWindow);
    return () => {
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-stop-loading", handleStop);
      webview.removeEventListener("did-fail-load", handleFail);
      webview.removeEventListener("will-navigate", handleNavigation);
      webview.removeEventListener("new-window", handleNewWindow);
    };
  }, [captureSession, info?.available, info?.available ? info.partition : undefined, refreshKey]);

  const reload = useCallback(() => {
    setLoadError(undefined);
    if (!hasPreparedOnceRef.current) {
      setPageReady(false);
    }
    setLoading(true);
    if (webviewRef.current) {
      webviewRef.current.reload();
    } else {
      setRefreshKey((current) => current + 1);
    }
  }, []);

  if (!info) {
    return (
      <main className="steam-store-page">
        <div className="steam-store-webview-frame steam-store-empty">
          {infoError ? <p>{infoError}</p> : <Loader2 className="spin" size={22} />}
          {infoError ? (
            <button className="secondary-action" type="button" onClick={() => setInfoRefreshKey((current) => current + 1)}>
              <RefreshCw size={16} />
              Retry
            </button>
          ) : null}
        </div>
      </main>
    );
  }

  if (!info.available) {
    return (
      <main className="steam-store-page">
        <div className="empty-state">
          <Globe2 size={34} />
          <h2>Steam needs an account</h2>
          <p>Pair the primary Steam account first.</p>
          <button className="secondary-action" type="button" onClick={onOpenSettings}>
            <Settings size={16} />
            Settings
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="steam-store-page" aria-label="Steam Store">
      <div className="steam-store-webview-frame steam-store-webview-full">
        <webview
          key={`${info.partition}:${refreshKey}`}
          ref={(node) => {
            webviewRef.current = node as unknown as SteamWebviewElement | null;
          }}
          className={pageReady && !loadError ? "steam-store-webview ready" : "steam-store-webview"}
          src={info.url}
          partition={info.partition}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes,nativeWindowOpen=no"
        />
        {!pageReady && !loadError ? (
          <div className="steam-store-overlay preparing">
            <Loader2 className="spin" size={24} />
          </div>
        ) : null}
        {loadError ? (
          <div className="steam-store-overlay failed">
            <p>{loadError}</p>
            <button className="secondary-action" type="button" onClick={reload}>
              <RefreshCw size={16} />
              Reload
            </button>
            <button className="secondary-action" type="button" onClick={() => openExternalUrl(info.url)}>
              <ExternalLink size={16} />
              Open
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

const SORT_FIELD_LABELS: Record<LibrarySortField, string> = {
  title: "Title",
  recent: "Recent activity",
  added: "Recently added",
  playtime: "Playtime",
  release: "Release date"
};

const PLAYER_MODE_LABELS: Record<PlayerMode, string> = {
  single_player: "Single-player",
  multi_player: "Multi-player",
  local_coop: "Local Co-op",
  online_coop: "Online Co-op",
  local_multiplayer: "Local Multi-player"
};

const SOURCE_LABELS: Record<ProviderId, string> = {
  steam: "Steam",
  epic: "Epic",
  gog: "GOG",
  manual: "Manual",
  local: "Local",
  igdb: "IGDB"
};

const DATE_FILTER_OPTIONS: Array<{ value: LibraryDateFilter; label: string }> = [
  { value: "any", label: "Any time" },
  { value: "recently_added", label: "Added in last 30 days" },
  { value: "recently_played", label: "Played in last 30 days" },
  { value: "never_played", label: "Never played" }
];

const OWNERSHIP_OPTIONS: Array<{ value: LibraryOwnership; label: string }> = [
  { value: "all", label: "All" },
  { value: "owned", label: "Owned" },
  { value: "family", label: "Family-shared" }
];

const INSTALL_STATE_OPTIONS: Array<{ value: InstallState | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "installed", label: "Installed" },
  { value: "not_installed", label: "Not installed" },
  { value: "unknown", label: "Unknown" }
];

function countActiveFilters(filters: LibraryFilters): number {
  let n = 0;
  if (filters.installState && filters.installState !== "all") n += 1;
  if (filters.ownership && filters.ownership !== "all") n += 1;
  if (filters.dateFilter && filters.dateFilter !== "any") n += 1;
  if (filters.sources && filters.sources.length > 0) n += filters.sources.length;
  if (filters.genres && filters.genres.length > 0) n += filters.genres.length;
  if (filters.tags && filters.tags.length > 0) n += filters.tags.length;
  if (filters.playerModes && filters.playerModes.length > 0) n += filters.playerModes.length;
  return n;
}

function toggleInArray<T>(arr: T[] | undefined, value: T): T[] {
  const next = arr ?? [];
  return next.includes(value) ? next.filter((item) => item !== value) : [...next, value];
}

function sortGamesByField(games: Game[], field: LibrarySortField, direction: LibrarySortDirection): Game[] {
  const dir = direction === "asc" ? 1 : -1;
  const sorted = [...games];
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case "title":
        cmp = (a.sortTitle ?? a.title).localeCompare(b.sortTitle ?? b.title);
        break;
      case "playtime":
        cmp = (a.playtimeMinutes ?? 0) - (b.playtimeMinutes ?? 0);
        break;
      case "release":
        cmp = (Date.parse(a.releaseDate ?? "") || 0) - (Date.parse(b.releaseDate ?? "") || 0);
        break;
      case "added":
        cmp = (Date.parse(a.addedAt ?? a.importedAt ?? "") || 0) - (Date.parse(b.addedAt ?? b.importedAt ?? "") || 0);
        break;
      case "recent":
      default:
        cmp = gameActivityTime(a) - gameActivityTime(b);
        break;
    }
    if (cmp === 0) cmp = a.title.localeCompare(b.title);
    return cmp * dir;
  });
  return sorted;
}

function mergeRecentSortedGame(current: Game[], game: Game): Game[] {
  const existing = current.some((item) => item.id === game.id);
  const next = existing
    ? current.map((item) => (item.id === game.id ? game : item))
    : [game, ...current];
  return sortGamesByField(next, "recent", "desc");
}

function mergeRecentActivityGame(current: Game[], game: Game): Game[] {
  if (gameActivityTime(game) <= 0) {
    return current.filter((item) => item.id !== game.id);
  }
  return mergeRecentSortedGame(current, game);
}

function applyLibraryFilters(games: Game[], filters: LibraryFilters): Game[] {
  let next = games;
  const installState = filters.installState ?? "all";
  const ownership = filters.ownership ?? "all";
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  if (installState !== "all") {
    next = next.filter((game) => game.installState === installState);
  }
  if (ownership !== "all") {
    next = next.filter((game) => {
      if (game.sourceIds.length === 0) return ownership === "owned";
      const allFamily = game.sourceIds.every((source) => source.shareType === "family");
      return ownership === "family" ? allFamily : !allFamily;
    });
  }
  if ((filters.sources ?? []).length > 0) {
    next = next.filter((game) => game.sourceIds.some((source) => filters.sources?.includes(source.provider)));
  }
  if ((filters.genres ?? []).length > 0) {
    next = next.filter((game) => game.genres.some((genre) => filters.genres?.includes(genre)));
  }
  if ((filters.tags ?? []).length > 0) {
    next = next.filter((game) => game.tags.some((tag) => filters.tags?.includes(tag)));
  }
  if ((filters.playerModes ?? []).length > 0) {
    next = next.filter((game) => game.playerModes.some((mode) => filters.playerModes?.includes(mode)));
  }
  if (filters.dateFilter && filters.dateFilter !== "any") {
    next = next.filter((game) => {
      if (filters.dateFilter === "recently_added") {
        return (Date.parse(game.importedAt ?? game.addedAt ?? "") || 0) >= recentCutoff;
      }
      if (filters.dateFilter === "recently_played") {
        return (Date.parse(game.lastPlayedAt ?? "") || 0) >= recentCutoff;
      }
      return !game.lastPlayedAt;
    });
  }
  return next;
}

function FilterChip({ label, pressed, onClick }: { label: string; pressed: boolean; onClick: () => void }) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onClick}>
      {label}
    </button>
  );
}

function FilterSection({
  title,
  defaultOpen = true,
  children
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="filter-section">
      <button type="button" className="filter-section-header" onClick={() => setOpen((value) => !value)}>
        <span className="filter-section-title">{title}</span>
        <ChevronDown size={14} style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms" }} />
      </button>
      {open ? <div className="filter-chip-row">{children}</div> : null}
    </div>
  );
}

function LibraryFiltersPanel({
  open,
  onClose,
  filters,
  onChange,
  onReset,
  facets,
  query,
  onRequestSmartGroup
}: {
  open: boolean;
  onClose: () => void;
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  onReset: () => void;
  facets: { sources: ProviderId[]; genres: string[]; tags: string[]; playerModes: PlayerMode[] };
  query: string;
  onRequestSmartGroup: (defaultName: string) => void;
}) {
  const [tagSearch, setTagSearch] = useState("");
  const filterBodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const { action } = (e as CustomEvent<{ action: string }>).detail;
      const panel = panelRef.current;
      if (!panel) return;
      const chips = Array.from(panel.querySelectorAll<HTMLElement>(".filter-chip"));
      if (!chips.length) return;
      const current = document.activeElement as HTMLElement;
      const idx = chips.indexOf(current);

      if (action === "play") {
        const target = idx >= 0 ? chips[idx] : chips[0];
        target?.click();
        return;
      }
      let next = idx;
      if (action === "moveDown" || action === "moveRight") {
        next = idx < chips.length - 1 ? idx + 1 : idx;
        if (idx === -1) next = 0;
      } else if (action === "moveUp" || action === "moveLeft") {
        next = idx > 0 ? idx - 1 : 0;
        if (idx === -1) next = 0;
      }
      chips[next]?.focus();
      chips[next]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    window.addEventListener("bp-filter-action", handler);
    return () => window.removeEventListener("bp-filter-action", handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>(".filter-chip")?.focus();
    }, 280);
    return () => clearTimeout(timer);
  }, [open]);

  const visibleTags = useMemo(() => {
    const needle = tagSearch.trim().toLocaleLowerCase();
    const list = needle ? facets.tags.filter((tag) => tag.toLocaleLowerCase().includes(needle)) : facets.tags;
    return list.slice(0, 60);
  }, [facets.tags, tagSearch]);
  const canCreateSmartGroup = countActiveFilters(filters) > 0 || query.trim().length > 0;

  function createSmartGroup() {
    onRequestSmartGroup(defaultSmartGroupName(query, { filters, sort: defaultLibraryView.sort }));
    onClose();
  }

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="filter-backdrop"
            className="filter-panel-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            key="filter-panel"
            className="filter-panel"
            ref={panelRef}
            initial={{ x: 380 }}
            animate={{ x: 0 }}
            exit={{ x: 380 }}
            transition={{ type: "tween", duration: 0.22, ease: [0.25, 0.8, 0.4, 1] }}
            role="dialog"
            aria-label="Library filters"
          >
            <div className="filter-panel-header">
              <h2>Filters</h2>
              <div className="filter-panel-header-actions">
                <button type="button" className="filter-panel-reset" onClick={onReset}>
                  Reset
                </button>
                <button type="button" className="icon-action" onClick={onClose} aria-label="Close filters">
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="filter-panel-body" ref={filterBodyRef}>
              <FilterSection title="Status">
                {INSTALL_STATE_OPTIONS.map((option) => (
                  <FilterChip
                    key={option.value}
                    label={option.label}
                    pressed={(filters.installState ?? "all") === option.value}
                    onClick={() => onChange({ ...filters, installState: option.value })}
                  />
                ))}
              </FilterSection>

              <FilterSection title="Ownership">
                {OWNERSHIP_OPTIONS.map((option) => (
                  <FilterChip
                    key={option.value}
                    label={option.label}
                    pressed={(filters.ownership ?? "all") === option.value}
                    onClick={() => onChange({ ...filters, ownership: option.value })}
                  />
                ))}
              </FilterSection>

              {facets.sources.length > 0 ? (
                <FilterSection title="Source">
                  {facets.sources.map((source) => (
                    <FilterChip
                      key={source}
                      label={SOURCE_LABELS[source]}
                      pressed={(filters.sources ?? []).includes(source)}
                      onClick={() => onChange({ ...filters, sources: toggleInArray(filters.sources, source) })}
                    />
                  ))}
                </FilterSection>
              ) : null}

              {facets.playerModes.length > 0 ? (
                <FilterSection title="Player support">
                  {facets.playerModes.map((mode) => (
                    <FilterChip
                      key={mode}
                      label={PLAYER_MODE_LABELS[mode]}
                      pressed={(filters.playerModes ?? []).includes(mode)}
                      onClick={() => onChange({ ...filters, playerModes: toggleInArray(filters.playerModes, mode) })}
                    />
                  ))}
                </FilterSection>
              ) : null}

              <FilterSection title="Date">
                {DATE_FILTER_OPTIONS.map((option) => (
                  <FilterChip
                    key={option.value}
                    label={option.label}
                    pressed={(filters.dateFilter ?? "any") === option.value}
                    onClick={() => onChange({ ...filters, dateFilter: option.value })}
                  />
                ))}
              </FilterSection>

              {facets.genres.length > 0 ? (
                <FilterSection title="Genres">
                  {facets.genres.map((genre) => (
                    <FilterChip
                      key={genre}
                      label={genre}
                      pressed={(filters.genres ?? []).includes(genre)}
                      onClick={() => onChange({ ...filters, genres: toggleInArray(filters.genres, genre) })}
                    />
                  ))}
                </FilterSection>
              ) : null}

              {facets.tags.length > 0 ? (
                <FilterSection title="Tags" defaultOpen={false}>
                  <label className="filter-tag-search">
                    <Search size={13} />
                    <input
                      value={tagSearch}
                      onChange={(event) => setTagSearch(event.target.value)}
                      placeholder="Search tags"
                    />
                  </label>
                  <div className="filter-chip-row" style={{ marginTop: 8 }}>
                    {visibleTags.map((tag) => (
                      <FilterChip
                        key={tag}
                        label={tag}
                        pressed={(filters.tags ?? []).includes(tag)}
                        onClick={() => onChange({ ...filters, tags: toggleInArray(filters.tags, tag) })}
                      />
                    ))}
                  </div>
                </FilterSection>
              ) : null}
            </div>
            <div className="filter-panel-footer">
              <button type="button" className="secondary-action" disabled={!canCreateSmartGroup} onClick={createSmartGroup}>
                <Plus size={14} />
                Create smart group
              </button>
            </div>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

function LibrarySortMenu({
  field,
  direction,
  onChange
}: {
  field: LibrarySortField;
  direction: LibrarySortDirection;
  onChange: (next: { field: LibrarySortField; direction: LibrarySortDirection }) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handle(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", handle);
    return () => window.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div className="sort-trigger-wrap" ref={containerRef}>
      <button type="button" className="secondary-action" onClick={() => setOpen((value) => !value)}>
        <SlidersHorizontal size={14} />
        {SORT_FIELD_LABELS[field]}
        {direction === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="sort-menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            {(Object.keys(SORT_FIELD_LABELS) as LibrarySortField[]).map((option) => (
              <button
                type="button"
                key={option}
                className="sort-menu-row"
                aria-current={option === field}
                onClick={() => {
                  const nextDirection: LibrarySortDirection = option === "title" ? "asc" : "desc";
                  onChange({ field: option, direction: option === field ? direction : nextDirection });
                }}
              >
                {SORT_FIELD_LABELS[option]}
              </button>
            ))}
            <div className="sort-menu-divider" />
            <button
              type="button"
              className="sort-menu-row"
              onClick={() => onChange({ field, direction: direction === "asc" ? "desc" : "asc" })}
            >
              {direction === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
              {direction === "asc" ? "Ascending" : "Descending"}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type ActivePillSpec = { key: string; label: string; onRemove: () => void };

function buildActiveFilterPills(filters: LibraryFilters, onChange: (next: LibraryFilters) => void): ActivePillSpec[] {
  const pills: ActivePillSpec[] = [];
  if (filters.installState && filters.installState !== "all") {
    const label = INSTALL_STATE_OPTIONS.find((option) => option.value === filters.installState)?.label ?? filters.installState;
    pills.push({ key: `install:${filters.installState}`, label, onRemove: () => onChange({ ...filters, installState: "all" }) });
  }
  if (filters.ownership && filters.ownership !== "all") {
    const label = OWNERSHIP_OPTIONS.find((option) => option.value === filters.ownership)?.label ?? filters.ownership;
    pills.push({ key: `own:${filters.ownership}`, label, onRemove: () => onChange({ ...filters, ownership: "all" }) });
  }
  if (filters.dateFilter && filters.dateFilter !== "any") {
    const label = DATE_FILTER_OPTIONS.find((option) => option.value === filters.dateFilter)?.label ?? filters.dateFilter;
    pills.push({ key: `date:${filters.dateFilter}`, label, onRemove: () => onChange({ ...filters, dateFilter: "any" }) });
  }
  for (const source of filters.sources ?? []) {
    pills.push({
      key: `source:${source}`,
      label: SOURCE_LABELS[source],
      onRemove: () => onChange({ ...filters, sources: (filters.sources ?? []).filter((item) => item !== source) })
    });
  }
  for (const mode of filters.playerModes ?? []) {
    pills.push({
      key: `mode:${mode}`,
      label: PLAYER_MODE_LABELS[mode],
      onRemove: () => onChange({ ...filters, playerModes: (filters.playerModes ?? []).filter((item) => item !== mode) })
    });
  }
  for (const genre of filters.genres ?? []) {
    pills.push({
      key: `genre:${genre}`,
      label: genre,
      onRemove: () => onChange({ ...filters, genres: (filters.genres ?? []).filter((item) => item !== genre) })
    });
  }
  for (const tag of filters.tags ?? []) {
    pills.push({
      key: `tag:${tag}`,
      label: tag,
      onRemove: () => onChange({ ...filters, tags: (filters.tags ?? []).filter((item) => item !== tag) })
    });
  }
  return pills;
}

function ActiveFilterPills({
  filters,
  onChange,
  onClearAll
}: {
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  onClearAll: () => void;
}) {
  const pills = buildActiveFilterPills(filters, onChange);
  if (pills.length === 0) return null;
  return (
    <div className="active-filters">
      {pills.map((pill) => (
        <span key={pill.key} className="active-pill">
          {pill.label}
          <button type="button" onClick={pill.onRemove} aria-label={`Remove ${pill.label}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="active-clear" onClick={onClearAll}>
        Clear all
      </button>
    </div>
  );
}

function LibraryScreen({
  games,
  facetGames,
  query,
  setQuery,
  view,
  setView,
  activeGroup,
  onSelect,
  onGameContextMenu,
  onCreateSmartGroup,
  onRenameGroup,
  onDeleteGroup,
  onOpenSettings,
  cardsPerRow
}: {
  games: Game[];
  facetGames: Game[];
  query: string;
  setQuery: (query: string) => void;
  view: LibraryView;
  setView: (next: LibraryView) => void;
  activeGroup?: GameGroup;
  onSelect: (game: Game) => void;
  onGameContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
  onCreateSmartGroup: (name: string) => void;
  onRenameGroup: (group: GameGroup) => void;
  onDeleteGroup: (group: GameGroup) => void;
  onOpenSettings: () => void;
  cardsPerRow: number;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const spotlight = useSpotlightGrid(gridRef, 180);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(LIBRARY_GRID_INITIAL_SIZE);
  const normalizedCardsPerRow = normalizeCardsPerRow(cardsPerRow);
  const gridStyle = useMemo(() => cardGridStyle(normalizedCardsPerRow), [normalizedCardsPerRow]);

  const facets = useMemo(() => {
    const sourceSet = new Set<ProviderId>();
    const genreSet = new Set<string>();
    const tagSet = new Set<string>();
    const playerModeSet = new Set<PlayerMode>();
    for (const game of facetGames) {
      for (const source of game.sourceIds) sourceSet.add(source.provider);
      for (const genre of game.genres) genreSet.add(genre);
      for (const tag of game.tags) tagSet.add(tag);
      for (const mode of game.playerModes) playerModeSet.add(mode);
    }
    return {
      sources: [...sourceSet].sort(),
      genres: [...genreSet].sort((a, b) => a.localeCompare(b)),
      tags: [...tagSet].sort((a, b) => a.localeCompare(b)),
      playerModes: [...playerModeSet]
    };
  }, [facetGames]);

  const activeCount = countActiveFilters(view.filters);
  const visibleGames = useMemo(() => games.slice(0, visibleCount), [games, visibleCount]);
  const hasMoreGames = visibleCount < games.length;

  useEffect(() => {
    updateRuntimeProfileContext({
      route: "library",
      area: "library",
      totalGames: games.length,
      visibleGames: visibleGames.length,
      cardsPerRow: normalizedCardsPerRow,
      activeGroupId: activeGroup?.id,
      activeGroupName: activeGroup?.name,
      libraryQuery: query
    });
  }, [activeGroup?.id, activeGroup?.name, games.length, normalizedCardsPerRow, query, visibleGames.length]);

  useEffect(() => {
    setVisibleCount(LIBRARY_GRID_INITIAL_SIZE);
  }, [games]);

  useEffect(() => {
    if (!hasMoreGames) return undefined;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => {
          const next = Math.min(games.length, current + LIBRARY_GRID_BATCH_SIZE);
          if (next > current) {
            const span = startRuntimeInteraction("library:load-more-batch", {
              fromVisibleGames: current,
              toVisibleGames: next,
              totalGames: games.length,
              activeGroupId: activeGroup?.id,
              activeGroupName: activeGroup?.name
            });
            requestAnimationFrame(() => {
              requestAnimationFrame(() => span.end("ok", { visibleGames: next }));
            });
          }
          return next;
        });
      }
    }, { rootMargin: "540px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeGroup?.id, activeGroup?.name, games.length, hasMoreGames]);

  function setFilters(filters: LibraryFilters) {
    setView({ ...view, filters });
  }

  function setSort(sort: { field: LibrarySortField; direction: LibrarySortDirection }) {
    setView({ ...view, sort });
  }

  return (
    <main className="page">
      <div className="library-head">
        <div>
          <h1>{activeGroup?.name ?? "Library"}</h1>
          <p>
            {games.length} games
            {activeGroup?.kind === "smart" ? " / smart group" : activeGroup?.kind === "manual" ? " / manual group" : ""}
          </p>
        </div>
        <div className="toolbar library-toolbar">
          <label className="search-box">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search library" />
          </label>
          <button type="button" className="secondary-action filter-trigger" onClick={() => setFiltersOpen(true)}>
            <SlidersHorizontal size={14} />
            Filters
            {activeCount > 0 ? <span className="filter-trigger-badge">{activeCount}</span> : null}
          </button>
          <LibrarySortMenu field={view.sort.field} direction={view.sort.direction} onChange={setSort} />
          {activeGroup ? (
            <>
              <button className="secondary-action" onClick={() => onRenameGroup(activeGroup)}>
                <Pencil size={14} />
                Rename
              </button>
              <button className="secondary-action" onClick={() => onDeleteGroup(activeGroup)}>
                <Trash2 size={14} />
                Delete
              </button>
            </>
          ) : null}
        </div>
        <ActiveFilterPills
          filters={view.filters}
          onChange={setFilters}
          onClearAll={() => setView({ ...view, filters: defaultLibraryView.filters })}
        />
      </div>
      {games.length === 0 ? (
        <div className="empty-state">
          <Library size={34} />
          <h2>No games match these filters</h2>
          <p>Try clearing filters or syncing to import games from your paired account.</p>
          {activeCount > 0 ? (
            <button className="primary-action" onClick={() => setView({ ...view, filters: defaultLibraryView.filters })}>
              Clear filters
            </button>
          ) : (
            <button className="primary-action" onClick={onOpenSettings}>
              <Settings size={16} />
              Open settings
            </button>
          )}
        </div>
      ) : (
        <>
          <ProfileScope id="LibraryGrid">
            <div className="library-grid" ref={gridRef} style={gridStyle} onPointerOver={spotlight.onPointerOver} onPointerLeave={spotlight.onPointerLeave}>
              {visibleGames.map((game) => (
                <GameCover key={game.id} game={game} onSelect={onSelect} onContextMenu={onGameContextMenu} />
              ))}
            </div>
          </ProfileScope>
          {hasMoreGames ? <div ref={loadMoreRef} className="library-load-sentinel" aria-hidden="true" /> : null}
        </>
      )}
      <LibraryFiltersPanel
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={view.filters}
        onChange={setFilters}
        onReset={() => setView({ ...view, filters: defaultLibraryView.filters })}
        facets={facets}
        query={query}
        onRequestSmartGroup={onCreateSmartGroup}
      />
    </main>
  );
}

function WishlistSourcePill({ item }: { item: SteamWishlistItem }) {
  if (item.sourceMatches.length === 0) {
    return null;
  }
  const sourceText = item.sourceMatches.map((match) => `${match.sourceName} (${match.count})`).join(", ");
  return (
    <span className="wishlist-source-pill available" title={sourceText}>
      <Download size={12} />
    </span>
  );
}

function wishlistGame(item: SteamWishlistItem): Game {
  return {
    id: `steam:${item.appid}`,
    title: item.title,
    sortTitle: item.sortTitle,
    sourceIds: [{ provider: "steam", externalId: item.appid }],
    installState: "unknown",
    coverUrl: item.coverUrl,
    libraryCapsuleUrl: item.libraryCapsuleUrl,
    headerUrl: item.headerUrl,
    backgroundUrl: item.backgroundUrl,
    logoUrl: item.logoUrl,
    communityIconUrl: item.communityIconUrl,
    screenshots: [],
    genres: [],
    tags: [],
    playerModes: [],
    developers: [],
    publishers: [],
    contentDescriptors: [],
    releaseDate: item.releaseDate,
    metadataStatus: item.metadataStatus
  };
}

function wishlistReleaseLabel(item: SteamWishlistItem): string {
  return formatDate(item.releaseDate) ?? item.releaseDateText ?? "TBA";
}

function wishlistReleaseTime(item: Pick<SteamWishlistItem, "releaseDate" | "releasePrecision">): number | undefined {
  if (item.releasePrecision !== "exact" || !item.releaseDate) return undefined;
  const timestamp = Date.parse(`${item.releaseDate}T00:00:00`);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function todayStartMs(): number {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
}

function isReleasingSoon(item: SteamWishlistItem): boolean {
  const release = wishlistReleaseTime(item);
  if (release === undefined) return false;
  const today = todayStartMs();
  return release >= today && release <= today + 30 * 24 * 60 * 60 * 1000;
}

function isFutureWishlistRelease(item: SteamWishlistItem): boolean {
  const release = wishlistReleaseTime(item);
  if (release === undefined) return false;
  return release > todayStartMs();
}

function isPastTwoWeeks(item: SteamWishlistItem): boolean {
  const release = wishlistReleaseTime(item);
  if (release === undefined) return false;
  const today = todayStartMs();
  return release < today && release >= today - 14 * 24 * 60 * 60 * 1000;
}

function wishlistBadges(item: SteamWishlistItem): ReactNode {
  return (
    <>
      {isReleasingSoon(item) ? <span className="wishlist-cover-pill soon">Releasing soon</span> : null}
      {item.sourceMatches.length > 0 ? <WishlistSourcePill item={item} /> : null}
    </>
  );
}

function wishlistWithSourceMatches(item: SteamWishlistItem, matchesByTitle: Map<string, SourceExactMatch[]>): SteamWishlistItem {
  return {
    ...item,
    sourceMatches: matchesByTitle.get(item.title) ?? item.sourceMatches
  };
}

function monthKey(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${twoDigit(date.getMonth() + 1)}-${twoDigit(date.getDate())}`;
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function WishlistScreen({
  settings,
  onSelect,
  onOpenSettings,
  onCountChanged,
  cardsPerRow
}: {
  settings?: AppSettings;
  onSelect: (item: SteamWishlistItem) => void;
  onOpenSettings: () => void;
  onCountChanged: (count: number) => void;
  cardsPerRow: number;
}) {
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<WishlistViewMode>("list");
  const [items, setItems] = useState<SteamWishlistItem[]>([]);
  const [calendarItems, setCalendarItems] = useState<SteamWishlistItem[]>([]);
  const [sourceMatchesByTitle, setSourceMatchesByTitle] = useState<Map<string, SourceExactMatch[]>>(() => new Map());
  const [visibleCount, setVisibleCount] = useState(LIBRARY_GRID_INITIAL_SIZE);
  const [query, setQuery] = useState("");
  const [sourceAvailability, setSourceAvailability] = useState<"all" | "available" | "missing">("all");
  const [sort, setSort] = useState<WishlistSortField>(defaultWishlistView.sort.field);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">(defaultWishlistView.sort.direction);
  const [accountSteamIds, setAccountSteamIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const dataAppliedAtRef = useRef<number | undefined>();
  const firstCoverLoggedRef = useRef(false);
  const wishlistViewHydratedRef = useRef(false);
  const accounts = settings?.steamAccounts ?? [];
  const normalizedCardsPerRow = normalizeCardsPerRow(cardsPerRow);
  const gridStyle = useMemo(() => cardGridStyle(normalizedCardsPerRow), [normalizedCardsPerRow]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  useEffect(() => {
    if (!settings || wishlistViewHydratedRef.current) return;
    const view = normalizeWishlistView(settings.wishlistView);
    wishlistViewHydratedRef.current = true;
    setSort(view.sort.field);
    setSortDirection(view.sort.direction);
  }, [settings]);

  useEffect(() => {
    if (!wishlistViewHydratedRef.current) return;
    const next = normalizeWishlistView({ sort: { field: sort, direction: sortDirection } });
    void window.hynite.settings.update({ wishlistView: next }).catch((error: unknown) => {
      console.error("Failed to persist wishlistView", error);
    });
  }, [sort, sortDirection]);

  const loadWishlist = useCallback(async () => {
    const details = {
      queryLength: query.trim().length,
      sourceAvailability,
      sort,
      sortDirection,
      accountFilters: accountSteamIds.length,
      cardsPerRow: normalizedCardsPerRow
    };
    const interaction = startRuntimeInteraction("wishlist:load", details);
    const span = profileSpan("wishlist", "wishlist:renderer-load", details);
    setLoading(true);
    setError(undefined);
    try {
      const listSpan = profileSpan("wishlist", "wishlist:renderer-list-ipc", details);
      const calendarSpan = profileSpan("wishlist", "wishlist:renderer-calendar-ipc", { ...details, months: 3 });
      const listPromise = window.hynite.wishlist
        .list({ search: query, sourceAvailability, sort, sortDirection, accountSteamIds })
        .then((result) => {
          listSpan.end("ok", {
            items: result.length,
            withCover: result.filter((item) => Boolean(item.coverUrl ?? item.libraryCapsuleUrl)).length,
            withLogo: result.filter((item) => Boolean(item.logoUrl)).length
          });
          return result;
        })
        .catch((error: unknown) => {
          listSpan.end("error", { error: error instanceof Error ? error.message : String(error) });
          throw error;
        });
      const calendarPromise = window.hynite.wishlist
        .calendar({ startDate: today, months: 3, accountSteamIds })
        .then((result) => {
          calendarSpan.end("ok", { items: result.length });
          return result;
        })
        .catch((error: unknown) => {
          calendarSpan.end("error", { error: error instanceof Error ? error.message : String(error) });
          throw error;
        });
      const [nextItems, nextCalendar] = await Promise.all([listPromise, calendarPromise]);
      const calendarSearch = query.trim().toLocaleLowerCase();
      const filteredCalendar = nextCalendar.filter((item) => {
        if (calendarSearch && !item.title.toLocaleLowerCase().includes(calendarSearch)) return false;
        if (sourceAvailability === "available") return item.sourceMatches.length > 0;
        if (sourceAvailability === "missing") return item.sourceMatches.length === 0;
        return true;
      });
      firstCoverLoggedRef.current = false;
      dataAppliedAtRef.current = performance.now();
      setItems(nextItems);
      setCalendarItems(filteredCalendar);
      setVisibleCount(LIBRARY_GRID_INITIAL_SIZE);
      const countSpan = profileSpan("wishlist", "wishlist:renderer-count-ipc", details);
      const count = await window.hynite.wishlist.count();
      countSpan.end("ok", { count });
      onCountChanged(count);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const visibleItemsAfterLoad = Math.min(nextItems.length, LIBRARY_GRID_INITIAL_SIZE);
          profilePoint("wishlist", "wishlist:first-paint-after-data", {
            ...details,
            items: nextItems.length,
            visibleItems: visibleItemsAfterLoad,
            calendarItems: filteredCalendar.length,
            visibleWithCover: nextItems.slice(0, visibleItemsAfterLoad).filter((item) => Boolean(item.coverUrl ?? item.libraryCapsuleUrl)).length,
            visibleWithLogo: nextItems.slice(0, visibleItemsAfterLoad).filter((item) => Boolean(item.logoUrl)).length
          });
        });
      });
      span.end("ok", { items: nextItems.length, calendarItems: filteredCalendar.length, count });
      interaction.end("ok", { items: nextItems.length, calendarItems: filteredCalendar.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Wishlist could not be loaded.";
      span.end("error", { error: message });
      interaction.end("error", { error: message });
      setError(err instanceof Error ? err.message : "Wishlist could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [accountSteamIds, normalizedCardsPerRow, onCountChanged, query, sort, sortDirection, sourceAvailability, today]);

  useEffect(() => {
    void loadWishlist();
  }, [loadWishlist]);

  async function refreshWishlist() {
    setRefreshing(true);
    setError(undefined);
    try {
      await window.hynite.wishlist.refresh();
      await loadWishlist();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wishlist refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }

  function toggleAccount(steamId: string) {
    setAccountSteamIds((current) => current.includes(steamId) ? current.filter((id) => id !== steamId) : [...current, steamId]);
  }

  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const hasMoreItems = visibleCount < items.length;
  const pastItems = useMemo(() => items.filter(isPastTwoWeeks), [items]);
  const visibleItemsWithSources = useMemo(
    () => visibleItems.map((item) => wishlistWithSourceMatches(item, sourceMatchesByTitle)),
    [sourceMatchesByTitle, visibleItems]
  );
  const pastItemsWithSources = useMemo(
    () => pastItems.map((item) => wishlistWithSourceMatches(item, sourceMatchesByTitle)),
    [pastItems, sourceMatchesByTitle]
  );

  useEffect(() => {
    if (mode !== "list" || !hasMoreItems) return undefined;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return undefined;

    let disconnected = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (disconnected) return;
      disconnected = true;
      observer.disconnect();
      setVisibleCount((current) => {
        const next = Math.min(items.length, current + LIBRARY_GRID_BATCH_SIZE);
        if (next > current) {
          const span = startRuntimeInteraction("wishlist:load-more-batch", {
            fromVisibleItems: current,
            toVisibleItems: next,
            totalItems: items.length
          });
          requestAnimationFrame(() => {
            requestAnimationFrame(() => span.end("ok", { visibleItems: next }));
          });
        }
        return next;
      });
    }, { rootMargin: "540px 0px" });
    observer.observe(sentinel);
    return () => {
      disconnected = true;
      observer.disconnect();
    };
  }, [hasMoreItems, items.length, mode, visibleCount]);

  useEffect(() => {
    profilePoint("wishlist", "wishlist:screen-state", {
      mode,
      items: items.length,
      visibleItems: visibleItems.length,
      calendarItems: calendarItems.length,
      sourceAvailability,
      queryLength: query.trim().length,
      cardsPerRow: normalizedCardsPerRow
    });
    updateRuntimeProfileContext({
      route: "wishlist",
      area: "wishlist",
      wishlistMode: mode,
      wishlistItems: items.length,
      wishlistVisibleItems: visibleItems.length,
      wishlistCalendarItems: calendarItems.length,
      wishlistQuery: query,
      wishlistSourceAvailability: sourceAvailability,
      cardsPerRow: normalizedCardsPerRow
    });
  }, [calendarItems.length, items.length, mode, normalizedCardsPerRow, query, sourceAvailability, visibleItems.length]);

  useEffect(() => {
    if (sourceAvailability !== "all") return;
    const candidateItems = mode === "calendar" ? [...visibleItems, ...pastItems] : visibleItems;
    const candidates = candidateItems
      .filter((item) => !isFutureWishlistRelease(item) && !sourceMatchesByTitle.has(item.title));
    if (candidates.length === 0) return;
    let cancelled = false;
    const batch = [...new Map(candidates.map((item) => [item.title, item])).values()].slice(0, 24);
    const span = profileSpan("wishlist", "wishlist:visible-source-match-batch", {
      candidates: candidates.length,
      batchSize: batch.length,
      visibleItems: visibleItems.length,
      pastItems: pastItems.length
    });
    let cacheHits = 0;
    let matchedTitles = 0;
    const nextMatchesByTitle = new Map<string, SourceExactMatch[]>();
    const pendingTitles: string[] = [];
    for (const item of batch) {
      const cached = sourceAvailabilityCache.get(item.title);
      if (cached) {
        cacheHits += 1;
        if (cached.length > 0) matchedTitles += 1;
        nextMatchesByTitle.set(item.title, cached);
        continue;
      }
      pendingTitles.push(item.title);
    }
    if (nextMatchesByTitle.size > 0) {
      setSourceMatchesByTitle((current) => {
        const next = new Map(current);
        for (const [title, matches] of nextMatchesByTitle) {
          next.set(title, matches);
        }
        return next;
      });
    }
    if (pendingTitles.length === 0) {
      span.end("ok", { pending: 0, cacheHits, matchedTitles });
      return undefined;
    }
    void window.hynite.sources.exactTitleMatchesBatch(pendingTitles)
      .then((results) => {
        for (const result of results) {
          if (result.matches.length > 0) matchedTitles += 1;
          sourceAvailabilityCache.set(result.title, result.matches);
          nextMatchesByTitle.set(result.title, result.matches);
        }
        if (!cancelled) {
          setSourceMatchesByTitle((current) => {
            const next = new Map(current);
            for (const [title, matches] of nextMatchesByTitle) {
              next.set(title, matches);
            }
            return next;
          });
        }
        span.end(cancelled ? "cancelled" : "ok", { pending: pendingTitles.length, cacheHits, matchedTitles });
      })
      .catch((error: unknown) => {
        span.end("error", { pending: pendingTitles.length, cacheHits, matchedTitles, error: error instanceof Error ? error.message : String(error) });
        console.error(error);
      });
    return () => {
      cancelled = true;
      if (pendingTitles.length === 0) span.end("cancelled", { pending: 0, cacheHits, matchedTitles });
    };
  }, [mode, pastItems, sourceAvailability, sourceMatchesByTitle, visibleItems]);

  const dayRows = useMemo(() => {
    const map = new Map<string, SteamWishlistItem[]>();
    for (const item of calendarItems) {
      if (!item.releaseDate) continue;
      const key = item.releaseDate;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    const start = new Date(`${today}T00:00:00`);
    const rows: Array<{ key: string; label: string; month: string; items: SteamWishlistItem[]; monthStart: boolean }> = [];
    for (let index = 0; index < 92; index += 1) {
      const date = addDays(start, index);
      const key = dayKey(date);
      rows.push({
        key,
        label: date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        month: monthKey(key),
        items: map.get(key) ?? [],
        monthStart: index === 0 || date.getDate() === 1
      });
    }
    return rows;
  }, [calendarItems, today]);

  const handleWishlistCoverLoad = useCallback((details: Record<string, unknown>) => {
    if (firstCoverLoggedRef.current) return;
    firstCoverLoggedRef.current = true;
    profilePoint("wishlist", "wishlist:first-cover-loaded", {
      ...details,
      mode,
      msSinceDataApplied: dataAppliedAtRef.current ? Math.round(performance.now() - dataAppliedAtRef.current) : undefined
    });
  }, [mode]);

  const wishlistCoverProfileDetails = useCallback((item: SteamWishlistItem, surface: string): Record<string, unknown> => ({
    area: "wishlist",
    surface,
    appid: item.appid,
    releaseDate: item.releaseDate,
    releasePrecision: item.releasePrecision,
    hasCover: Boolean(item.coverUrl ?? item.libraryCapsuleUrl),
    hasLogo: Boolean(item.logoUrl),
    sourceMatches: item.sourceMatches.length
  }), []);

  if (accounts.length === 0 && items.length === 0 && !loading) {
    return (
      <main className="page">
        <div className="empty-state">
          <CalendarDays size={34} />
          <h2>No paired Steam accounts</h2>
          <p>Pair a Steam account to cache its wishlist.</p>
          <button className="primary-action" type="button" onClick={onOpenSettings}>
            <Settings size={16} />
            Open settings
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="page wishlist-page">
      <div className="library-head wishlist-head">
        <div>
          <h1>Wishlist</h1>
          <p>{items.length} games / {new Set(items.flatMap((item) => item.accounts.map((account) => account.steamId))).size || accounts.length} accounts</p>
        </div>
        <div className="toolbar library-toolbar wishlist-toolbar">
          <div className="segmented-control">
            <button type="button" className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}>All games</button>
            <button type="button" className={mode === "calendar" ? "active" : ""} onClick={() => setMode("calendar")}>Calendar</button>
          </div>
          <button type="button" className="secondary-action" onClick={() => void refreshWishlist()} disabled={refreshing}>
            <RefreshCw size={14} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </div>

      <div className="wishlist-filters">
        <label className="search-box">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search wishlist" />
        </label>
        <select className="plain-select" value={sourceAvailability} onChange={(event) => setSourceAvailability(event.target.value as typeof sourceAvailability)}>
          <option value="all">All sources</option>
          <option value="available">Available</option>
          <option value="missing">Missing</option>
        </select>
        <select className="plain-select" value={sort} onChange={(event) => setSort(event.target.value as WishlistSortField)}>
          <option value="title">Title</option>
          <option value="release">Release</option>
          <option value="added">Added</option>
          <option value="account">Account</option>
        </select>
        <button type="button" className="secondary-action" onClick={() => setSortDirection(sortDirection === "asc" ? "desc" : "asc")} aria-label="Toggle sort direction">
          {sortDirection === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          {sortDirection.toUpperCase()}
        </button>
      </div>

      {accounts.length > 1 ? (
        <div className="wishlist-account-filter">
          {accounts.map((account) => (
            <button
              key={account.steamId}
              type="button"
              className={accountSteamIds.includes(account.steamId) ? "active" : ""}
              onClick={() => toggleAccount(account.steamId)}
            >
              {account.personaName ?? account.steamId}
            </button>
          ))}
        </div>
      ) : null}

      {mode === "list" ? (
        <ProfileScope id="WishlistGrid">
        <div className="wishlist-grid-wrap" aria-busy={loading}>
          <div className="library-grid wishlist-grid" style={gridStyle}>
            {visibleItemsWithSources.map((item) => (
              <GameCover
                key={item.appid}
                game={wishlistGame(item)}
                onSelect={() => onSelect(item)}
                inLibrary={false}
                badges={wishlistBadges(item)}
                profileDetails={wishlistCoverProfileDetails(item, "list")}
                onCoverLoad={handleWishlistCoverLoad}
              />
            ))}
          </div>
          {hasMoreItems ? <div ref={loadMoreRef} className="wishlist-load-more-sentinel" aria-hidden="true" /> : null}
          {!loading && items.length === 0 ? (
            <div className="empty-state">
              <BookOpen size={34} />
              <h2>No wishlist games match these filters</h2>
            </div>
          ) : null}
        </div>
        </ProfileScope>
      ) : (
        <ProfileScope id="WishlistCalendar">
        <div className="wishlist-calendar">
          {pastItems.length > 0 ? (
            <section className="wishlist-past-section">
              <div className="wishlist-month-marker">
                <span>Past 2 weeks</span>
              </div>
              <div className="library-grid wishlist-grid wishlist-past-grid" style={gridStyle}>
                {pastItemsWithSources.map((item) => (
                  <GameCover
                    key={item.appid}
                    game={wishlistGame(item)}
                    onSelect={() => onSelect(item)}
                    inLibrary={false}
                    badges={wishlistBadges(item)}
                    profileDetails={wishlistCoverProfileDetails(item, "calendar-past")}
                    onCoverLoad={handleWishlistCoverLoad}
                  />
                ))}
              </div>
            </section>
          ) : null}
          <div className="wishlist-day-list">
            {dayRows.map((row) => (
              <section key={row.key} className={row.items.length > 0 ? "wishlist-day-row has-items" : "wishlist-day-row"}>
                {row.monthStart ? (
                  <div className="wishlist-month-marker">
                    <span>{row.month}</span>
                  </div>
                ) : null}
                <div className="wishlist-day-heading">
                  <span>{row.label}</span>
                </div>
                {row.items.length > 0 ? (
                  <div className="library-grid wishlist-grid wishlist-day-grid" style={gridStyle}>
                    {row.items.map((item) => (
                      <GameCover
                        key={item.appid}
                        game={wishlistGame(item)}
                        onSelect={() => onSelect(item)}
                        inLibrary={false}
                        badges={wishlistBadges(item)}
                        profileDetails={wishlistCoverProfileDetails(item, "calendar-day")}
                        onCoverLoad={handleWishlistCoverLoad}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            ))}
          </div>
          {!loading && calendarItems.length === 0 && pastItems.length === 0 ? (
            <div className="empty-state">
              <CalendarDays size={34} />
              <h2>No exact-dated wishlist releases in the next 3 months.</h2>
            </div>
          ) : null}
        </div>
        </ProfileScope>
      )}
    </main>
  );
}

function SourcesScreen() {
  const [sources, setSources] = useState<DownloadSourceInfo[]>([]);
  const [addUrl, setAddUrl] = useState("");
  const [addPhase, setAddPhase] = useState<"idle" | "open">("idle");
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();
  const [addResult, setAddResult] = useState<SourceImportResult | undefined>();
  const addJsonRef = useRef<HTMLTextAreaElement>(null);
  const [refreshingId, setRefreshingId] = useState<string | undefined>();
  const [refreshSaving, setRefreshSaving] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const [refreshResult, setRefreshResult] = useState<SourceImportResult | undefined>();
  const refreshJsonRef = useRef<HTMLTextAreaElement>(null);
  const [searchTitle, setSearchTitle] = useState("");
  const [matches, setMatches] = useState<SourceMatch[]>([]);
  const [searchError, setSearchError] = useState<string | undefined>();

  useEffect(() => {
    void window.hynite.sources.list().then(setSources).catch(console.error);
  }, []);

  async function reloadSources() {
    sourceAvailabilityCache.clear();
    setSources(await window.hynite.sources.list());
  }

  function openAddUrl() {
    const trimmed = addUrl.trim();
    if (!trimmed) return;
    void window.hynite.native.openExternal(trimmed);
    setAddPhase("open");
    setAddError(undefined);
    setAddResult(undefined);
  }

  async function saveAddJson() {
    const json = addJsonRef.current?.value.trim() ?? "";
    const urlTrimmed = addUrl.trim();
    if (!json) return;
    setAddSaving(true);
    setAddError(undefined);
    setAddResult(undefined);
    try {
      const result = await window.hynite.sources.import({ kind: "json", value: json, url: urlTrimmed || undefined });
      setAddResult(result);
      setAddUrl("");
      setAddPhase("idle");
      if (addJsonRef.current) addJsonRef.current.value = "";
      await reloadSources();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setAddSaving(false);
    }
  }

  function cancelAdd() {
    setAddPhase("idle");
    setAddError(undefined);
    setAddResult(undefined);
    if (addJsonRef.current) addJsonRef.current.value = "";
  }

  function openRefreshUrl(source: DownloadSourceInfo) {
    if (!source.url) return;
    void window.hynite.native.openExternal(source.url);
    setRefreshingId(source.id);
    setRefreshError(undefined);
    setRefreshResult(undefined);
  }

  async function saveRefreshJson(sourceId: string) {
    const json = refreshJsonRef.current?.value.trim() ?? "";
    if (!json) return;
    setRefreshSaving(true);
    setRefreshError(undefined);
    setRefreshResult(undefined);
    try {
      const result = await window.hynite.sources.refreshSource(sourceId, json);
      setRefreshResult(result);
      setRefreshingId(undefined);
      if (refreshJsonRef.current) refreshJsonRef.current.value = "";
      await reloadSources();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setRefreshSaving(false);
    }
  }

  function cancelRefresh() {
    setRefreshingId(undefined);
    setRefreshError(undefined);
    setRefreshResult(undefined);
    if (refreshJsonRef.current) refreshJsonRef.current.value = "";
  }

  async function removeSource(id: string) {
    if (refreshingId === id) cancelRefresh();
    await window.hynite.sources.remove(id);
    await reloadSources();
  }

  async function searchSources() {
    setSearchError(undefined);
    try {
      setMatches(await window.hynite.sources.searchTitle(searchTitle));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed.");
    }
  }

  async function copy(text: string) {
    await window.hynite.clipboard.copy(text);
  }

  return (
    <div className="source-page settings-source-tab">
      <div className="screen-title">
        <h1>Sources</h1>
        <p>Hydra-compatible JSON sources for download links.</p>
      </div>

      <section className="source-add-section source-panel">
        <h2>Add source</h2>
        <p className="muted source-add-hint">Enter a URL, open it in your browser, then paste the JSON back here.</p>
        <div className="source-url-row">
          <input
            className="plain-input"
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            placeholder="https://example.com/source.json"
            onKeyDown={(e) => { if (e.key === "Enter" && addUrl.trim() && addPhase === "idle") openAddUrl(); }}
          />
          {addPhase === "idle" ? (
            <button className="icon-action" disabled={!addUrl.trim()} onClick={openAddUrl}>
              <ExternalLink size={14} />
              Open in browser
            </button>
          ) : (
            <button className="icon-action" onClick={cancelAdd}>
              <X size={14} />
              Cancel
            </button>
          )}
        </div>
        {addPhase === "open" && (
          <div className="source-paste-area">
            <textarea
              ref={addJsonRef}
              placeholder="Paste the JSON from the page here…"
              autoFocus
            />
            <div className="source-actions">
              <button className="primary-action" disabled={addSaving} onClick={() => void saveAddJson()}>
                {addSaving ? "Saving…" : "Save source"}
              </button>
            </div>
            {addError && <p className="error-line">{addError}</p>}
          </div>
        )}
        {addResult && (
          <p className="result-line">
            Saved <strong>{addResult.name}</strong> — {addResult.importedEntries.toLocaleString()} entries imported, {addResult.skippedEntries} skipped.
          </p>
        )}
      </section>

      {sources.length > 0 && (
        <section className="source-active">
          <div className="section-head">
            <h2>Active sources</h2>
          </div>
          <div className="source-list">
            {sources.map((source) => (
              <div className="source-card" key={source.id}>
                <div className="source-row">
                  <div className="source-row-info">
                    <strong>{source.name}</strong>
                    <span>
                      {source.entryCount.toLocaleString()} entries
                      {source.url ? (
                        <>
                          {" · "}
                          <span className="source-url" title={source.url}>{source.url}</span>
                        </>
                      ) : " · manual import"}
                      {source.lastFetchedAt ? ` · updated ${formatDate(source.lastFetchedAt)}` : ""}
                    </span>
                  </div>
                  <div className="source-row-actions">
                    {source.url && refreshingId !== source.id && (
                      <button className="icon-action" title="Refresh source" onClick={() => openRefreshUrl(source)}>
                        <RefreshCw size={14} />
                        Refresh
                      </button>
                    )}
                    {source.url && refreshingId === source.id && (
                      <button className="icon-action" onClick={cancelRefresh}>
                        <X size={14} />
                        Cancel
                      </button>
                    )}
                    <button className="icon-action danger" title="Remove source" onClick={() => void removeSource(source.id)}>
                      <X size={14} />
                    </button>
                  </div>
                </div>
                {refreshingId === source.id && (
                  <div className="source-paste-area">
                    <p className="muted source-refresh-hint">
                      The page is open in your browser. Copy the raw JSON and paste it below.
                    </p>
                    <textarea
                      ref={refreshJsonRef}
                      placeholder="Paste the updated JSON here…"
                      autoFocus
                    />
                    <div className="source-actions">
                      <button className="primary-action" disabled={refreshSaving} onClick={() => void saveRefreshJson(source.id)}>
                        {refreshSaving ? "Saving…" : "Update source"}
                      </button>
                    </div>
                    {refreshError && <p className="error-line">{refreshError}</p>}
                    {refreshResult && (
                      <p className="result-line">
                        Updated <strong>{refreshResult.name}</strong> — {refreshResult.importedEntries.toLocaleString()} entries imported, {refreshResult.skippedEntries} skipped.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="source-search source-panel">
        <div className="section-head">
          <h2>Search sources</h2>
        </div>
        <div className="source-searchbar">
          <label className="search-box">
            <Search size={15} />
            <input value={searchTitle} onChange={(e) => setSearchTitle(e.target.value)} placeholder="Search by game title" onKeyDown={(e) => { if (e.key === "Enter" && searchTitle.trim()) void searchSources(); }} />
          </label>
          <button className="primary-action" disabled={!searchTitle.trim()} onClick={() => void searchSources()}>
            Search
          </button>
        </div>
        {searchError && <p className="error-line">{searchError}</p>}
        <div className="source-results">
          {matches.length === 0 ? <p className="muted">No matches yet.</p> : null}
          {matches.map((match) => {
            const uploadedAt = formatUploadedAt(match.uploadDate);
            return (
              <div className="match-row" key={match.id}>
                <div>
                  <strong>{match.title}</strong>
                  <span>
                    {[match.sourceName, match.confidence, match.fileSize ?? "size unknown", uploadedAt ? `uploaded ${uploadedAt}` : undefined].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <div className="uri-actions">
                  {match.uris.slice(0, 3).map((uri) => (
                    <button key={uri} className="icon-action" title={uri} onClick={() => void copy(uri)}>
                      <Clipboard size={15} />
                      {uri.startsWith("magnet:") ? "Copy magnet" : "Copy link"}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SteamSearchScreen({ onSelect }: { onSelect: (game: SteamSearchResult) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SteamSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [searched, setSearched] = useState(false);

  async function doSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSearching(true);
    setError(undefined);
    setSearched(false);
    try {
      const found = await window.hynite.steam.search(trimmed);
      setResults(found);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="steam-search-screen">
      <div className="screen-title">
        <h1>Search Steam</h1>
        <p>Browse the Steam catalog.</p>
      </div>
      <div className="steam-search-bar">
        <label className="search-box">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search games…"
            onKeyDown={(e) => { if (e.key === "Enter" && query.trim()) void doSearch(query); }}
            autoFocus
          />
        </label>
        <button className="primary-action" disabled={!query.trim() || searching} onClick={() => void doSearch(query)}>
          {searching ? "Searching…" : "Search"}
        </button>
      </div>
      {error && <p className="error-line">{error}</p>}
      {searched && results.length === 0 && !searching && (
        <p className="muted steam-search-empty">No results for "{query}".</p>
      )}
      <div className="steam-search-grid">
        {results.map((result) => (
          <button key={result.appId} className="steam-search-card" onClick={() => onSelect(result)}>
            <div className="steam-search-capsule">
              <img src={result.capsuleUrl} alt={result.title} loading="lazy" />
            </div>
            <div className="steam-search-info">
              <strong>{result.title}</strong>
              <div className="steam-search-meta">
                {result.releaseDate && <span>{result.releaseDate}</span>}
                {result.reviewSummary && <span className="steam-review">{result.reviewSummary}</span>}
                {result.price && <span className="steam-price">{result.price}</span>}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function progressText(status?: SyncStatus): string {
  if (!status) {
    return "Sync status unavailable";
  }
  const progress = status.total ? ` · ${status.current ?? 0}/${status.total}` : "";
  const backgroundProgress = status.backgroundTotal ? ` · ${status.backgroundCurrent ?? 0}/${status.backgroundTotal}` : "";
  const last = status.lastSuccessAt ? ` · last ${formatDate(status.lastSuccessAt)}` : "";
  if (status.backgroundActive && !status.active) {
    return `Metadata · ${status.backgroundMessage ?? "Updating details"}${backgroundProgress}${last}`;
  }

  return `${status.active ? "Syncing" : "Idle"} · ${status.message}${progress}${last}`;
}

function SyncStatusModal({ status, onClose }: { status?: SyncStatus; onClose: () => void }) {
  return (
    <AnimatePresence>
      <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <motion.section className="settings-modal" initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}>
          <div className="modal-head">
            <div>
              <p className="eyebrow">Steam sync</p>
              <h2>{status?.message ?? "No sync status"}</h2>
            </div>
            <button className="close-button inline-close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="sync-summary">
            <span>{status?.active ? "Running" : "Idle"}</span>
            <span>{status?.phase ?? "idle"}</span>
            <span>
              {status?.total
                ? `${status.current ?? 0}/${status.total}`
                : status?.backgroundActive
                  ? `Metadata ${status.backgroundCurrent ?? 0}/${status.backgroundTotal ?? 0}`
                  : "No active progress"}
            </span>
            <span>{status?.lastSuccessAt ? `Last success ${formatDate(status.lastSuccessAt)}` : "No successful sync yet"}</span>
          </div>
          {status?.backgroundActive ? (
            <div className="sync-background">
              <strong>{status.backgroundMessage ?? "Updating detail metadata"}</strong>
              <span>{status.backgroundPhase ?? "metadata:detail"}</span>
            </div>
          ) : null}
          <div className="sync-log">
            {status?.history.length ? null : <p className="muted">No sync events recorded yet.</p>}
            {status?.history.map((entry) => (
              <div key={entry.id} className={`sync-log-row ${entry.level}`}>
                <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                <div>
                  <strong>{entry.message}</strong>
                  <span>{entry.phase}</span>
                  {entry.details ? <pre>{JSON.stringify(entry.details, null, 2)}</pre> : null}
                </div>
              </div>
            ))}
          </div>
        </motion.section>
      </motion.div>
    </AnimatePresence>
  );
}

function SettingsResetWarningModal({ warning, onClose }: { warning: SettingsHealthWarning; onClose: () => void }) {
  const latest = warning.backups[0];
  return (
    <motion.div className="modal-backdrop switch-dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="name-dialog settings-warning-dialog"
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.14 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-warning-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Settings warning</p>
            <h2 id="settings-warning-title">Settings look reset</h2>
          </div>
          <button className="close-button inline-close" type="button" onClick={onClose} aria-label="Close warning">
            <X size={18} />
          </button>
        </div>
        <div className="name-dialog-body switch-dialog-body">
          <p>{warning.message}</p>
          <p className="muted">Open DevTools console and run <code>await window.__hyniteSettings.list()</code>, then use the restore command printed next to the backup you want. Please report this bug with the backup date.</p>
          {latest ? <code className="settings-warning-command">{latest.restoreCommand}</code> : null}
          <div className="settings-actions">
            <button className="primary-action" type="button" onClick={onClose}>
              I understand
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function LaunchFailureModal({
  failure,
  onClose,
  onReport
}: {
  failure: LaunchFailurePromptState;
  onClose: () => void;
  onReport: () => void;
}) {
  const title = failure.gameTitle ?? "Game";
  const reportLabel =
    failure.reportStatus === "sending"
      ? "Reporting..."
      : failure.reportStatus === "sent"
        ? "Reported"
        : "Report";

  return (
    <motion.div className="modal-backdrop switch-dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="name-dialog launch-error-dialog"
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.14 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-error-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Launch failed</p>
            <h2 id="launch-error-title">{title}</h2>
          </div>
          <button className="close-button inline-close" type="button" onClick={onClose} aria-label="Close launch error">
            <X size={18} />
          </button>
        </div>
        <div className="name-dialog-body launch-error-body">
          <p>{failure.message}</p>
          {failure.path ? <code className="launch-error-code">{failure.path}</code> : null}
          <p className="muted">{failure.technicalMessage}</p>
          {failure.reportStatus === "sent" ? (
            <p className="launch-error-status">Report sent{failure.reportEventId ? `: ${failure.reportEventId}` : "."}</p>
          ) : failure.reportStatus === "failed" ? (
            <p className="launch-error-status error-line">{failure.reportError ?? "Report failed."}</p>
          ) : null}
          <div className="launch-error-actions">
            <button className="secondary-action" type="button" onClick={onClose}>
              Dismiss
            </button>
            <button
              className="primary-action"
              type="button"
              onClick={onReport}
              disabled={failure.reportStatus === "sending" || failure.reportStatus === "sent"}
            >
              <Bug size={14} />
              {reportLabel}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

type SettingsTab = "steam" | "metadata" | "sources" | "audio" | "view" | "bigPicture" | "controller" | "advanced";

function soundFileName(filePath?: string): string {
  if (!filePath) {
    return "No file selected";
  }
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function musicTrackLabel(track: NonNullable<MusicSettings["tracks"]>[number]): string {
  return track.title || soundFileName(track.filePath);
}

function CurrentTrackCredit({ status }: { status: MusicStatus }) {
  const [coverFailed, setCoverFailed] = useState(false);
  const trackIndex = status.currentTrackIndex;
  const title = status.currentTrackTitle ?? "Unknown track";
  const artist = status.currentTrackArtist ?? "Unknown artist";
  const album = status.currentTrackAlbum ?? "Unknown album";
  const chipLabel = status.currentTrackCopyright ?? status.currentTrackArtist ?? status.currentTrackTitle;
  const coverUrl = trackIndex === null || coverFailed ? undefined : window.hynite.music.coverUrl(trackIndex);

  useEffect(() => {
    setCoverFailed(false);
  }, [trackIndex]);

  if (!chipLabel) {
    return null;
  }

  return (
    <span className="music-copyright-wrap">
      <span
        className="music-copyright-chip"
        tabIndex={0}
        aria-describedby="current-track-tooltip"
        aria-label={`Music credit: ${chipLabel}. Currently playing ${title}, ${album}, ${artist}.`}
      >
        <Music2 size={10} />
        {chipLabel}
      </span>
      <span className="current-track-tooltip" id="current-track-tooltip" role="tooltip">
        <span className="current-track-cover">
          {coverUrl ? (
            <img src={coverUrl} alt="" onError={() => setCoverFailed(true)} />
          ) : (
            <Music2 size={24} />
          )}
        </span>
        <span className="current-track-details">
          <span className="current-track-kicker">Currently playing</span>
          <strong>{title}</strong>
          <span>{album}</span>
          <span>{artist}</span>
        </span>
      </span>
    </span>
  );
}

function soundSettingsPatch(settings: SoundSettings | undefined, patch: Partial<SoundSettings>): SoundSettings {
  return normalizeSoundSettings({
    ...normalizeSoundSettings(settings),
    ...patch
  });
}

function soundEffectUpdate(
  settings: SoundSettings | undefined,
  effectId: SoundEffectId,
  patch: Partial<SoundEffectSettings>
): SoundSettings {
  const current = normalizeSoundSettings(settings);
  return normalizeSoundSettings({
    ...current,
    effects: {
      ...current.effects,
      [effectId]: {
        ...current.effects?.[effectId],
        ...patch
      }
    }
  });
}

function musicSettingsPatch(settings: MusicSettings | undefined, patch: Partial<MusicSettings>): MusicSettings {
  return normalizeMusicSettings({
    ...normalizeMusicSettings(settings),
    ...patch
  });
}

function msToSeconds(value: number | undefined): number {
  return Math.round(((value ?? 0) / 1000) * 10) / 10;
}

function secondsToMs(value: string): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
}

type MusicTimingKey = "trackFadeInMs" | "pauseFadeOutMs" | "resumeFadeInMs" | "gameLaunchFadeOutMs";

const MUSIC_FADE_CONTROLS: Array<{ label: string; key: MusicTimingKey; max: number }> = [
  { label: "Track", key: "trackFadeInMs", max: 30 },
  { label: "Pause", key: "pauseFadeOutMs", max: 30 },
  { label: "Resume", key: "resumeFadeInMs", max: 30 },
  { label: "Launch", key: "gameLaunchFadeOutMs", max: 10 }
];

function musicTimingPatch(key: MusicTimingKey, value: string): Partial<MusicSettings> {
  return { [key]: secondsToMs(value) };
}

function SettingsScreen({
  settings,
  setSettings,
  syncStatus,
  syncBusy,
  onSync,
  onSeed,
  onLibraryCleared
}: {
  settings?: AppSettings;
  setSettings: (settings: AppSettings) => void;
  syncStatus?: SyncStatus;
  syncBusy: boolean;
  onSync: () => void;
  onSeed: () => void;
  onLibraryCleared: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("steam");
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [steamGridDbKey, setSteamGridDbKey] = useState("");
  const [igdbClientId, setIgdbClientId] = useState("");
  const [igdbClientSecret, setIgdbClientSecret] = useState("");
  const [steamMessage, setSteamMessage] = useState<string | undefined>();
  const [metadataMessage, setMetadataMessage] = useState<string | undefined>();
  const [devMessage, setDevMessage] = useState<string | undefined>();
  const [resettingEverything, setResettingEverything] = useState(false);
  const [localAccounts, setLocalAccounts] = useState<SteamLocalAccount[]>([]);
  const [activeSteamUser, setActiveSteamUser] = useState<string | undefined>();
  const [pairing, setPairing] = useState(false);
  const [expandedExtras, setExpandedExtras] = useState<Record<string, boolean>>({});
  const [soundDraft, setSoundDraft] = useState<SoundSettings>(() => normalizeSoundSettings(settings?.sound));
  const soundSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const [musicDraft, setMusicDraft] = useState<MusicSettings>(() => normalizeMusicSettings(settings?.music));
  const musicSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const [controllerCapture, setControllerCapture] = useState<ControllerActionId | undefined>();
  const controllerCaptureRef = useRef<ControllerActionId | undefined>();
  const [spotlightState, setSpotlightState] = useState<SpotlightState | undefined>();
  const [spotlightCapture, setSpotlightCapture] = useState(false);

  useEffect(() => {
    void window.hynite.steam.listLocalAccounts().then(setLocalAccounts).catch(() => undefined);
    void window.hynite.steam.getActiveUser().then((info) => setActiveSteamUser(info.accountName)).catch(() => undefined);
  }, [settings?.steamAccounts.length]);

  useEffect(() => {
    setSoundDraft(normalizeSoundSettings(settings?.sound));
  }, [settings?.sound]);

  useEffect(() => {
    setMusicDraft(normalizeMusicSettings(settings?.music));
  }, [settings?.music]);

  useEffect(() => {
    controllerCaptureRef.current = controllerCapture;
  }, [controllerCapture]);

  useEffect(() => {
    void window.hynite.spotlight.state().then(setSpotlightState).catch(() => undefined);
  }, [settings?.spotlight?.enabled, settings?.spotlight?.hotkey]);

  useEffect(() => {
    if (!spotlightCapture) return;
    const stopResultListener = window.hynite.spotlight.onHotkeyCaptureResult((accelerator) => {
      setSpotlightCapture(false);
      if (accelerator) {
        void updateSpotlightSetting({ hotkey: accelerator });
      }
    });
    void window.hynite.spotlight.startHotkeyCapture();
    return () => {
      stopResultListener();
      void window.hynite.spotlight.stopHotkeyCapture();
    };
  }, [spotlightCapture]);

  useEffect(() => {
    if (!controllerCapture) return;
    let raf = 0;
    const poll = () => {
      const action = controllerCaptureRef.current;
      const nextBinding = firstPressedBinding(pressedButtonIndexes(navigator.getGamepads ? [...navigator.getGamepads()] : []));
      if (action && nextBinding) {
        void updateControllerBinding(action, nextBinding);
        setControllerCapture(undefined);
        return;
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [controllerCapture]);

  useEffect(() => {
    return () => {
      if (soundSaveTimerRef.current) {
        clearTimeout(soundSaveTimerRef.current);
      }
      if (musicSaveTimerRef.current) {
        clearTimeout(musicSaveTimerRef.current);
      }
    };
  }, []);

  async function pairSteam() {
    setSteamMessage(undefined);
    setPairing(true);
    try {
      await window.hynite.steam.pair();
      setSettings(await window.hynite.settings.get());
      setSteamMessage(undefined);
    } catch (error) {
      setSteamMessage(error instanceof Error ? error.message : "Failed to pair Steam account.");
    } finally {
      setPairing(false);
    }
  }

  async function saveApiKey() {
    setSteamMessage(undefined);
    const trimmed = apiKeyDraft.trim();
    if (!trimmed) return;
    const next = await window.hynite.steam.saveApiKey(trimmed);
    setSettings(next);
    setApiKeyDraft("");
    setSteamMessage("Steam Web API key saved.");
  }

  async function clearApiKey() {
    setSteamMessage(undefined);
    const next = await window.hynite.steam.clearApiKey();
    setSettings(next);
    setSteamMessage("Steam Web API key removed.");
  }

  async function removeAccount(steamId: string) {
    const next = await window.hynite.steam.removeAccount(steamId);
    setSettings(next);
    setSteamMessage("Steam account removed.");
  }

  async function connectFamilyLibrary(steamId: string) {
    setSteamMessage(undefined);
    try {
      const next = await window.hynite.steam.connectFamily(steamId);
      setSettings(next);
      setSteamMessage("Steam family library connected.");
    } catch (error) {
      setSteamMessage(error instanceof Error ? error.message : "Failed to connect family library.");
    }
  }

  async function disconnectFamilyLibrary(steamId: string) {
    const next = await window.hynite.steam.disconnectFamily(steamId);
    setSettings(next);
    setSteamMessage("Steam family library disconnected.");
  }

  async function setLocalUsername(steamId: string, value: string) {
    const next = await window.hynite.steam.setAccountLocalUsername(steamId, value || undefined);
    setSettings(next);
  }

  async function saveSteamGridDbKey() {
    setMetadataMessage(undefined);
    const next = await window.hynite.metadata.saveSteamGridDbKey(steamGridDbKey);
    setSettings(next);
    setSteamGridDbKey("");
    setMetadataMessage("SteamGridDB fallback saved.");
  }

  async function clearSteamGridDbKey() {
    setMetadataMessage(undefined);
    const next = await window.hynite.metadata.clearSteamGridDbKey();
    setSettings(next);
    setSteamGridDbKey("");
    setMetadataMessage("SteamGridDB fallback disabled.");
  }

  async function saveIgdbCredentials() {
    setMetadataMessage(undefined);
    const clientId = igdbClientId.trim();
    const clientSecret = igdbClientSecret.trim();
    if (!clientId || !clientSecret) return;
    const next = await window.hynite.metadata.saveIgdbCredentials(clientId, clientSecret);
    setSettings(next);
    setIgdbClientId("");
    setIgdbClientSecret("");
    setMetadataMessage("IGDB credentials saved.");
  }

  async function clearIgdbCredentials() {
    setMetadataMessage(undefined);
    const next = await window.hynite.metadata.clearIgdbCredentials();
    setSettings(next);
    setIgdbClientId("");
    setIgdbClientSecret("");
    setMetadataMessage("IGDB credentials removed.");
  }

  async function clearLibrary() {
    const result = await window.hynite.library.clear();
    onLibraryCleared();
    setSteamMessage(`Cleared ${result.cleared} games from the local library.`);
  }

  async function resetEverything() {
    const confirmed = window.confirm(
      "Reset all Hynite data? This deletes library data, settings, accounts, source catalogs, cached assets, diagnostics, profile runs, and local UI storage, then restarts Hynite."
    );
    if (!confirmed) return;
    const confirmedAgain = window.confirm("Last chance: reset EVERYTHING and restart?");
    if (!confirmedAgain) return;
    setDevMessage("Resetting all app data and restarting...");
    setResettingEverything(true);
    try {
      const result = await window.hynite.debug.resetEverything();
      if (result.failed.length > 0) {
        setDevMessage(`Reset requested. ${result.failed.length} entries could not be removed before restart.`);
      }
    } catch (error) {
      setResettingEverything(false);
      setDevMessage(error instanceof Error ? error.message : "Failed to reset app data.");
    }
  }

  async function setAutoHideAfterLaunch(value: boolean) {
    const next = await window.hynite.settings.update({ autoHideAfterLaunch: value });
    setSettings(next);
  }

  async function updateBackgroundSetting(patch: Partial<Pick<AppSettings, "startWithWindows" | "closeToTray" | "backgroundUpdatesEnabled" | "backgroundWorkload" | "backgroundPlaytimeTracking" | "crashReportingEnabled">>) {
    const next = await window.hynite.settings.update(patch);
    setSettings(next);
  }

  async function updateSpotlightSetting(patch: Partial<NonNullable<AppSettings["spotlight"]>>) {
    const current = settings?.spotlight ?? { enabled: true, hotkey: "Alt+Space" };
    const next = await window.hynite.settings.update({ spotlight: { ...current, ...patch } });
    setSettings(next);
    setSpotlightState(await window.hynite.spotlight.state());
  }

  async function setCardsPerRow(value: number) {
    const next = await window.hynite.settings.update({ cardsPerRow: normalizeCardsPerRow(value) });
    setSettings(next);
  }

  async function updateBigPictureSetting(patch: Partial<Pick<AppSettings, "bigPictureGrayscaleCovers" | "bigPictureDefaultTabId">>) {
    const next = await window.hynite.settings.update(patch);
    setSettings(next);
  }

  async function updateController(controller: ControllerSettings) {
    const next = await window.hynite.settings.update({ controller });
    setSettings(next);
  }

  async function updateControllerBinding(action: ControllerActionId, binding: ControllerButtonBinding) {
    const controller = normalizeControllerSettings(settings);
    await updateController({
      ...controller,
      bindings: {
        ...controller.bindings,
        [action]: binding
      }
    });
  }

  async function updateSound(sound: SoundSettings) {
    if (soundSaveTimerRef.current) {
      clearTimeout(soundSaveTimerRef.current);
      soundSaveTimerRef.current = undefined;
    }
    setSoundDraft(sound);
    soundEngine.applySettings(sound);
    const next = await window.hynite.settings.update({ sound });
    soundEngine.applySettings(next);
    setSoundDraft(normalizeSoundSettings(next.sound));
    setSettings(next);
  }

  function previewSound(sound: SoundSettings) {
    setSoundDraft(sound);
    soundEngine.applySettings(sound);
  }

  function scheduleSoundUpdate(sound: SoundSettings) {
    previewSound(sound);
    if (soundSaveTimerRef.current) {
      clearTimeout(soundSaveTimerRef.current);
    }
    soundSaveTimerRef.current = setTimeout(() => {
      soundSaveTimerRef.current = undefined;
      void updateSound(sound).catch(console.error);
    }, 250);
  }

  async function setMasterSoundVolume(value: number) {
    scheduleSoundUpdate(soundSettingsPatch(soundDraft, { masterVolume: value }));
  }

  async function setSoundMuted(value: boolean) {
    await updateSound(soundSettingsPatch(soundDraft, { muted: value }));
  }

  async function setEffectSound(effectId: SoundEffectId, patch: Partial<SoundEffectSettings>) {
    await updateSound(soundEffectUpdate(soundDraft, effectId, patch));
  }

  function setEffectSoundVolume(effectId: SoundEffectId, value: number) {
    scheduleSoundUpdate(soundEffectUpdate(soundDraft, effectId, { volume: value }));
  }

  async function chooseSoundFile(effectId: SoundEffectId) {
    const filePath = await window.hynite.dialog.pickFile({
      title: "Select sound effect",
      filters: [
        { name: "Audio", extensions: ["wav", "mp3", "ogg", "opus", "m4a", "aac", "flac", "webm"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (!filePath) {
      return;
    }
    await setEffectSound(effectId, { filePath, enabled: true, source: "custom" });
  }

  async function updateMusic(music: MusicSettings) {
    if (musicSaveTimerRef.current) {
      clearTimeout(musicSaveTimerRef.current);
      musicSaveTimerRef.current = undefined;
    }
    setMusicDraft(music);
    musicEngine.applySettings(music);
    const next = await window.hynite.settings.update({ music });
    musicEngine.applySettings(next);
    setMusicDraft(normalizeMusicSettings(next.music));
    setSettings(next);
  }

  function previewMusic(music: MusicSettings) {
    setMusicDraft(music);
    musicEngine.applySettings(music);
  }

  function scheduleMusicUpdate(music: MusicSettings) {
    previewMusic(music);
    if (musicSaveTimerRef.current) {
      clearTimeout(musicSaveTimerRef.current);
    }
    musicSaveTimerRef.current = setTimeout(() => {
      musicSaveTimerRef.current = undefined;
      void updateMusic(music).catch(console.error);
    }, 250);
  }

  async function addMusicTrack() {
    const filePaths = await window.hynite.dialog.pickFiles({
      title: "Add music tracks",
      filters: [
        { name: "Audio", extensions: ["mp3", "ogg", "wav", "flac", "m4a", "aac", "webm", "opus"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (!filePaths.length) return;
    const current = normalizeMusicSettings(musicDraft);
    const existing = new Set((current.tracks ?? []).map((t) => t.filePath));
    const newTracks = filePaths.filter((p) => !existing.has(p)).map((filePath) => ({ filePath, source: "custom" as const }));
    if (!newTracks.length) return;
    await updateMusic({ ...current, tracks: [...(current.tracks ?? []), ...newTracks] });
  }

  async function removeMusicTrack(index: number) {
    const current = normalizeMusicSettings(musicDraft);
    const tracks = [...(current.tracks ?? [])];
    tracks.splice(index, 1);
    await updateMusic({ ...current, tracks });
  }

  const soundSettings = soundDraft;
  const musicSettings = musicDraft;
  const controllerSettings = normalizeControllerSettings(settings);
  const musicTracks = musicSettings.tracks ?? [];
  const bundledMusicCount = musicTracks.filter((track) => track.source === "bundled").length;
  const customMusicCount = musicTracks.length - bundledMusicCount;
  const musicCopyrights = Array.from(new Set(musicTracks.map((track) => track.copyright).filter(Boolean)));
  const musicCopyrightSummary = musicCopyrights.length > 0 ? musicCopyrights.join(" · ") : "No copyright metadata";
  const cardsPerRow = normalizeCardsPerRow(settings?.cardsPerRow);

  return (
    <main className="page settings-page">
      <div className="screen-title">
        <h1>Settings</h1>
        <p>Steam account, metadata providers, source imports, and local maintenance.</p>
      </div>

      <button className="sync-status-line" onClick={() => setShowSyncModal(true)}>
        <span className={syncStatus?.active || syncStatus?.backgroundActive ? "status-dot active-sync" : "status-dot"} />
        <span>{progressText(syncStatus)}</span>
      </button>

      <section className="settings-shell">
        <nav className="settings-tabs">
          {[
            ["steam", "Steam"],
            ["metadata", "Metadata"],
            ["sources", "Sources"],
            ["audio", "Audio"],
            ["view", "View"],
            ["bigPicture", "Big Picture"],
            ["controller", "Controller"],
            ["advanced", "Advanced"]
          ].map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id as SettingsTab)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          {tab === "steam" ? (
            <section className="settings-section">
              <div className="steam-tab-header">
                <div>
                  <h2>Steam accounts</h2>
                  <p className="settings-hint" style={{ margin: "4px 0 0" }}>
                    Sign in once per account. Hynite switches accounts automatically when you launch a game owned by another one.
                  </p>
                </div>
                <button className="primary-action" disabled={pairing} onClick={() => void pairSteam()}>
                  <Link2 size={16} />
                  {pairing ? "Waiting for Steam…" : "Add Steam account"}
                </button>
                <button className="primary-action" disabled={syncBusy} onClick={onSync}>
                  <RefreshCw size={16} />
                  {syncBusy ? "Syncing" : "Sync Steam"}
                </button>
              </div>

              {/* Single Web API key, shared by every paired account. */}
              <div className="steam-account-card">
                <div className="steam-account-card-head">
                  <div className="steam-account-identity">
                    <strong>Steam Web API key</strong>
                    <span className="settings-hint" style={{ display: "block", marginTop: 4 }}>
                      One key works for every paired account.{" "}
                      <a
                        href="https://steamcommunity.com/dev/apikey"
                        onClick={(event) => {
                          event.preventDefault();
                          void window.hynite.native.openExternal("https://steamcommunity.com/dev/apikey");
                        }}
                      >
                        Get one
                      </a>
                    </span>
                  </div>
                  <span className={`steam-status-pill ${settings?.steamWebApiKey ? "ready" : "warn"}`}>
                    {settings?.steamWebApiKey ? "Saved" : "Required"}
                  </span>
                </div>
                <div className="api-key-row">
                  <input
                    className="plain-input"
                    type="password"
                    value={apiKeyDraft}
                    onChange={(event) => setApiKeyDraft(event.target.value)}
                    placeholder={settings?.steamWebApiKey ? "Replace key…" : "Paste Steam Web API key"}
                  />
                  <button className="primary-action" disabled={!apiKeyDraft.trim()} onClick={() => void saveApiKey()}>
                    <KeyRound size={16} />
                    Save
                  </button>
                  {settings?.steamWebApiKey ? (
                    <button className="secondary-action" onClick={() => void clearApiKey()}>
                      <LogOut size={14} />
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>

              {activeSteamUser ? (
                <div className="steam-active-banner">
                  Currently active in Steam: <code>{activeSteamUser}</code>
                </div>
              ) : null}

              {(settings?.steamAccounts ?? []).length === 0 ? (
                <div className="steam-empty-state">
                  <strong>No Steam accounts yet</strong>
                  <span>Add one to import its library and launch from it.</span>
                </div>
              ) : null}

              {(settings?.steamAccounts ?? []).map((account: SteamAccountSettings) => {
                const needsLocalMap = !account.localUsername;
                const issueCount = needsLocalMap ? 1 : 0;
                const ready = issueCount === 0;
                const expanded = expandedExtras[account.steamId] ?? false;
                const isActive = activeSteamUser && account.localUsername && activeSteamUser.toLowerCase() === account.localUsername.toLowerCase();
                return (
                  <div key={account.steamId} className="steam-account-card">
                    <div className="steam-account-card-head">
                      <div className="steam-account-identity">
                        <strong>
                          {account.personaName ?? account.localUsername ?? "Steam account"}
                          {isActive ? <span className="settings-hint" style={{ marginLeft: 8 }}>· active in Steam</span> : null}
                        </strong>
                        <span className="steam-id">SteamID {account.steamId}</span>
                      </div>
                      <div className="steam-actions">
                        <span className={`steam-status-pill ${ready ? "ready" : "warn"}`}>
                          {ready ? "Ready" : "Needs local user"}
                        </span>
                        <button className="secondary-action" onClick={() => void removeAccount(account.steamId)} title="Remove account">
                          <LogOut size={16} />
                        </button>
                      </div>
                    </div>

                    {needsLocalMap ? (
                      <div className="steam-account-issues">
                        <div className="steam-account-issue">
                          <label>
                            {localAccounts.length === 0
                              ? "No local Steam users found — sign in to Steam at least once with this account, then come back."
                              : "Couldn't auto-detect this account locally. Pick which local Steam user it signs in as so Hynite can switch to it."}
                          </label>
                          {localAccounts.length > 0 ? (
                            <div className="row">
                              <select
                                className="plain-input"
                                value={account.localUsername ?? ""}
                                onChange={(event) => void setLocalUsername(account.steamId, event.target.value)}
                              >
                                <option value="">Choose local Steam user…</option>
                                {localAccounts.map((local) => (
                                  <option key={local.accountName} value={local.accountName}>
                                    {local.accountName}
                                    {local.personaName ? ` — ${local.personaName}` : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    <div className="steam-account-extras">
                      <span className="extras-label">
                        {account.familySession ? (
                          <>Family library connected · renews automatically</>
                        ) : (
                          <>Family library not connected (optional)</>
                        )}
                      </span>
                      <div className="steam-actions">
                        {!expanded ? (
                          <button
                            className="steam-link-button"
                            onClick={() => setExpandedExtras((prev) => ({ ...prev, [account.steamId]: true }))}
                          >
                            More…
                          </button>
                        ) : (
                          <>
                            <button className="secondary-action" onClick={() => void connectFamilyLibrary(account.steamId)}>
                              <Link2 size={14} />
                              {account.familySession ? "Reconnect family" : "Connect family"}
                            </button>
                            {account.familySession ? (
                              <>
                                <button className="secondary-action" onClick={() => void disconnectFamilyLibrary(account.steamId)}>
                                  <LogOut size={14} />
                                  Disconnect
                                </button>
                              </>
                            ) : null}
                            <button
                              className="steam-link-button"
                              onClick={() => setExpandedExtras((prev) => ({ ...prev, [account.steamId]: false }))}
                            >
                              Less
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {steamMessage ? <p className="result-line">{steamMessage}</p> : null}
            </section>
          ) : null}

          {tab === "metadata" ? (
            <section className="settings-section">
              <h2>Metadata</h2>
              <div className="steam-account-row">
                <div>
                  <strong>{settings?.steamGridDbApiKey ? "SteamGridDB configured" : "SteamGridDB not configured"}</strong>
                  <span>Optional fallback for missing vertical covers. Steam official assets remain the first source.</span>
                </div>
                <button className="secondary-action" disabled={!settings?.steamGridDbApiKey} onClick={() => void clearSteamGridDbKey()}>
                  <X size={16} />
                  Clear
                </button>
              </div>
              <div className="api-key-row">
                <input
                  className="plain-input"
                  type="password"
                  value={steamGridDbKey}
                  onChange={(event) => setSteamGridDbKey(event.target.value)}
                  placeholder="SteamGridDB API key"
                />
                <button className="primary-action" disabled={!steamGridDbKey.trim()} onClick={() => void saveSteamGridDbKey()}>
                  <KeyRound size={16} />
                  Save key
                </button>
              </div>
              <div className="steam-account-row">
                <div>
                  <strong>{settings?.igdb ? "IGDB configured" : "IGDB not configured"}</strong>
                  <span>
                    Optional Twitch app credentials for IGDB local game metadata and artwork.{" "}
                    <a
                      href={TWITCH_DEVELOPER_APPS_URL}
                      onClick={(event) => {
                        event.preventDefault();
                        void window.hynite.native.openExternal(TWITCH_DEVELOPER_APPS_URL);
                      }}
                    >
                      Create an app
                    </a>
                  </span>
                </div>
                <button className="secondary-action" disabled={!settings?.igdb} onClick={() => void clearIgdbCredentials()}>
                  <X size={16} />
                  Clear
                </button>
              </div>
              <div className="api-key-row">
                <input
                  className="plain-input"
                  type="text"
                  value={igdbClientId}
                  onChange={(event) => setIgdbClientId(event.target.value)}
                  placeholder={settings?.igdb ? "Replace IGDB client ID" : "Twitch client ID"}
                />
                <input
                  className="plain-input"
                  type="password"
                  value={igdbClientSecret}
                  onChange={(event) => setIgdbClientSecret(event.target.value)}
                  placeholder={settings?.igdb ? "Replace IGDB client secret" : "Twitch client secret"}
                />
                <button className="primary-action" disabled={!igdbClientId.trim() || !igdbClientSecret.trim()} onClick={() => void saveIgdbCredentials()}>
                  <KeyRound size={16} />
                  Save credentials
                </button>
              </div>
              {metadataMessage ? <p className="result-line">{metadataMessage}</p> : null}
            </section>
          ) : null}

          {tab === "sources" ? <SourcesScreen /> : null}

          {tab === "view" ? (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>View</h2>
                  <p className="settings-hint">Controls shared by Home rows and the Library grid.</p>
                </div>
                <strong>{cardsPerRow} cards</strong>
              </div>
              <label className="view-slider-row settings-view-slider">
                <span>Cards per row</span>
                <input
                  type="range"
                  min={MIN_CARDS_PER_ROW}
                  max={MAX_CARDS_PER_ROW}
                  step={1}
                  value={cardsPerRow}
                  onChange={(event) => void setCardsPerRow(Number(event.currentTarget.value))}
                />
                <strong>{cardsPerRow}</strong>
              </label>
            </section>
          ) : null}

          {tab === "bigPicture" ? (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h2>Big Picture</h2>
                  <p className="settings-hint">Fullscreen library behavior for TV and controller use.</p>
                </div>
              </div>
              <label className="settings-toggle-row">
                <input
                  type="checkbox"
                  checked={settings?.bigPictureGrayscaleCovers !== false}
                  onChange={(event) => void updateBigPictureSetting({ bigPictureGrayscaleCovers: event.currentTarget.checked })}
                />
                <span className="settings-toggle-control" aria-hidden="true" />
                <span>
                  <strong>Grayscale unfocused shelf covers</strong>
                  <em>Focused covers stay full color; the grid always stays full color.</em>
                </span>
              </label>
              <div className="steam-account-row">
                <div>
                  <strong>Startup folder</strong>
                  <span>{settings?.bigPictureDefaultTabId ? settings.bigPictureDefaultTabId.replace(/^group:/, "Group: ") : "Use the first available folder"}</span>
                </div>
                <button
                  className="secondary-action"
                  disabled={!settings?.bigPictureDefaultTabId}
                  onClick={() => void updateBigPictureSetting({ bigPictureDefaultTabId: undefined })}
                >
                  <RotateCcw size={14} />
                  Reset
                </button>
              </div>
              <p className="settings-hint">Use the star button in Big Picture on a group folder to make it the startup folder.</p>
            </section>
          ) : null}

          {tab === "audio" ? (
            <section className="settings-section audio-settings">
              <div className="settings-section-head">
                <div>
                  <h2>Audio</h2>
                  <p className="settings-hint">Bundled defaults are used automatically; custom files override or extend them.</p>
                </div>
                <div className="audio-head-actions">
                  <button className="secondary-action" onClick={() => void setSoundMuted(!soundSettings.muted)}>
                    {soundSettings.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                    {soundSettings.muted ? "Effects muted" : "Effects on"}
                  </button>
                  <button
                    className="secondary-action"
                    onClick={() => void updateMusic(musicSettingsPatch(musicSettings, { enabled: musicSettings.enabled === false }))}
                  >
                    {musicSettings.enabled === false ? <VolumeX size={16} /> : <Music2 size={16} />}
                    {musicSettings.enabled === false ? "Music off" : "Music on"}
                  </button>
                </div>
              </div>

              <div className="audio-volume-grid">
                <label className="sound-volume-row">
                  <span>Effects</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={soundSettings.masterVolume}
                    onChange={(event) => void setMasterSoundVolume(Number(event.currentTarget.value))}
                    onPointerUp={(event) => void updateSound(soundSettingsPatch(soundDraft, { masterVolume: Number(event.currentTarget.value) }))}
                    onKeyUp={(event) => void updateSound(soundSettingsPatch(soundDraft, { masterVolume: Number(event.currentTarget.value) }))}
                  />
                  <strong>{Math.round(soundSettings.masterVolume * 100)}%</strong>
                </label>
                <label className="sound-volume-row">
                  <span>Music</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={musicSettings.volume ?? 0.04}
                    onChange={(e) => scheduleMusicUpdate(musicSettingsPatch(musicSettings, { volume: Number(e.currentTarget.value) }))}
                    onPointerUp={(e) => void updateMusic(musicSettingsPatch(musicSettings, { volume: Number(e.currentTarget.value) }))}
                    onKeyUp={(e) => void updateMusic(musicSettingsPatch(musicSettings, { volume: Number(e.currentTarget.value) }))}
                  />
                  <strong>{Math.round((musicSettings.volume ?? 0.04) * 100)}%</strong>
                </label>
              </div>

              <details className="settings-disclosure audio-disclosure">
                <summary>
                  <span>Sound effects</span>
                  <em>{SOUND_EFFECT_DEFINITIONS.length} predefined sounds</em>
                </summary>
                <div className="audio-effect-list">
                  {SOUND_EFFECT_DEFINITIONS.map((definition) => {
                    const effect = soundSettings.effects?.[definition.id];
                    const enabled = effect?.enabled !== false;
                    const isCustom = effect?.source === "custom";
                    return (
                      <div key={definition.id} className="audio-effect-row">
                        <div className="audio-effect-title">
                          <strong>{definition.label}</strong>
                          <code title={effect?.filePath}>
                            {isCustom ? soundFileName(effect?.filePath) : `Default: ${soundFileName(effect?.filePath)}`}
                          </code>
                        </div>
                        <label className="settings-toggle-row compact-toggle">
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(event) => void setEffectSound(definition.id, { enabled: event.currentTarget.checked })}
                          />
                          <span className="settings-toggle-control" aria-hidden="true" />
                          <span>
                            <strong>On</strong>
                          </span>
                        </label>
                        <label className="sound-volume-row effect-volume">
                          <span>Vol</span>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={effect?.volume ?? 1}
                            onChange={(event) => setEffectSoundVolume(definition.id, Number(event.currentTarget.value))}
                            onPointerUp={(event) => void updateSound(soundEffectUpdate(soundDraft, definition.id, { volume: Number(event.currentTarget.value) }))}
                            onKeyUp={(event) => void updateSound(soundEffectUpdate(soundDraft, definition.id, { volume: Number(event.currentTarget.value) }))}
                          />
                          <strong>{Math.round((effect?.volume ?? 1) * 100)}%</strong>
                        </label>
                        <select
                          className="plain-input sound-playback-select"
                          value={effect?.playback ?? definition.defaultPlayback}
                          onChange={(event) => void setEffectSound(definition.id, { playback: event.currentTarget.value as SoundEffectPlayback })}
                          aria-label={`${definition.label} playback mode`}
                        >
                          <option value="overlap">Overlap</option>
                          <option value="restart">Restart</option>
                          <option value="fade">Fade</option>
                        </select>
                        <div className="sound-effect-actions">
                          <button className="secondary-action icon-only-action" type="button" onClick={() => void chooseSoundFile(definition.id)} title="Choose custom file" aria-label={`Choose custom ${definition.label} file`}>
                            <FolderOpen size={14} />
                          </button>
                          <button className="secondary-action icon-only-action" type="button" disabled={!effect?.filePath} onClick={() => soundEngine.play(definition.id)} title="Test sound" aria-label={`Test ${definition.label}`}>
                            <Play size={14} fill="currentColor" />
                          </button>
                          <button
                            className="secondary-action"
                            type="button"
                            onClick={() => void setEffectSound(definition.id, { filePath: undefined, source: undefined })}
                            title="Reset to default"
                            aria-label={`Reset ${definition.label} to default`}
                          >
                            <RotateCcw size={14} />
                            Reset
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>

              <details className="settings-disclosure audio-disclosure">
                <summary>
                  <span>Music library</span>
                  <em>{bundledMusicCount} bundled · {customMusicCount} custom · {musicCopyrightSummary}</em>
                </summary>
                <div className="music-track-list compact-track-list">
                  {musicTracks.length === 0 ? (
                    <p className="settings-hint music-no-tracks">No tracks available.</p>
                  ) : (
                    musicTracks.map((track, i) => (
                      <div key={`${track.filePath}-${i}`} className="music-track-row">
                        <div className="music-track-meta">
                          <strong title={track.filePath}>{musicTrackLabel(track)}</strong>
                          <span>{track.copyright ?? "No copyright metadata"}</span>
                        </div>
                        {track.source === "custom" ? (
                          <button
                            className="secondary-action icon-only-action"
                            type="button"
                            onClick={() => void removeMusicTrack(i)}
                            title="Remove custom track"
                            aria-label={`Remove ${musicTrackLabel(track)}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        ) : (
                          <span className="audio-source-pill">Default</span>
                        )}
                      </div>
                    ))
                  )}
                </div>

                <div className="music-track-add">
                  <button className="secondary-action" type="button" onClick={() => void addMusicTrack()}>
                    <Plus size={14} />
                    Add custom tracks
                  </button>
                </div>
              </details>

              <details className="settings-disclosure audio-disclosure">
                <summary>
                  <span>Playback behavior</span>
                  <em>{musicSettings.continuousPlay === true ? "continuous" : `${msToSeconds(musicSettings.gapMinMs)}-${msToSeconds(musicSettings.gapMaxMs)}s gaps`}</em>
                </summary>
                <div className="music-control-grid">
                  <label className="settings-toggle-row">
                    <input
                      type="checkbox"
                      checked={musicSettings.startupWithSoundEnabled === true}
                      onChange={(event) => void updateMusic(musicSettingsPatch(musicSettings, { startupWithSoundEnabled: event.currentTarget.checked }))}
                    />
                    <span className="settings-toggle-control" aria-hidden="true" />
                    <span>
                      <strong>Start with startup sound</strong>
                      <em>Begin music when the startup melody begins.</em>
                    </span>
                  </label>
                  <label className="music-number-row">
                    <span>Fade</span>
                    <input
                      className="plain-input"
                      type="number"
                      min="0"
                      max="60"
                      step="0.5"
                      disabled={musicSettings.startupWithSoundEnabled !== true}
                      value={msToSeconds(musicSettings.startupWithSoundFadeInMs)}
                      onChange={(event) => scheduleMusicUpdate(musicSettingsPatch(musicSettings, { startupWithSoundFadeInMs: secondsToMs(event.currentTarget.value) }))}
                      onBlur={(event) => void updateMusic(musicSettingsPatch(musicSettings, { startupWithSoundFadeInMs: secondsToMs(event.currentTarget.value) }))}
                    />
                    <strong>s</strong>
                  </label>

                  <label className="settings-toggle-row">
                    <input
                      type="checkbox"
                      checked={musicSettings.startupDelayEnabled !== false}
                      onChange={(event) => void updateMusic(musicSettingsPatch(musicSettings, { startupDelayEnabled: event.currentTarget.checked }))}
                    />
                    <span className="settings-toggle-control" aria-hidden="true" />
                    <span>
                      <strong>Startup delay</strong>
                      <em>Wait before music starts after Hynite opens.</em>
                    </span>
                  </label>
                  <label className="music-number-row">
                    <span>Delay</span>
                    <input
                      className="plain-input"
                      type="number"
                      min="0"
                      max="60"
                      step="0.5"
                      disabled={musicSettings.startupDelayEnabled === false || musicSettings.startupWithSoundEnabled === true}
                      value={msToSeconds(musicSettings.startupDelayMs)}
                      onChange={(event) => scheduleMusicUpdate(musicSettingsPatch(musicSettings, { startupDelayMs: secondsToMs(event.currentTarget.value) }))}
                      onBlur={(event) => void updateMusic(musicSettingsPatch(musicSettings, { startupDelayMs: secondsToMs(event.currentTarget.value) }))}
                    />
                    <strong>s</strong>
                  </label>

                  <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={musicSettings.fadesEnabled !== false}
                    onChange={(event) => void updateMusic(musicSettingsPatch(musicSettings, { fadesEnabled: event.currentTarget.checked }))}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Fades</strong>
                    <em>Use fades for track starts, pauses, resumes, and game launches.</em>
                  </span>
                </label>
                <div className="music-number-grid">
                  {MUSIC_FADE_CONTROLS.map(({ label, key, max }) => (
                    <label key={key} className="music-number-row compact-number-row">
                      <span>{label}</span>
                      <input
                        className="plain-input"
                        type="number"
                        min="0"
                        max={max}
                        step="0.1"
                        disabled={musicSettings.fadesEnabled === false}
                        value={msToSeconds(musicSettings[key as keyof MusicSettings] as number | undefined)}
                        onChange={(event) => scheduleMusicUpdate(musicSettingsPatch(musicSettings, musicTimingPatch(key, event.currentTarget.value)))}
                        onBlur={(event) => void updateMusic(musicSettingsPatch(musicSettings, musicTimingPatch(key, event.currentTarget.value)))}
                      />
                      <strong>s</strong>
                    </label>
                  ))}
                </div>

                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={musicSettings.pauseOnGameLaunch !== false}
                    onChange={(event) => void updateMusic(musicSettingsPatch(musicSettings, { pauseOnGameLaunch: event.currentTarget.checked }))}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Pause after launch</strong>
                    <em>Hold music after starting a game until Hynite is focused again.</em>
                  </span>
                </label>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={musicSettings.pauseOnFocusLoss !== false}
                    onChange={(event) => void updateMusic(musicSettingsPatch(musicSettings, { pauseOnFocusLoss: event.currentTarget.checked }))}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Pause without focus</strong>
                    <em>Pause when Hynite is not the active window.</em>
                  </span>
                </label>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={musicSettings.pauseOnSystemAudio !== false}
                    onChange={(event) => void updateMusic(musicSettingsPatch(musicSettings, { pauseOnSystemAudio: event.currentTarget.checked }))}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Pause on media</strong>
                    <em>Pause while another system media session is playing.</em>
                  </span>
                </label>

                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={musicSettings.continuousPlay === true}
                    onChange={(event) => void updateMusic(musicSettingsPatch(musicSettings, { continuousPlay: event.currentTarget.checked }))}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Continuous play</strong>
                    <em>Start the next track immediately instead of waiting a random interval.</em>
                  </span>
                </label>
                <div className="music-number-grid">
                  <label className="music-number-row compact-number-row">
                    <span>Min gap</span>
                    <input
                      className="plain-input"
                      type="number"
                      min="0"
                      max="600"
                      step="1"
                      disabled={musicSettings.continuousPlay === true}
                      value={msToSeconds(musicSettings.gapMinMs)}
                      onChange={(event) => scheduleMusicUpdate(musicSettingsPatch(musicSettings, { gapMinMs: secondsToMs(event.currentTarget.value) }))}
                      onBlur={(event) => void updateMusic(musicSettingsPatch(musicSettings, { gapMinMs: secondsToMs(event.currentTarget.value) }))}
                    />
                    <strong>s</strong>
                  </label>
                  <label className="music-number-row compact-number-row">
                    <span>Max gap</span>
                    <input
                      className="plain-input"
                      type="number"
                      min="0"
                      max="600"
                      step="1"
                      disabled={musicSettings.continuousPlay === true}
                      value={msToSeconds(musicSettings.gapMaxMs)}
                      onChange={(event) => scheduleMusicUpdate(musicSettingsPatch(musicSettings, { gapMaxMs: secondsToMs(event.currentTarget.value) }))}
                      onBlur={(event) => void updateMusic(musicSettingsPatch(musicSettings, { gapMaxMs: secondsToMs(event.currentTarget.value) }))}
                    />
                    <strong>s</strong>
                  </label>
                </div>
                </div>
              </details>
            </section>
          ) : null}

          {tab === "controller" ? (
            <section className="settings-section controller-settings">
              <div className="settings-section-head">
                <div>
                  <h2>Controller</h2>
                  <p className="settings-hint">Button bindings are used by Big Picture, including extra controller buttons exposed by the system.</p>
                </div>
                <label className="settings-toggle-row compact-toggle">
                  <input
                    type="checkbox"
                    checked={controllerSettings.enabled}
                    onChange={(event) => void updateController({ ...controllerSettings, enabled: event.currentTarget.checked })}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>On</strong>
                  </span>
                </label>
              </div>
              <label className="settings-toggle-row">
                <input
                  type="checkbox"
                  checked={controllerSettings.backgroundInput}
                  onChange={(event) => void updateController({ ...controllerSettings, backgroundInput: event.currentTarget.checked })}
                />
                <span className="settings-toggle-control" aria-hidden="true" />
                <span>
                  <strong>Use controller while Hynite is not focused</strong>
                  <em>Allows Big Picture navigation and the focus shortcut while another window is active.</em>
                </span>
              </label>
              <div className="controller-binding-list">
                {controllerBindingOrder.map((action) => (
                  <div key={action} className="controller-binding-row">
                    <div className="controller-binding-copy">
                      <strong>{CONTROLLER_ACTION_LABELS[action]}</strong>
                      <span>{CONTROLLER_ACTION_HELP[action]}</span>
                    </div>
                    <code>{bindingLabel(controllerSettings.bindings[action])}</code>
                    <button className="secondary-action" type="button" onClick={() => setControllerCapture(action)}>
                      {controllerCapture === action ? "Press button..." : "Rebind"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {tab === "advanced" ? (
            <>
              <section className="settings-section">
                <h2>Startup & background</h2>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.startWithWindows !== false}
                    onChange={(event) => void updateBackgroundSetting({ startWithWindows: event.currentTarget.checked })}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Start Hynite with Windows</strong>
                    <em>Packaged Windows builds start directly into tray mode.</em>
                  </span>
                </label>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.closeToTray !== false}
                    onChange={(event) => void updateBackgroundSetting({ closeToTray: event.currentTarget.checked })}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Keep running in tray when closed</strong>
                    <em>Closes the UI and keeps background services alive.</em>
                  </span>
                </label>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.backgroundUpdatesEnabled !== false}
                    onChange={(event) => void updateBackgroundSetting({ backgroundUpdatesEnabled: event.currentTarget.checked })}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Background updates</strong>
                    <em>Runs lightweight Steam syncs, activity checks, and maintenance from the tray.</em>
                  </span>
                </label>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.backgroundPlaytimeTracking !== false}
                    onChange={(event) => void updateBackgroundSetting({ backgroundPlaytimeTracking: event.currentTarget.checked })}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Track local game playtime in tray</strong>
                    <em>Watches exact known local executable paths without loading the window.</em>
                  </span>
                </label>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.crashReportingEnabled !== false}
                    onChange={(event) => void updateBackgroundSetting({ crashReportingEnabled: event.currentTarget.checked })}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Send crash reports</strong>
                    <em>Sends scrubbed error reports (no usernames, tokens, or file owners) to Hynite&apos;s private diagnostics server to help fix bugs.</em>
                  </span>
                </label>
                <label className="music-number-row">
                  <span>Workload</span>
                  <select
                    className="plain-input"
                    value={settings?.backgroundWorkload ?? "balanced"}
                    onChange={(event) => void updateBackgroundSetting({ backgroundWorkload: event.currentTarget.value as BackgroundWorkload })}
                  >
                    <option value="minimum">Minimum</option>
                    <option value="balanced">Balanced</option>
                    <option value="max">Max</option>
                  </select>
                  <strong>{settings?.backgroundWorkload ?? "balanced"}</strong>
                </label>
              </section>
              <section className="settings-section">
                <h2>Spotlight</h2>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.spotlight?.enabled !== false}
                    onChange={(event) => void updateSpotlightSetting({ enabled: event.currentTarget.checked })}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Spotlight hotkey</strong>
                    <em>Opens a local game search while Hynite is foregrounded, minimized, or in the tray.</em>
                  </span>
                </label>
                <div className="settings-hotkey-row">
                  <span>Shortcut</span>
                  <button
                    type="button"
                    className={spotlightCapture ? "hotkey-capture active" : "hotkey-capture"}
                    onClick={() => setSpotlightCapture(true)}
                    onBlur={() => setSpotlightCapture(false)}
                    onKeyDown={(event) => {
                      if (!spotlightCapture) return;
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        setSpotlightCapture(false);
                        return;
                      }
                      const accelerator = acceleratorFromHotkeyInput({
                        key: event.key,
                        code: event.code,
                        ctrlKey: event.ctrlKey,
                        altKey: event.altKey,
                        shiftKey: event.shiftKey,
                        metaKey: event.metaKey
                      });
                      if (!accelerator) return;
                      setSpotlightCapture(false);
                      void updateSpotlightSetting({ hotkey: accelerator });
                    }}
                    onKeyUp={(event) => {
                      if (!spotlightCapture) return;
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {spotlightCapture ? "Press shortcut" : settings?.spotlight?.hotkey ?? "Alt+Space"}
                  </button>
                  <button
                    type="button"
                    className="hotkey-reset"
                    title="Reset to default"
                    aria-label="Reset Spotlight hotkey to default"
                    disabled={(settings?.spotlight?.hotkey ?? "Alt+Space") === "Alt+Space"}
                    onClick={() => {
                      setSpotlightCapture(false);
                      void updateSpotlightSetting({ hotkey: "Alt+Space" });
                    }}
                  >
                    <RotateCcw size={14} />
                  </button>
                  <strong className={spotlightState?.registered ? "hotkey-status ready" : settings?.spotlight?.enabled === false ? "hotkey-status" : "hotkey-status warn"}>
                    {settings?.spotlight?.enabled === false
                      ? "Disabled"
                      : spotlightState?.registered
                        ? "Registered"
                        : spotlightState?.registrationError ?? "Not registered"}
                  </strong>
                </div>
              </section>
              <section className="settings-section">
                <h2>Launch behavior</h2>
                <label className="settings-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings?.autoHideAfterLaunch !== false}
                    onChange={(event) => void setAutoHideAfterLaunch(event.currentTarget.checked)}
                  />
                  <span className="settings-toggle-control" aria-hidden="true" />
                  <span>
                    <strong>Hide Hynite after launching a game</strong>
                    <em>Shows a short game splash, then minimizes Hynite to the taskbar.</em>
                  </span>
                </label>
              </section>
              <section className="settings-section">
                <h2>Development</h2>
                <div className="settings-actions">
                  <button className="secondary-action" onClick={() => void clearLibrary()}>
                    Clear library
                  </button>
                  <button className="secondary-action" onClick={onSeed}>
                    Add demo game
                  </button>
                  <button className="secondary-action danger" disabled={resettingEverything} onClick={() => void resetEverything()}>
                    <Trash2 size={14} />
                    {resettingEverything ? "Resetting..." : "Reset everything"}
                  </button>
                </div>
                {devMessage ? <p className="result-line">{devMessage}</p> : null}
              </section>
            </>
          ) : null}
        </div>
      </section>
      {showSyncModal ? <SyncStatusModal status={syncStatus} onClose={() => setShowSyncModal(false)} /> : null}
    </main>
  );
}

function ImageViewer({
  images,
  initialIndex,
  reduceMotion,
  onClose
}: {
  images: ImageViewerItem[];
  initialIndex: number;
  reduceMotion?: boolean;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const selected = images[index % Math.max(images.length, 1)];
  const canStep = images.length > 1;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
      if (event.key === "ArrowLeft" && canStep) {
        setIndex((current) => (current - 1 + images.length) % images.length);
      }
      if (event.key === "ArrowRight" && canStep) {
        setIndex((current) => (current + 1) % images.length);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canStep, images.length, onClose]);

  if (!selected) {
    return null;
  }

  const step = (direction: -1 | 1) => {
    if (!canStep) {
      return;
    }
    setIndex((current) => (current + direction + images.length) % images.length);
  };

  return (
    <AnimatePresence>
      <motion.div className="image-viewer-backdrop" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <button className="image-viewer-scrim" aria-label="Close image viewer" onClick={onClose} />
        <motion.div
          className="image-viewer"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? undefined : { opacity: 0, scale: 0.98 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
        >
          <div className="image-viewer-head">
            <span>{selected.label}</span>
            <button className="close-button inline-close" type="button" onClick={onClose} aria-label="Close image viewer">
              <X size={18} />
            </button>
          </div>
          <div className="image-viewer-stage">
            {canStep ? (
              <button className="image-viewer-arrow left" type="button" onClick={() => step(-1)} aria-label="Previous image">
                <ChevronLeft size={24} />
              </button>
            ) : null}
            <img src={selected.url} alt={selected.label} />
            {canStep ? (
              <button className="image-viewer-arrow right" type="button" onClick={() => step(1)} aria-label="Next image">
                <ChevronRight size={24} />
              </button>
            ) : null}
          </div>
          {canStep ? (
            <div className="image-viewer-dots" aria-label="Images">
              {images.map((image, imageIndex) => (
                <button
                  key={image.url}
                  type="button"
                  className={imageIndex === index ? "active" : undefined}
                  onClick={() => setIndex(imageIndex)}
                  aria-label={`Show ${image.label}`}
                  aria-current={imageIndex === index ? "true" : undefined}
                />
              ))}
            </div>
          ) : null}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function LaunchHandoffPreview({
  backgroundUrl,
  logoUrl,
  game
}: {
  backgroundUrl?: string;
  logoUrl?: string;
  game: Game;
}) {
  const backgroundStyle = backgroundUrl ? { backgroundImage: `url(${backgroundUrl})` } : undefined;
  return (
    <div className="launch-preview" style={fallbackArt(game)}>
      <div className="launch-preview-bg launch-preview-bg-blur" style={backgroundStyle} />
      <div className="launch-preview-bg launch-preview-bg-main" style={backgroundStyle} />
      <div className="launch-preview-tint" />
      <div className="launch-preview-identity">
        {logoUrl
          ? <img className="launch-preview-logo" src={logoUrl} alt="" draggable={false} />
          : <span className="launch-preview-title">{game.title}</span>}
        <div className="launch-preview-line">
          <span />
        </div>
      </div>
    </div>
  );
}

function RecentGameItem({
  game,
  onAction,
  onSelect,
  onContextMenu
}: {
  game: Game;
  onAction: (game: Game) => void;
  onSelect: (game: Game) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, game: Game) => void;
}) {
  const isInstalled = game.installState === "installed";
  const launchable = canLaunch(game);
  const RecentActionIcon = isInstalled ? Play : launchable ? Download : Info;
  const actionLabel = isInstalled ? `Play ${game.title}` : launchable ? `Download ${game.title}` : `View details for ${game.title}`;
  return (
    <div className="recent-link" onContextMenu={(event) => onContextMenu(event, game)}>
      <button
        type="button"
        className="recent-icon-button"
        onClick={() => onAction(game)}
        aria-label={actionLabel}
      >
        <span className={game.communityIconUrl ? "recent-icon has-image" : "recent-icon"} style={!game.communityIconUrl ? fallbackArt(game) : undefined}>
          {game.communityIconUrl ? <img src={game.communityIconUrl} alt="" /> : null}
          <span className="recent-play-overlay">
            <RecentActionIcon size={13} fill={isInstalled ? "currentColor" : "none"} />
          </span>
        </span>
      </button>
      <button type="button" className="recent-details-button" onClick={() => onSelect(game)} aria-label={`View details for ${game.title}`}>
        <span className="rail-label">
          <strong>{game.title}</strong>
          <em>{activityLabel(game)}</em>
        </span>
      </button>
    </div>
  );
}

function GameAssetEditor({
  game,
  reduceMotion,
  onSaved,
  onClose
}: {
  game: GameDetail;
  reduceMotion?: boolean;
  onSaved: (game: GameDetail) => void;
  onClose: () => void;
}) {
  const [activeKind, setActiveKind] = useState<GameAssetKind>("grid");
  const [providerFilter, setProviderFilter] = useState<GameAssetProvider | "all">("all");
  const [candidates, setCandidates] = useState<GameAssetCandidate[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [customUrl, setCustomUrl] = useState("");
  const [displayName, setDisplayName] = useState(game.title);
  const [selectedUrls, setSelectedUrls] = useState<Record<GameAssetKind, string | undefined>>(() => ({
    grid: gameAssetUrl(game, "grid"),
    hero: gameAssetUrl(game, "hero"),
    logo: gameAssetUrl(game, "logo"),
    icon: gameAssetUrl(game, "icon"),
    header: gameAssetUrl(game, "header"),
    poster: gameAssetUrl(game, "poster")
  }));
  const [fitModes, setFitModes] = useState<Record<GameAssetKind, AssetFitMode>>({
    grid: "contain",
    hero: "contain",
    logo: "contain",
    icon: "contain",
    header: "contain",
    poster: "contain"
  });
  const [cropByKind, setCropByKind] = useState<Record<GameAssetKind, { x: number; y: number; zoom: number }>>({
    grid: { x: 0, y: 0, zoom: 1 },
    hero: { x: 0, y: 0, zoom: 1 },
    logo: { x: 0, y: 0, zoom: 1 },
    icon: { x: 0, y: 0, zoom: 1 },
    header: { x: 0, y: 0, zoom: 1 },
    poster: { x: 0, y: 0, zoom: 1 }
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void window.hynite.games.getAssetCandidates(game.id)
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.candidates);
        setWarnings(result.warnings);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load assets.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [game.id]);

  const filteredCandidates = useMemo(() => {
    return candidates.filter((candidate) =>
      candidate.kind === activeKind && (providerFilter === "all" || candidate.provider === providerFilter)
    );
  }, [activeKind, candidates, providerFilter]);

  const previewGame = useMemo<Game>(() => ({
    ...game,
    libraryCapsuleUrl: selectedUrls.grid ?? game.libraryCapsuleUrl,
    coverUrl:          selectedUrls.grid ?? game.coverUrl,
    backgroundUrl:     selectedUrls.hero ?? game.backgroundUrl,
    logoUrl:           selectedUrls.logo ?? game.logoUrl,
    communityIconUrl:  selectedUrls.icon ?? game.communityIconUrl,
    headerUrl:         selectedUrls.header ?? game.headerUrl,
    trailerPosterUrl:  selectedUrls.poster ?? game.trailerPosterUrl,
  }), [game, selectedUrls]);

  const activeSlot = assetSlot(activeKind);
  const activeCrop = cropByKind[activeKind];
  const activeFit = fitModes[activeKind];
  const trimmedDisplayName = displayName.trim();
  const dirty = trimmedDisplayName !== game.title || ASSET_SLOTS.some((slot) => selectedUrls[slot.kind] !== gameAssetUrl(game, slot.kind));

  function selectCandidate(candidate: GameAssetCandidate) {
    setSelectedUrls((current) => ({ ...current, [candidate.kind]: candidate.url }));
    setCropByKind((current) => ({ ...current, [candidate.kind]: { x: 0, y: 0, zoom: 1 } }));
    setError(undefined);
  }

  function applyCustomUrl() {
    const trimmed = customUrl.trim();
    if (!trimmed) return;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setError("Custom assets must use http or https.");
        return;
      }
    } catch {
      setError("Enter a valid image URL.");
      return;
    }
    setSelectedUrls((current) => ({ ...current, [activeKind]: trimmed }));
    setProviderFilter("all");
    setError(undefined);
  }

  async function saveAssets() {
    const update: GameAssetUpdate = {};
    if (trimmedDisplayName && trimmedDisplayName !== game.title) {
      update.title = trimmedDisplayName;
    }
    for (const slot of ASSET_SLOTS) {
      const next = selectedUrls[slot.kind];
      if (next !== gameAssetUrl(game, slot.kind)) {
        update[slot.kind] = next ?? null;
      }
    }
    if (!trimmedDisplayName) {
      setError("Display name cannot be empty.");
      return;
    }
    if (Object.keys(update).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      const croppedUpdate: GameAssetUpdate = { ...update };
      for (const slot of ASSET_SLOTS) {
        const value = croppedUpdate[slot.kind];
        if (value && fitModes[slot.kind] === "crop") {
          try {
            croppedUpdate[slot.kind] = await cropAssetToDataUrl(value, slot.kind, cropByKind[slot.kind]);
          } catch (cropError) {
            console.warn("Asset crop failed; saving original URL", cropError);
          }
        }
      }
      const updated = await window.hynite.games.updateAssets(game.id, croppedUpdate);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Asset update failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div className="modal-backdrop asset-editor-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="image-viewer-scrim" type="button" aria-label="Close asset editor" onClick={onClose} />
      <motion.section
        className="asset-editor"
        initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.985 }}
        transition={{ duration: reduceMotion ? 0 : 0.18 }}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-editor-title"
      >
        <div className="modal-head asset-editor-head">
          <div>
            <p className="eyebrow">Game</p>
            <h2 id="asset-editor-title">Edit game assets</h2>
          </div>
          <button className="close-button inline-close" type="button" onClick={onClose} aria-label="Close asset editor">
            <X size={18} />
          </button>
        </div>
        <div className="asset-editor-body">
          <aside className="asset-preview-panel" data-active={activeKind}>
            <p className="asset-preview-label">Preview</p>
            <div className="asset-preview-cover-wrap">
              <GameCover game={previewGame} onSelect={() => {}} showLogo inLibrary />
            </div>
            <div className="asset-preview-launch-wrap">
              <LaunchHandoffPreview
                backgroundUrl={previewGame.backgroundUrl}
                logoUrl={previewGame.logoUrl}
                game={previewGame}
              />
            </div>
            <div className="asset-preview-sidecar-wrap">
              <RecentGameItem game={previewGame} onAction={() => {}} onSelect={() => {}} onContextMenu={() => {}} />
            </div>
            <label className="asset-title-field">
              <span>Display name</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
          </aside>
          <main className="asset-editor-main">
            <div className="asset-slot-tabs" role="tablist" aria-label="Asset slots">
              {ASSET_SLOTS.map((slot) => {
                const isActive = slot.kind === activeKind;
                return (
                  <button
                    key={slot.kind}
                    type="button"
                    role="tab"
                    className={isActive ? "active" : undefined}
                    onClick={() => setActiveKind(slot.kind)}
                    aria-selected={isActive}
                  >
                    {slot.label}
                  </button>
                );
              })}
            </div>

            <div className="asset-editor-controls">
              <div className="asset-provider-tabs">
                {ASSET_PROVIDERS.map((entry) => (
                  <button
                    key={entry.provider}
                    type="button"
                    className={providerFilter === entry.provider ? "active" : undefined}
                    onClick={() => setProviderFilter(entry.provider)}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <div className="segmented-control">
                <button
                  type="button"
                  className={activeFit === "contain" ? "active" : undefined}
                  onClick={() => setFitModes((current) => ({ ...current, [activeKind]: "contain" }))}
                >
                  <Images size={14} />
                  Fit
                </button>
                <button
                  type="button"
                  className={activeFit === "crop" ? "active" : undefined}
                  onClick={() => setFitModes((current) => ({ ...current, [activeKind]: "crop" }))}
                >
                  <Crop size={14} />
                  Crop
                </button>
              </div>
            </div>
            {activeFit === "crop" ? (
              <p className="asset-editor-extra asset-crop-note">
                Image will be center-cropped to fill the slot on save.
              </p>
            ) : null}
            <label className="asset-editor-extra custom-asset-url">
              <span>Custom URL</span>
              <div>
                <input value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} placeholder="https://..." />
                <button type="button" className="icon-action" onClick={applyCustomUrl}>
                  <Link2 size={14} />
                  Use
                </button>
              </div>
            </label>

            {error ? <p className="error-line">{error}</p> : null}
            {warnings.length ? <p className="asset-warning">{warnings.slice(0, 3).join(" ")}</p> : null}
            {loading ? (
              <div className="asset-loading">
                <RefreshCw size={16} />
                Loading assets
              </div>
            ) : filteredCandidates.length ? (
              <div className="asset-candidate-grid">
                <div className="asset-candidate-columns">
                  {filteredCandidates.map((candidate) => {
                    const selected = selectedUrls[candidate.kind] === candidate.url;
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        className={selected ? "selected" : undefined}
                        onClick={() => selectCandidate(candidate)}
                      >
                        <span className="asset-candidate-image">
                          <img src={candidate.thumbnailUrl ?? candidate.url} alt="" loading="lazy" />
                        </span>
                        <span className="asset-candidate-meta">
                          <strong>{candidate.label}</strong>
                          <em>
                            {[
                              providerLabel(candidate.provider),
                              candidate.width && candidate.height ? `${candidate.width}x${candidate.height}` : undefined,
                              candidate.score !== undefined ? `score ${candidate.score}` : undefined,
                              candidate.nsfw ? "NSFW" : undefined,
                              candidate.humor ? "Humor" : undefined
                            ].filter(Boolean).join(" / ")}
                          </em>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="muted">No assets for this slot and provider.</p>
            )}
          </main>
        </div>
        <div className="asset-editor-actions">
          <button type="button" className="secondary-action" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-action" disabled={saving || !dirty} onClick={() => void saveAssets()}>
            <Save size={15} />
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </motion.section>
    </motion.div>
  );
}

function DetailOverlaySkeleton({
  game,
  onClose
}: {
  game: Game;
  onClose: () => void;
}) {
  const cover = primaryCover(game);
  const media = heroStill(game);
  console.log("[detail-skeleton] rendering skeleton for", game.title);
  return (
    <motion.div
      className="detail-modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0 } }}
      onClick={onClose}
    >
      <motion.section
        className="detail-modal"
        initial={{ y: 34, scale: 0.985, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0 } }}
        transition={{ duration: 0.24, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        aria-busy
        aria-label={`Loading ${game.title}`}
      >
        {media ? (
          <>
            <div className="detail-media">
              <span style={{ backgroundImage: `url(${media})` }} />
            </div>
            <div className="detail-shade" />
          </>
        ) : null}
        <div className="detail-modal-body">
          <main className="detail-main">
            <section className="detail-block">
              <div className="detail-sk detail-sk-media" />
              <div className="detail-sk-thumbs">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="detail-sk detail-sk-thumb" />
                ))}
              </div>
            </section>
            <section className="detail-block">
              <div className="detail-sk detail-sk-heading" />
              {([90, 100, 78, 68, 52] as const).map((w, i) => (
                <div
                  key={i}
                  className="detail-sk detail-sk-body-line"
                  style={{ width: `${w}%`, marginTop: i > 0 ? "0.45vw" : 0 }}
                />
              ))}
            </section>
          </main>

          <aside className="detail-sidebar">
            <section className="detail-side-identity" style={fallbackArt(game)}>
              <div className="detail-side-cover" style={{ cursor: "default" }}>
                <span style={cover ? { backgroundImage: `url(${cover})` } : undefined} />
              </div>
              <div>
                <p className="eyebrow">{game.discovery?.signal ?? "Steam library"}</p>
                <h1>{game.title}</h1>
                <div className="detail-sk detail-sk-meta-line" style={{ marginTop: "0.45vw" }} />
                <div className="detail-sk-actions">
                  <div className="detail-sk detail-sk-btn" />
                  <div className="detail-sk detail-sk-btn sm" />
                  <div className="detail-sk detail-sk-btn sm" />
                </div>
              </div>
            </section>

            <section className="detail-block compact">
              <h2>Activity</h2>
              <div className="detail-sk-pills">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="detail-sk detail-sk-pill" />
                ))}
              </div>
              <div className="detail-sk-dl">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="detail-sk-dl-row">
                    <div className="detail-sk detail-sk-dt" />
                    <div className="detail-sk detail-sk-dd" />
                  </div>
                ))}
              </div>
            </section>

            <section className="detail-block compact">
              <h2>Steam data</h2>
              <div className="detail-sk-dl">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="detail-sk-dl-row">
                    <div className="detail-sk detail-sk-dt" />
                    <div className="detail-sk detail-sk-dd" />
                  </div>
                ))}
              </div>
              <div className="detail-sk-taglist">
                {([52, 66, 44, 70, 58, 48] as const).map((w, i) => (
                  <div key={i} className="detail-sk detail-sk-tag" style={{ width: `${w}px` }} />
                ))}
              </div>
            </section>

            <section className="detail-block compact">
              <h2>Download options</h2>
              <div className="detail-sk detail-sk-search" />
              <div className="detail-sk-matches">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="detail-sk detail-sk-match" />
                ))}
              </div>
            </section>
          </aside>
        </div>
      </motion.section>
    </motion.div>
  );
}

function DetailOverlay({
  game,
  settings,
  onSettingsChanged,
  reduceMotion,
  fromSkeleton,
  onFromSkeletonHandled,
  onClose,
  onGameUpdated,
  onChanged
}: {
  game: GameDetail;
  settings?: AppSettings;
  onSettingsChanged: (settings: AppSettings) => void;
  reduceMotion?: boolean;
  fromSkeleton?: boolean;
  onFromSkeletonHandled?: () => void;
  onClose: () => void;
  onGameUpdated: (game: GameDetail) => void;
  onChanged: () => void;
}) {
  type DetailMediaItem =
    | { kind: "trailer"; label: string; sourceUrl: string; posterUrl?: string }
    | { kind: "image"; label: string; sourceUrl: string; thumbnailUrl: string };
  const [viewer, setViewer] = useState<{ images: ImageViewerItem[]; index: number } | undefined>();
  const [assetEditorOpen, setAssetEditorOpen] = useState(false);
  const [downloadQuery, setDownloadQuery] = useState(game.title);
  const [downloadMatches, setDownloadMatches] = useState<SourceMatch[]>(game.sourceMatches);
  const [downloadSearching, setDownloadSearching] = useState(false);
  const [downloadMatchesLoading, setDownloadMatchesLoading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | undefined>();
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(() => new Set());
  const [visibleBySource, setVisibleBySource] = useState<Record<string, number>>({});
  const mainScrollRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (fromSkeleton) onFromSkeletonHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const { direction } = (e as CustomEvent<{ direction: string }>).detail;
      mainScrollRef.current?.scrollBy({ top: direction === "down" ? 240 : -240, behavior: "smooth" });
    };
    window.addEventListener("bp-scroll", handler);
    return () => window.removeEventListener("bp-scroll", handler);
  }, []);

  const launchOptions = useMemo(
    () => resolveLaunchableSteamAccounts(game, settings?.steamAccounts ?? []),
    [game, settings?.steamAccounts]
  );
  const [selectedLaunchSteamId, setSelectedLaunchSteamId] = useState<string | undefined>();

  async function copy(text: string) {
    await window.hynite.clipboard.copy(text);
  }

  async function setPreferredLaunchAccount(steamId: string | undefined) {
    setSelectedLaunchSteamId(steamId);
    onSettingsChanged(await window.hynite.steam.setPreferredLaunchAccount(game.id, steamId));
  }

  async function searchDownloadOptions() {
    const trimmed = downloadQuery.trim();
    if (!trimmed) return;
    setDownloadSearching(true);
    setDownloadError(undefined);
    try {
      const nextMatches = await window.hynite.sources.searchTitle(trimmed, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT });
      setDownloadMatches(nextMatches);
      setExpandedSourceIds(new Set());
      setVisibleBySource({});
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setDownloadSearching(false);
    }
  }

  function toggleSource(sourceId: string) {
    const expanding = !expandedSourceIds.has(sourceId);
    setExpandedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
    if (expanding) {
      setVisibleBySource((current) => ({ ...current, [sourceId]: current[sourceId] ?? DOWNLOAD_MATCH_BATCH_SIZE }));
    }
  }

  function showMoreSourceMatches(sourceId: string) {
    setVisibleBySource((current) => ({
      ...current,
      [sourceId]: (current[sourceId] ?? DOWNLOAD_MATCH_BATCH_SIZE) + DOWNLOAD_MATCH_BATCH_SIZE
    }));
  }

  const cover = primaryCover(game);
  const media = heroStill(game);
  const storeUrl = steamStoreUrl(game);
  const description = game.aboutText ?? game.shortDescription;
  const mediaItems: DetailMediaItem[] = [
    ...(game.trailerUrl ? [{ kind: "trailer" as const, label: "Trailer", sourceUrl: game.trailerUrl, posterUrl: game.trailerPosterUrl ?? media }] : []),
    ...game.screenshots.slice(0, 8).map((screenshot, index) => ({
      kind: "image" as const,
      label: `Screenshot ${index + 1}`,
      sourceUrl: screenshot.fullUrl,
      thumbnailUrl: screenshot.thumbnailUrl
    }))
  ];
  const imageViewerItems = mediaItems
    .filter((item): item is Extract<DetailMediaItem, { kind: "image" }> => item.kind === "image")
    .map((item) => ({ url: item.sourceUrl, label: item.label }));
  const coverViewerItems = cover ? [{ url: cover, label: `${game.title} cover` }] : [];
  const [mediaIndex, setMediaIndex] = useState(0);
  const activeMediaIndex = mediaItems.length ? mediaIndex % mediaItems.length : 0;
  const activeMedia = mediaItems[activeMediaIndex];
  const platforms = [
    game.platforms?.windows ? "Windows" : undefined,
    game.platforms?.mac ? "macOS" : undefined,
    game.platforms?.linux ? "Linux" : undefined
  ].filter(Boolean);
  const detailMeta = [game.developers[0], game.genres[0], game.releaseDate ? formatDate(game.releaseDate) : undefined].filter(Boolean).join(" / ");
  const downloadGroups = useMemo(() => {
    const groups = new Map<string, { sourceId: string; sourceName: string; matches: SourceMatch[] }>();
    for (const match of downloadMatches) {
      const existing = groups.get(match.sourceId);
      if (existing) {
        existing.matches.push(match);
      } else {
        groups.set(match.sourceId, { sourceId: match.sourceId, sourceName: match.sourceName, matches: [match] });
      }
    }
    return [...groups.values()];
  }, [downloadMatches]);

  useEffect(() => {
    setMediaIndex(0);
    setDownloadQuery(game.title);
    setDownloadMatches(game.sourceMatches);
    setDownloadError(undefined);
    setExpandedSourceIds(new Set());
    setVisibleBySource({});
  }, [game.id]);

  useEffect(() => {
    let cancelled = false;
    const span = profileSpan("renderer-render", "renderer:detail-open:source-matches-lazy", { id: game.id, title: game.title });
    setDownloadMatchesLoading(true);
    const search = game.sourceMatches.length > 0
      ? Promise.resolve(game.sourceMatches)
      : game.id.startsWith("steam:") || game.id.startsWith("local:")
        ? window.hynite.sources.search(game.id, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT })
        : window.hynite.sources.searchTitle(game.title, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT });
    search
      .then((matches) => {
        if (cancelled) {
          span.end("cancelled", { id: game.id, title: game.title });
          return;
        }
        setDownloadMatches(matches);
        span.end("ok", { id: game.id, title: game.title, sourceMatches: matches.length });
      })
      .catch((error) => {
        if (cancelled) {
          span.end("cancelled", { id: game.id, title: game.title });
          return;
        }
        setDownloadError(error instanceof Error ? error.message : "Search failed.");
        span.end("error", { id: game.id, title: game.title, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) {
          setDownloadMatchesLoading(false);
        }
      });
    return () => {
      cancelled = true;
      setDownloadMatchesLoading(false);
    };
  }, [game.id, game.title, game.sourceMatches]);

  useEffect(() => {
    const savedSteamId = settings?.launchAccountPreferences?.[game.id];
    const saved = savedSteamId ? launchOptions.find((option) => option.steamId === savedSteamId) : undefined;
    setSelectedLaunchSteamId(saved?.steamId ?? launchOptions[0]?.steamId);
  }, [game.id, launchOptions, settings?.launchAccountPreferences]);

  function launchAccountLabel(option: (typeof launchOptions)[number]): string {
    const name = option.personaName ?? option.localUsername ?? option.steamId;
    return `${name} (${option.kind === "owner" ? "Owner" : "Family"})`;
  }

  return (
    <>
    <motion.div className="detail-modal-backdrop" initial={fromSkeleton ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.section
        className="detail-modal"
        initial={fromSkeleton ? false : { y: 34, scale: 0.985, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 28, scale: 0.985, opacity: 0 }}
        transition={{ duration: 0.24, ease: "easeOut" }}
        onClick={(event) => event.stopPropagation()}
      >
        {media ? (
          <>
            <div className="detail-media">
              <span style={{ backgroundImage: `url(${media})` }} />
            </div>
            <div className="detail-shade" />
          </>
        ) : null}
        <div className="detail-modal-body">
          <main className="detail-main" ref={mainScrollRef}>
            {activeMedia ? (
              <section className="detail-block media-carousel-block">
                <div className="detail-block-head">
                  {activeMedia.kind === "trailer" ? <Film size={17} /> : <Images size={17} />}
                  <h2>Media</h2>
                  <span>{activeMedia.label}</span>
                </div>
                <div className="media-carousel">
                  {activeMedia.kind === "trailer" ? (
                    <TrailerPlayer sourceUrl={activeMedia.sourceUrl} posterUrl={activeMedia.posterUrl} label={`${game.title} ${activeMedia.label}`} />
                  ) : (
                    <button
                      className="media-image"
                      style={{ backgroundImage: `url(${activeMedia.sourceUrl})` }}
                      onClick={() => setViewer({ images: imageViewerItems, index: Math.max(0, imageViewerItems.findIndex((item) => item.url === activeMedia.sourceUrl)) })}
                    />
                  )}
                  {mediaItems.length > 1 ? (
                    <div className="media-carousel-nav">
                      <button
                        className="icon-action"
                        onClick={() => setMediaIndex((index) => (index - 1 + mediaItems.length) % mediaItems.length)}
                        aria-label="Previous media"
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span>
                        {activeMediaIndex + 1} / {mediaItems.length}
                      </span>
                      <button className="icon-action" onClick={() => setMediaIndex((index) => (index + 1) % mediaItems.length)} aria-label="Next media">
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  ) : null}
                </div>
                {mediaItems.length > 1 ? (
                  <div className="media-thumbs">
                    {mediaItems.map((item, index) => (
                      <button
                        key={`${item.kind}-${item.sourceUrl}`}
                        className={index === activeMediaIndex ? "active" : ""}
                        style={
                          item.kind === "image"
                            ? { backgroundImage: `url(${item.thumbnailUrl})` }
                            : item.posterUrl
                              ? { backgroundImage: `url(${item.posterUrl})` }
                              : fallbackArt(game)
                        }
                        onClick={() => setMediaIndex(index)}
                        aria-label={`Show ${item.label}`}
                      >
                        {item.kind === "trailer" ? <Film size={14} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {description ? (
              <section className="detail-block">
                <h2>About</h2>
                <RichDescription value={description} />
              </section>
            ) : null}

          </main>

          <aside className="detail-sidebar">
            <section className="detail-side-identity" style={fallbackArt(game)}>
              <button
                className="detail-side-cover"
                disabled={!cover}
                onClick={() => (cover ? setViewer({ images: coverViewerItems, index: 0 }) : undefined)}
                aria-label={`Open ${game.title} cover`}
              >
                <span style={cover ? { backgroundImage: `url(${cover})` } : undefined} />
              </button>
              <div>
                <p className="eyebrow">{game.discovery?.signal ?? "Steam library"}</p>
                <h1>{game.title}</h1>
                <p>{detailMeta || game.shortDescription || "Game details"}</p>
                {launchOptions.length > 1 ? (
                  <label className="detail-account-select">
                    <span>Launch account</span>
                    <select
                      value={selectedLaunchSteamId ?? ""}
                      onChange={(event) => void setPreferredLaunchAccount(event.target.value || undefined)}
                    >
                      {launchOptions.map((option) => (
                        <option key={option.steamId} value={option.steamId}>
                          {launchAccountLabel(option)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="detail-action-row">
                  <button className="primary-action" disabled={!canLaunch(game)} onClick={() => void launchGame(game, selectedLaunchSteamId)}>
                    <Play size={16} />
                    Play
                  </button>
                  {storeUrl ? (
                    <button className="secondary-action" onClick={() => openExternalUrl(storeUrl)}>
                      <ExternalLink size={16} />
                      Store
                    </button>
                  ) : null}
                  {game.websiteUrl ? (
                    <button className="secondary-action" onClick={() => openExternalUrl(game.websiteUrl)}>
                      <Globe2 size={16} />
                      Website
                    </button>
                  ) : null}
                  <button className="secondary-action" onClick={() => setAssetEditorOpen(true)}>
                    <Pencil size={16} />
                    Edit
                  </button>
                </div>
              </div>
            </section>
            <section className="detail-block compact">
              <h2>Activity</h2>
              <div className="detail-hero-stats">
                <span>
                  <Clock3 size={15} />
                  {formatHours(game.playtimeMinutes)}
                </span>
                <span>
                  <CalendarDays size={15} />
                  {formatDate(game.releaseDate) ?? "Release unknown"}
                </span>
                <span>
                  <Users size={15} />
                  {formatNumber(game.recommendationCount)} recs
                </span>
              </div>
              <dl>
                <div>
                  <dt>Playtime</dt>
                  <dd>{formatHours(game.playtimeMinutes)}</dd>
                </div>
                <div>
                  <dt>Last played</dt>
                  <dd>{formatDate(game.lastPlayedAt) ?? "Never"}</dd>
                </div>
                <div>
                  <dt>Imported</dt>
                  <dd>{formatDate(game.importedAt) ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Installed</dt>
                  <dd>{game.installState === "installed" ? "Yes" : game.installState === "not_installed" ? "No" : "Unknown"}</dd>
                </div>
              </dl>
            </section>

            <section className="detail-block compact">
              <h2>Steam data</h2>
              <dl>
                <div>
                  <dt>Developers</dt>
                  <dd>{game.developers.join(", ") || "Unknown"}</dd>
                </div>
                <div>
                  <dt>Publishers</dt>
                  <dd>{game.publishers.join(", ") || "Unknown"}</dd>
                </div>
                <div>
                  <dt>Achievements</dt>
                  <dd>
                    <Trophy size={14} />
                    {formatNumber(game.achievementCount)}
                  </dd>
                </div>
                <div>
                  <dt>Platforms</dt>
                  <dd>
                    <Monitor size={14} />
                    {platforms.join(", ") || "Unknown"}
                  </dd>
                </div>
              </dl>
              <div className="tag-list">
                {[...game.genres, ...game.tags].slice(0, 16).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              {game.contentDescriptors.length ? (
                <div className="content-notes">
                  {game.contentDescriptors.map((descriptor) => (
                    <p key={descriptor}>{descriptor}</p>
                  ))}
                </div>
              ) : null}
              <div className="detail-links">
                {game.supportUrl ? (
                  <button className="icon-action" onClick={() => openExternalUrl(game.supportUrl)}>
                    <ExternalLink size={15} />
                    Support
                  </button>
                ) : null}
              </div>
            </section>

            <section className="detail-block compact source-matches">
              <h2>Download options</h2>
              <div className="download-search-row">
                <label className="search-box">
                  <Search size={14} />
                  <input
                    value={downloadQuery}
                    onChange={(event) => setDownloadQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && downloadQuery.trim()) void searchDownloadOptions(); }}
                    placeholder="Search sources"
                  />
                </label>
                <button className="icon-action" disabled={!downloadQuery.trim() || downloadSearching} onClick={() => void searchDownloadOptions()}>
                  {downloadSearching ? "Searching..." : "Search"}
                </button>
              </div>
              {downloadError ? <p className="error-line">{downloadError}</p> : null}
              {downloadGroups.length === 0 ? (
                <p className="muted">{downloadMatchesLoading ? "Loading source matches..." : "No source matches."}</p>
              ) : (
                <div className="source-match-groups">
                  {downloadGroups.map((group) => {
                    const expanded = expandedSourceIds.has(group.sourceId);
                    const visibleCount = visibleBySource[group.sourceId] ?? DOWNLOAD_MATCH_BATCH_SIZE;
                    const visibleMatches = group.matches.slice(0, visibleCount);
                    const hasMore = visibleCount < group.matches.length;
                    const bestConfidence = group.matches.some((match) => match.score >= 1) ? "exact" : group.matches[0]?.confidence;
                    return (
                      <div className="source-match-group" key={group.sourceId}>
                        <button className="source-match-toggle" type="button" onClick={() => toggleSource(group.sourceId)} aria-expanded={expanded}>
                          <div>
                            <strong>{group.sourceName}</strong>
                            <span>
                              {group.matches.length.toLocaleString()} matches / {bestConfidence}
                            </span>
                          </div>
                          <ChevronDown size={16} />
                        </button>
                        {expanded ? (
                          <div className="source-match-list">
                            {visibleMatches.map((match) => {
                              const uploadedAt = formatUploadedAt(match.uploadDate);
                              return (
                                <div className="match-row" key={match.id}>
                                  <div>
                                    <strong>{match.title}</strong>
                                    <span>
                                      {[match.confidence, match.fileSize ?? "size unknown", uploadedAt ? `uploaded ${uploadedAt}` : undefined].filter(Boolean).join(" / ")}
                                    </span>
                                  </div>
                                  <div className="uri-actions">
                                    {match.uris.slice(0, 3).map((uri) => (
                                      <button key={uri} className="icon-action" title={uri} onClick={() => void copy(uri).then(onChanged)}>
                                        <Clipboard size={15} />
                                        {uri.startsWith("magnet:") ? "Copy magnet" : "Copy link"}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                            {hasMore ? (
                              <button className="icon-action show-more-matches" type="button" onClick={() => showMoreSourceMatches(group.sourceId)}>
                                Show more
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </aside>
        </div>
      </motion.section>
    </motion.div>
    {viewer ? <ImageViewer images={viewer.images} initialIndex={viewer.index} reduceMotion={reduceMotion} onClose={() => setViewer(undefined)} /> : null}
    <AnimatePresence>
      {assetEditorOpen ? (
        <GameAssetEditor
          game={game}
          reduceMotion={reduceMotion}
          onSaved={(updated) => {
            onGameUpdated(updated);
            onChanged();
          }}
          onClose={() => setAssetEditorOpen(false)}
        />
      ) : null}
    </AnimatePresence>
    </>
  );
}

type GameContextMenuRequest = {
  game: Game;
  x: number;
  y: number;
};

type NameDialogState = {
  title: string;
  initialValue: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
};

function NameDialog({ state, onClose }: { state: NameDialogState; onClose: () => void }) {
  const [value, setValue] = useState(state.initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    setValue(state.initialValue);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [state]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    state.onSubmit(trimmed);
    onClose();
  }

  return (
    <motion.div className="modal-backdrop name-dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="image-viewer-scrim" type="button" aria-label="Close dialog" onClick={onClose} />
      <motion.form
        className="name-dialog"
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.14 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="modal-head">
          <h2>{state.title}</h2>
          <button className="close-button inline-close" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="name-dialog-body">
          <input
            ref={inputRef}
            className="plain-input"
            value={value}
            autoFocus
            aria-label={state.title}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="settings-actions">
            <button className="primary-action" type="submit" disabled={!value.trim()}>
              {state.submitLabel ?? "Save"}
            </button>
            <button className="secondary-action" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </motion.form>
    </motion.div>
  );
}

function SteamSwitchModal({ prompt }: { prompt: SteamSwitchPrompt }) {
  const confirm = () => prompt.resolve(true);
  const cancel = () => prompt.resolve(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prompt]);

  return (
    <motion.div className="modal-backdrop switch-dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="image-viewer-scrim" type="button" aria-label="Cancel account switch" onClick={cancel} />
      <motion.div
        className="name-dialog switch-dialog"
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.14 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="steam-switch-title"
      >
        <div className="modal-head">
          <div>
            <p className="eyebrow">Steam account</p>
            <h2 id="steam-switch-title">Switch before launch?</h2>
          </div>
          <button className="close-button inline-close" type="button" onClick={cancel} aria-label="Cancel account switch">
            <X size={18} />
          </button>
        </div>
        <div className="name-dialog-body switch-dialog-body">
          <p>
            <strong>{prompt.gameTitle}</strong> needs Steam to switch from <span>{prompt.fromLabel}</span> to <span>{prompt.toLabel}</span>.
          </p>
          <p className="muted">Steam will close and restart silently, then Hynite will launch the game.</p>
          <div className="settings-actions">
            <button className="primary-action" type="button" onClick={confirm}>
              Switch and launch
            </button>
            <button className="secondary-action" type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function MenuDivider() {
  return <div className="context-menu-divider" role="separator" />;
}

function MenuItem({
  children,
  icon,
  danger,
  disabled,
  onClick
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" className={danger ? "context-menu-item danger" : "context-menu-item"} disabled={disabled} onClick={onClick}>
      <span className="context-menu-icon">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

function MenuSubmenu({
  label,
  icon,
  children,
  disabled
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  function closeIfTransient() {
    if (!pinned) {
      setOpen(false);
    }
  }

  return (
    <div
      className={[
        "context-menu-submenu",
        disabled ? "disabled" : "",
        open ? "open" : "",
        pinned ? "pinned" : ""
      ].filter(Boolean).join(" ")}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={closeIfTransient}
    >
      <button
        type="button"
        className="context-menu-item"
        disabled={disabled}
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          if (disabled) return;
          setOpen((value) => !value || !pinned);
          setPinned((value) => !value);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setOpen(true);
            setPinned(true);
          }
          if (event.key === "Escape") {
            setOpen(false);
            setPinned(false);
          }
        }}
      >
        <span className="context-menu-icon">{icon}</span>
        <span>{label}</span>
        <ChevronRight size={14} />
      </button>
      {!disabled ? <div className="context-submenu-panel">{children}</div> : null}
    </div>
  );
}

function GameContextMenu({
  request,
  settings,
  activeGroup,
  onClose,
  onSelect,
  onSettingsChanged,
  onCreateManualGroup,
  onChanged
}: {
  request?: GameContextMenuRequest;
  settings?: AppSettings;
  activeGroup?: GameGroup;
  onClose: () => void;
  onSelect: (game: Game) => void;
  onSettingsChanged: (settings: AppSettings) => void;
  onCreateManualGroup: (game: Game) => void;
  onChanged: () => void;
}) {
  const game = request?.game;
  const open = Boolean(request && game);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!request) {
      return;
    }
    const margin = 8;
    const approximateWidth = 260;
    const approximateHeight = 380;
    const base = {
      left: Math.max(margin, Math.min(request.x, window.innerWidth - approximateWidth - margin)),
      top: Math.max(margin, Math.min(request.y, window.innerHeight - approximateHeight - margin))
    };
    setPosition(base);
    requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      setPosition({
        left: Math.max(margin, Math.min(request.x, window.innerWidth - menu.offsetWidth - margin)),
        top: Math.max(margin, Math.min(request.y, window.innerHeight - menu.offsetHeight - margin))
      });
    });
  }, [request]);

  useEffect(() => {
    if (!open) return;
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, onClose]);

  if (!open || !game) {
    return null;
  }

  const isInstalled = game.installState === "installed";
  const launchable = canLaunch(game);
  const locationPath = gameLocationPath(game);
  const appId = steamAppId(game);
  const isLocal = game.sourceIds.some((source) => source.provider === "local");
  const launchAccounts = resolveLaunchableSteamAccounts(game, settings?.steamAccounts ?? []);
  const manualGroups = normalizeGroups(settings).filter((group): group is ManualGameGroup => group.kind === "manual");
  const currentPreferred = settings?.launchAccountPreferences?.[game.id];
  const currentManualGroup = activeGroup?.kind === "manual" ? activeGroup : undefined;

  async function saveGroups(nextGroups: GameGroup[]) {
    const next = await window.hynite.settings.update({ gameGroups: nextGroups });
    onSettingsChanged(next);
  }

  async function toggleManualGroup(group: ManualGameGroup) {
    const now = new Date().toISOString();
    const hasGame = group.gameIds.includes(game!.id);
    const nextGroups = normalizeGroups(settings).map((item) =>
      item.id === group.id && item.kind === "manual"
        ? { ...item, gameIds: hasGame ? item.gameIds.filter((id) => id !== game!.id) : [...item.gameIds, game!.id], updatedAt: now }
        : item
    );
    await saveGroups(nextGroups);
  }

  async function removeFromCurrentGroup() {
    if (!currentManualGroup) return;
    const now = new Date().toISOString();
    const nextGroups = normalizeGroups(settings).map((item) =>
      item.id === currentManualGroup.id && item.kind === "manual"
        ? { ...item, gameIds: item.gameIds.filter((id) => id !== game!.id), updatedAt: now }
        : item
    );
    await saveGroups(nextGroups);
  }

  async function setLaunchPreference(steamId: string | undefined) {
    const next = await window.hynite.steam.setPreferredLaunchAccount(game!.id, steamId);
    onSettingsChanged(next);
    await launchGame(game!, steamId);
  }

  async function deleteLocalGame() {
    if (!game || !window.confirm(`Delete "${game.title}" from the local library?`)) {
      return;
    }
    await window.hynite.local.removeGame(game.id);
    onChanged();
  }

  const run = (task: () => void | Promise<void>) => {
    onClose();
    void Promise.resolve(task()).catch(console.error);
  };

  return (
      <motion.div
        ref={menuRef}
        className={request.x > window.innerWidth - 520 ? "context-menu submenu-left" : "context-menu"}
        style={{ left: position.left, top: position.top }}
        initial={settings?.reduceMotion ? false : { opacity: 0, scale: 0.98, y: -2 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: settings?.reduceMotion ? 0 : 0.12 }}
        role="menu"
      >
        <div className="context-menu-title">
          <strong>{game.title}</strong>
          <span>{isInstalled ? "Installed" : launchable ? "Launchable" : "Details only"}</span>
        </div>
        <MenuItem icon={isInstalled ? <Play size={14} fill="currentColor" /> : <Download size={14} />} disabled={!launchable} onClick={() => run(() => launchGame(game))}>
          {isInstalled ? "Play" : "Download"}
        </MenuItem>
        <MenuItem icon={<Info size={14} />} onClick={() => run(() => onSelect(game))}>
          Details
        </MenuItem>
        {isLocal ? (
          <MenuItem icon={<Trash2 size={14} />} danger onClick={() => run(deleteLocalGame)}>
            Delete
          </MenuItem>
        ) : null}
        <MenuItem
          icon={<FolderOpen size={14} />}
          disabled={!locationPath}
          onClick={() => locationPath ? run(async () => {
            const error = await window.hynite.native.openFolder(locationPath);
            if (error) window.alert(error);
          }) : undefined}
        >
          Open game location
        </MenuItem>
        <MenuItem icon={<ExternalLink size={14} />} disabled={!steamStoreUrl(game)} onClick={() => run(() => openExternalUrl(steamStoreUrl(game)))}>
          Open Steam store
        </MenuItem>
        {launchAccounts.length > 0 ? (
          <MenuSubmenu label="Launch account" icon={<Users size={14} />}>
            <MenuItem icon={!currentPreferred ? <Check size={14} /> : null} onClick={() => run(() => setLaunchPreference(undefined))}>
              Automatic
            </MenuItem>
            {launchAccounts.map((account) => (
              <MenuItem
                key={account.steamId}
                icon={currentPreferred === account.steamId ? <Check size={14} /> : null}
                onClick={() => run(() => setLaunchPreference(account.steamId))}
              >
                {(account.personaName ?? account.localUsername ?? account.steamId)} · {account.kind === "owner" ? "Owner" : "Family"}
              </MenuItem>
            ))}
          </MenuSubmenu>
        ) : null}
        <MenuSubmenu label="Add to group" icon={<Plus size={14} />}>
          {manualGroups.length === 0 ? <div className="context-menu-note">No manual groups</div> : null}
          {manualGroups.map((group) => (
            <MenuItem
              key={group.id}
              icon={group.gameIds.includes(game.id) ? <Check size={14} /> : null}
              onClick={() => run(() => toggleManualGroup(group))}
            >
              {group.name}
            </MenuItem>
          ))}
          <MenuDivider />
          <MenuItem icon={<Plus size={14} />} onClick={() => run(() => onCreateManualGroup(game))}>
            New manual group...
          </MenuItem>
        </MenuSubmenu>
        {currentManualGroup?.gameIds.includes(game.id) ? (
          <MenuItem icon={<X size={14} />} onClick={() => run(removeFromCurrentGroup)}>
            Remove from this group
          </MenuItem>
        ) : null}
        <MenuDivider />
        <MenuItem icon={<Clipboard size={14} />} onClick={() => run(() => window.hynite.clipboard.copy(game.title))}>
          Copy title
        </MenuItem>
        <MenuItem icon={<Clipboard size={14} />} disabled={!appId} onClick={() => appId ? run(() => window.hynite.clipboard.copy(appId)) : undefined}>
          Copy Steam app ID
        </MenuItem>
      </motion.div>
  );
}

function UpdaterStarSvg() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 784.11 815.53" aria-hidden>
      <path d="M392.05 0c-20.9,210.08 -184.06,378.41 -392.05,407.78 207.96,29.37 371.12,197.68 392.05,407.74 20.93,-210.06 184.09,-378.37 392.05,-407.74 -207.98,-29.38 -371.16,-197.69 -392.06,-407.78z" />
    </svg>
  );
}

function UpdaterPill({ status, onDownload, onInstall }: {
  status: UpdaterStatus | undefined;
  onDownload?: () => void;
  onInstall?: () => void;
}) {
  if (!status || !status.supported) return null;
  const { phase } = status;
  if (phase !== "available" && phase !== "downloading" && phase !== "downloaded" && phase !== "error") return null;

  const busy = phase === "downloading";
  const percent = status.percent ?? 0;

  const handleClick = () => {
    if (phase === "available") { if (onDownload) onDownload(); else void window.hynite.updater.download(); }
    else if (phase === "downloaded") { if (onInstall) onInstall(); else void window.hynite.updater.install(); }
    else if (phase === "error") void window.hynite.updater.check();
  };

  const label =
    phase === "available" ? "Update available"
    : phase === "downloading" ? "Downloading"
    : phase === "downloaded" ? "Restart to update"
    : "Update failed";

  const Icon = phase === "downloaded" ? RotateCcw : phase === "downloading" ? Loader2 : phase === "error" ? RefreshCw : Download;

  return (
    <button
      type="button"
      className={`rail-update rail-update--${phase}`}
      onClick={handleClick}
      disabled={busy}
      style={phase === "downloading" ? ({ "--rail-update-pct": `${percent}%` } as CSSProperties) : undefined}
    >
      <Icon size={15} className={busy ? "rail-update-spin" : undefined} />
      <span className="rail-label">{label}</span>
      {phase === "downloading" ? (
        <span className="rail-update-pct-label">{percent}%</span>
      ) : null}
      {phase === "available" && (
        <>
          <span className="rail-update-star star-1" aria-hidden><UpdaterStarSvg /></span>
          <span className="rail-update-star star-2" aria-hidden><UpdaterStarSvg /></span>
          <span className="rail-update-star star-3" aria-hidden><UpdaterStarSvg /></span>
          <span className="rail-update-star star-4" aria-hidden><UpdaterStarSvg /></span>
          <span className="rail-update-star star-5" aria-hidden><UpdaterStarSvg /></span>
          <span className="rail-update-star star-6" aria-hidden><UpdaterStarSvg /></span>
        </>
      )}
    </button>
  );
}

function LauncherShell() {
  const [route, setRoute] = useState<Route>("home");
  const routeRef = useRef<Route>("home");
  const [home, setHome] = useState<HomeModel | undefined>();
  const [homeDiscoveryLoading, setHomeDiscoveryLoading] = useState(false);
  const [games, setGames] = useState<Game[]>([]);
  const [recentGames, setRecentGames] = useState<Game[]>([]);
  const [allGames, setAllGames] = useState<Game[]>([]);
  const [libraryGameIds, setLibraryGameIds] = useState<Set<string>>(() => new Set());
  const [wishlistCount, setWishlistCount] = useState(0);
  const [homeWishlistItems, setHomeWishlistItems] = useState<SteamWishlistItem[]>([]);
  const [selected, setSelected] = useState<GameDetail | undefined>();
  const [selectedPending, setSelectedPending] = useState<Game | undefined>();
  const detailFromSkeletonRef = useRef(false);
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [localIssueCount, setLocalIssueCount] = useState(0);
  const [activeGroupId, setActiveGroupIdState] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<GameContextMenuRequest | undefined>();
  const [nameDialog, setNameDialog] = useState<NameDialogState | undefined>();
  const [switchPrompt, setSwitchPrompt] = useState<SteamSwitchPrompt | undefined>();
  const [launchFailurePrompt, setLaunchFailurePrompt] = useState<LaunchFailurePromptState | undefined>();
  const [settingsHealthWarning, setSettingsHealthWarning] = useState<SettingsHealthWarning | undefined>();
  const [launchHandoff, setLaunchHandoff] = useState<LaunchHandoffState | undefined>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus | undefined>();
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus | undefined>();
  const [fakeUpdaterStatus, setFakeUpdaterStatus] = useState<UpdaterStatus | undefined>();
  const fakeDownloadRef = useRef<(() => void) | undefined>(undefined);
  const [query, setQueryState] = useState("");
  const queryRef = useRef("");
  const setQuery = useCallback((next: string) => {
    queryRef.current = next;
    setQueryState(next);
  }, []);
  const [libraryView, setLibraryViewState] = useState<LibraryView>(defaultLibraryView);
  const libraryViewRef = useRef<LibraryView>(defaultLibraryView);
  const setLibraryView = useCallback((next: LibraryView | ((current: LibraryView) => LibraryView)) => {
    if (typeof next !== "function") {
      const normalized = normalizeLibraryView(next);
      libraryViewRef.current = normalized;
      setLibraryViewState(normalized);
      return;
    }
    setLibraryViewState((current) => {
      const resolved = next(current);
      const normalized = normalizeLibraryView(resolved);
      libraryViewRef.current = normalized;
      return normalized;
    });
  }, []);
  const libraryViewHydratedRef = useRef(false);
  const librarySaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeGroupIdRef = useRef<string | undefined>();
  const settingsRef = useRef<AppSettings | undefined>();
  const gamesRef = useRef<Game[]>([]);
  const allGamesRef = useRef<Game[]>([]);
  const recentGamesRef = useRef<Game[]>([]);
  const selectedRef = useRef<GameDetail | undefined>();
  const launchHandoffTokenRef = useRef(0);
  const launchHandoffTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const launchHandoffFocusCleanupRef = useRef<(() => void) | undefined>();
  const startupSoundPlayedRef = useRef(false);
  const navigationSoundReadyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const homeFirstLoadedRef = useRef(false);
  const [startupDone, setStartupDone] = useState(false);
  const [musicStatus, setMusicStatus] = useState<MusicStatus>(() => musicEngine.getStatus());
  const [bigPicture, setBigPicture] = useState(false);
  const [bpFiltersOpen, setBpFiltersOpen] = useState(false);
  const [bpFilters, setBpFilters] = useState<LibraryFilters>({});
  const bigPictureRef = useRef(false);
  const focusComboPressedRef = useRef(false);
  const contentRef = useRef<HTMLElement | null>(null);
  const handledSyncSuccessAtRef = useRef<string | undefined>();
  const initialLoadStartedRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | undefined>();
  const homePromiseRef = useRef<Promise<HomeModel> | undefined>();
  const homeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const homeDiscoveryLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const homeRefreshRetryRef = useRef(0);
  const homeApplyTokenRef = useRef(0);
  const homeDetailCacheRef = useRef<Map<string, GameDetail>>(new Map());
  const homeDetailPrefetchRef = useRef<Map<string, Promise<GameDetail>>>(new Map());
  const homeIntentPrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();
  const homeIntentPrefetchRunningRef = useRef(false);
  const prefersReducedMotion = usePrefersReducedMotion();
  const reduceLaunchMotion = Boolean(settings?.reduceMotion || prefersReducedMotion);
  const cardsPerRow = normalizeCardsPerRow(settings?.cardsPerRow);

  useEffect(() => {
    profileStartup("app:mounted", "App component mounted");
    startRuntimeFrameProfiler();
  }, []);

  useEffect(() => {
    if (!navigationSoundReadyRef.current) {
      navigationSoundReadyRef.current = true;
      return;
    }
    soundEngine.play("navigation");
  }, [route]);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    if (!isProfileEnabled()) return undefined;
    const content = contentRef.current;
    if (!content) return undefined;

    let scrollSpan: ReturnType<typeof startRuntimeInteraction> | undefined;
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let lastScrollTop = content.scrollTop;
    let lastScrollAt = performance.now();

    const endScrollSpan = (status: "ok" | "cancelled" = "ok") => {
      if (endTimer) {
        clearTimeout(endTimer);
        endTimer = undefined;
      }
      if (!scrollSpan) return;
      scrollSpan.end(status, {
        scrollTop: Math.round(content.scrollTop),
        route: routeRef.current
      });
      scrollSpan = undefined;
    };

    const onScroll = () => {
      if (routeRef.current !== "library" && routeRef.current !== "wishlist") return;
      const now = performance.now();
      const scrollTop = content.scrollTop;
      const elapsedMs = Math.max(1, now - lastScrollAt);
      const velocity = Math.abs(scrollTop - lastScrollTop) / elapsedMs;
      lastScrollTop = scrollTop;
      lastScrollAt = now;

      updateRuntimeProfileContext({
        route: routeRef.current,
        area: routeRef.current,
        scrollTop: Math.round(scrollTop),
        scrollVelocityPxPerMs: Math.round(velocity * 100) / 100
      });

      if (!scrollSpan) {
        const route = routeRef.current;
        scrollSpan = startRuntimeInteraction(`${route}:scroll-session`, {
          route,
          scrollTop: Math.round(scrollTop)
        });
      }
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(() => endScrollSpan("ok"), 180);
    };

    content.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      content.removeEventListener("scroll", onScroll);
      endScrollSpan("cancelled");
    };
  }, []);

  useEffect(() => {
    void window.hynite.settings.get().then((nextSettings) => {
      soundEngine.applySettings(nextSettings);
      musicEngine.applySettings(nextSettings);
    }).catch((error: unknown) => {
      console.error("Failed to initialize sound settings", error);
    });
  }, []);

  useEffect(() => {
    const onFocus = () => musicEngine.setFocused(true);
    const onBlur = () => musicEngine.setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => musicEngine.subscribe(setMusicStatus), []);

  useEffect(() => {
    const wasBigPicture = bigPictureRef.current;
    if (bigPicture && !wasBigPicture) {
      soundEngine.play("bigPictureOpen");
    }
    musicEngine.setForcedOverrides({ forceEnabled: bigPicture, forceContinuous: bigPicture });
    void window.hynite.window.setFullScreen(bigPicture).catch(() => undefined);
    bigPictureRef.current = bigPicture;
    document.body.classList.toggle("bp-active", bigPicture);
  }, [bigPicture]);

  useEffect(() => {
    let raf = 0;
    const poll = () => {
      const controller = normalizeControllerSettings(settingsRef.current);
      if (!controller.backgroundInput && !document.hasFocus()) {
        focusComboPressedRef.current = false;
        raf = requestAnimationFrame(poll);
        return;
      }
      const { pressed, connected } = readGamepadState();
      if (!connected) {
        focusComboPressedRef.current = false;
        raf = requestAnimationFrame(poll);
        return;
      }
      const comboPressed = controller.enabled && bindingPressed(controller.bindings.focusBigPicture, pressed);
      if (comboPressed && !focusComboPressedRef.current && !bigPictureRef.current && !(document.hasFocus() && routeRef.current === "settings")) {
        setBigPicture(true);
        void window.hynite.window.focusBigPicture().catch(() => undefined);
      }
      focusComboPressedRef.current = comboPressed;
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    // setInterval fallback: on Windows, XInput stops delivering gamepad data to
    // unfocused windows even when backgroundThrottling=false. A separate interval
    // loop runs only when the window is NOT focused to catch the enter-BP combo.
    const intervalPoll = () => {
      if (document.hasFocus()) return; // rAF handles focused case
      const controller = normalizeControllerSettings(settingsRef.current);
      if (!controller.enabled || !controller.backgroundInput) return;
      const { pressed, connected } = readGamepadState();
      if (!connected) { focusComboPressedRef.current = false; return; }
      const comboPressed = bindingPressed(controller.bindings.focusBigPicture, pressed);
      if (comboPressed && !focusComboPressedRef.current && !bigPictureRef.current) {
        setBigPicture(true);
        void window.hynite.window.focusBigPicture().catch(() => undefined);
      }
      focusComboPressedRef.current = comboPressed;
    };
    const intervalId = window.setInterval(intervalPoll, 50);
    return () => { cancelAnimationFrame(raf); clearInterval(intervalId); };
  }, []);

  useEffect(() => {
    return window.hynite.controller.onBgBpCombo(() => {
      if (!bigPictureRef.current) {
        setBigPicture(true);
      }
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F11") {
        event.preventDefault();
        setBigPicture((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__hyniteMusic = {
      status() {
        const s = musicEngine.getStatus();
        console.group("[hynite music] current status");
        console.log("audible        :", s.audible, "(actually outputting sound)");
        console.log("playing        :", s.playing, "(source node alive)");
        console.log("inGap          :", s.inGap, "(between tracks)");
        console.log("focused        :", s.focused, "(window has focus)");
        console.log("systemAudio    :", s.systemAudioActive, "(external media detected by SMTC)");
        console.log("settingsEnabled:", s.settingsEnabled);
        console.log("hasTracks      :", s.hasTracks);
        console.log("pauseReason    :", s.pauseReason ?? "none (music is playing or not active)");
        console.log("currentTrack   :", s.currentTrackIndex);
        console.log("queue          :", s.queue, "pos:", s.queueIndex);
        console.log("prevQueueTail  :", s.prevQueueTail);
        console.groupEnd();
        return s;
      },
      async testSystemAudio() {
        console.log("[hynite music] Running SMTC scan via main process...");
        const result = await window.hynite.music.systemAudioDebug();
        console.log("[hynite music] Scan result:\n" + result);
        return result;
      },
      skip() {
        musicEngine.skipToNext();
        console.log("[hynite music] skipped");
      }
    };
    console.log(
      "%c[hynite music] Debug commands available:%c\n" +
      "  window.__hyniteMusic.status()          — log current engine state + queue\n" +
      "  window.__hyniteMusic.testSystemAudio() — run SMTC scan and list all media sessions\n" +
      "  window.__hyniteMusic.skip()            — skip to the next track in the queue",
      "color:#8fbfff;font-weight:bold", "color:inherit"
    );
  }, []);

  useEffect(() => {
    const api = {
      async list(): Promise<SettingsBackupInfo[]> {
        const backups = await window.hynite.settings.listBackups();
        console.table(backups.map((backup) => ({
          date: new Date(backup.createdAt).toLocaleString(),
          id: backup.id,
          restore: backup.restoreCommand
        })));
        return backups;
      },
      async restore(id: string): Promise<AppSettings> {
        const restored = await window.hynite.settings.restoreBackup(id);
        console.log("[hynite settings] restored backup", id);
        settingsRef.current = restored;
        setSettings(restored);
        setSettingsHealthWarning(undefined);
        void refresh();
        return restored;
      }
    };
    (window as unknown as Record<string, unknown>).__hyniteSettings = api;
    console.log(
      "%c[hynite settings] Backup commands available:%c\n" +
      "  await window.__hyniteSettings.list()          - list backups and restore commands\n" +
      "  await window.__hyniteSettings.restore(\"id\")  - restore one backup",
      "color:#8fbfff;font-weight:bold", "color:inherit"
    );
    void window.hynite.settings.health().then(setSettingsHealthWarning).catch((error: unknown) => {
      console.error("Failed to check settings health", error);
    });
  }, []);

  useEffect(() => {
    const HYNITE_SELF_ID = "hynite:self";
    (window as unknown as Record<string, unknown>).__hyniteDev = {
      addHyniteApp() {
        const game: Game = {
          id: HYNITE_SELF_ID,
          title: "Hynite",
          sortTitle: "hynite",
          sourceIds: [],
          installState: "not_installed",
          logoUrl: logo1024Url,
          libraryCapsuleUrl: logo1024Url,
          coverUrl: logo1024Url,
          shortDescription: "Hynite is a game launcher built around browsing, not managing. Your full Steam library, local games (added automatically), and Hydra download sources. All in one place, with wishlists, discovery, and a PlayStation-inspired Big Picture mode. Everything you’d lose by leaving the Steam client, kept.",
          screenshots: [],
          contentDescriptors: [],
          genres: [],
          tags: [],
          playerModes: [],
          developers: ["yuma-dev"],
          publishers: ["yuma-dev"],
          metadataStatus: "complete"
        };
        setGames((current) => [game, ...current.filter((g) => g.id !== HYNITE_SELF_ID)]);
        setAllGames((current) => [game, ...current.filter((g) => g.id !== HYNITE_SELF_ID)]);
        console.log("[hynite dev] Added Hynite app to library");
      },
      removeHyniteApp() {
        setGames((current) => current.filter((g) => g.id !== HYNITE_SELF_ID));
        setAllGames((current) => current.filter((g) => g.id !== HYNITE_SELF_ID));
        console.log("[hynite dev] Removed Hynite app from library");
      }
    };
    console.log(
      "%c[hynite dev] Dev commands available:%c\n" +
      "  window.__hyniteDev.addHyniteApp()      — add Hynite app card to library & BP mode\n" +
      "  window.__hyniteDev.removeHyniteApp()   — remove it\n" +
      "  window.__hyniteDev.setBgNoise(0.6)     — set BP background noise amount (0–1+)",
      "color:#8fbfff;font-weight:bold", "color:inherit"
    );
  }, []);

  useEffect(() => {
    const onSwitchPrompt = (event: Event) => {
      const detail = (event as CustomEvent<Omit<SteamSwitchPrompt, "resolve"> & {
        handled: boolean;
        resolve: (confirmed: boolean) => void;
      }>).detail;
      if (!detail) {
        return;
      }
      detail.handled = true;
      setSwitchPrompt({
        gameId: detail.gameId,
        gameTitle: detail.gameTitle,
        fromLabel: detail.fromLabel,
        toLabel: detail.toLabel,
        targetSteamId: detail.targetSteamId,
        resolve: (confirmed) => {
          setSwitchPrompt(undefined);
          detail.resolve(confirmed);
        }
      });
    };

    window.addEventListener(STEAM_SWITCH_CONFIRM_EVENT, onSwitchPrompt);
    return () => window.removeEventListener(STEAM_SWITCH_CONFIRM_EVENT, onSwitchPrompt);
  }, []);

  useEffect(() => {
    const onLaunchFailure = (event: Event) => {
      const detail = (event as CustomEvent<LaunchFailureOutcome>).detail;
      if (!detail) {
        return;
      }
      setLaunchFailurePrompt({ ...detail, reportStatus: "idle" });
    };

    window.addEventListener(LAUNCH_FAILURE_EVENT, onLaunchFailure);
    return () => window.removeEventListener(LAUNCH_FAILURE_EVENT, onLaunchFailure);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    gamesRef.current = games;
  }, [games]);

  useEffect(() => {
    allGamesRef.current = allGames;
  }, [allGames]);

  useEffect(() => {
    recentGamesRef.current = recentGames;
  }, [recentGames]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const setActiveGroupId = useCallback((next: string | undefined) => {
    activeGroupIdRef.current = next;
    setActiveGroupIdState(next);
  }, []);

  const reportCurrentLaunchFailure = useCallback(() => {
    if (!launchFailurePrompt || launchFailurePrompt.reportStatus === "sending" || launchFailurePrompt.reportStatus === "sent") {
      return;
    }

    const failure = launchFailurePrompt;
    setLaunchFailurePrompt({ ...failure, reportStatus: "sending", reportError: undefined });
    try {
      const reportEventId = reportLaunchFailure(failure);
      setLaunchFailurePrompt((current) => current?.gameId === failure.gameId && current.technicalMessage === failure.technicalMessage
        ? { ...current, reportStatus: "sent", reportEventId }
        : current);
    } catch (error) {
      setLaunchFailurePrompt((current) => current?.gameId === failure.gameId && current.technicalMessage === failure.technicalMessage
        ? {
            ...current,
            reportStatus: "failed",
            reportError: error instanceof Error ? error.message : "Report failed."
          }
        : current);
    }
  }, [launchFailurePrompt]);

  const resolveLaunchSnapshot = useCallback(async (detail: LaunchGameEventDetail): Promise<Game | GameDetail | undefined> => {
    if (detail.game) {
      return detail.game;
    }
    const selectedGame = selectedRef.current;
    if (selectedGame?.id === detail.id) {
      return selectedGame;
    }
    const localGame =
      gamesRef.current.find((game) => game.id === detail.id) ??
      allGamesRef.current.find((game) => game.id === detail.id) ??
      recentGamesRef.current.find((game) => game.id === detail.id);
    if (localGame) {
      return localGame;
    }
    try {
      return await window.hynite.games.get(detail.id);
    } catch {
      return undefined;
    }
  }, []);

  const startLaunchHandoff = useCallback((game: Game | GameDetail, options?: { minimize?: boolean; durationMs?: number }) => {
    const token = launchHandoffTokenRef.current + 1;
    launchHandoffTokenRef.current = token;
    if (launchHandoffTimerRef.current) {
      clearTimeout(launchHandoffTimerRef.current);
      launchHandoffTimerRef.current = undefined;
    }
    launchHandoffFocusCleanupRef.current?.();
    launchHandoffFocusCleanupRef.current = undefined;
    setLaunchHandoff(undefined);

    const finish = () => {
      if (launchHandoffTokenRef.current !== token) {
        return;
      }
      if (launchHandoffTimerRef.current) {
        clearTimeout(launchHandoffTimerRef.current);
        launchHandoffTimerRef.current = undefined;
      }
      launchHandoffFocusCleanupRef.current?.();
      launchHandoffFocusCleanupRef.current = undefined;
      if (options?.minimize === false) {
        setLaunchHandoff(undefined);
        return;
      }
      void window.hynite.window.minimize()
        .catch((error: unknown) => console.error("Failed to minimize after launch", error))
        .finally(() => {
          if (launchHandoffTokenRef.current === token) {
            setLaunchHandoff(undefined);
          }
        });
    };

    void loadLaunchHandoffAssets(game).then((assets) => {
      if (launchHandoffTokenRef.current !== token) {
        return;
      }
      setLaunchHandoff({ token, game, ...assets, reduceMotion: reduceLaunchMotion });

      if (options?.minimize === false) {
        const duration = options.durationMs ?? (reduceLaunchMotion ? LAUNCH_HANDOFF_REDUCED_PREVIEW_MS : LAUNCH_HANDOFF_PREVIEW_MS);
        launchHandoffTimerRef.current = setTimeout(finish, duration);
        return;
      }

      const onBlur = () => finish();
      window.addEventListener("blur", onBlur, { once: true });
      launchHandoffFocusCleanupRef.current = () => window.removeEventListener("blur", onBlur);
      launchHandoffTimerRef.current = setTimeout(finish, options?.durationMs ?? LAUNCH_HANDOFF_MAX_MS);
      if (!document.hasFocus()) {
        setTimeout(finish, 0);
      }
    });
  }, [reduceLaunchMotion]);

  useEffect(() => {
    window.hyniteDebugSplash = (durationMs?: number) => {
      const candidates = [
        ...allGamesRef.current,
        ...gamesRef.current,
        ...recentGamesRef.current
      ];
      const unique = [...new Map(candidates.map((game) => [game.id, game])).values()];
      const game = unique[Math.floor(Math.random() * unique.length)];
      if (!game) {
        console.warn("No games are loaded yet.");
        return;
      }
      startLaunchHandoff(game, {
        minimize: false,
        durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined
      });
    };
    return () => {
      delete window.hyniteDebugSplash;
    };
  }, [startLaunchHandoff]);

  useEffect(() => {
    const onLaunchGame = (event: Event) => {
      const detail = (event as CustomEvent<LaunchGameEventDetail>).detail;
      if (!detail) {
        return;
      }
      detail.handled = true;
      void (async () => {
        const game = await resolveLaunchSnapshot(detail);
        const launched = await runLaunchFlow(detail.id, detail.preferredSteamId);
        if (launched && game && settingsRef.current?.autoHideAfterLaunch !== false) {
          startLaunchHandoff(game);
        }
      })().then(detail.resolve, detail.reject);
    };

    window.addEventListener(LAUNCH_GAME_EVENT, onLaunchGame);
    return () => window.removeEventListener(LAUNCH_GAME_EVENT, onLaunchGame);
  }, [resolveLaunchSnapshot, startLaunchHandoff]);

  useEffect(() => {
    return () => {
      launchHandoffTokenRef.current += 1;
      if (launchHandoffTimerRef.current) {
        clearTimeout(launchHandoffTimerRef.current);
      }
      launchHandoffFocusCleanupRef.current?.();
      launchHandoffFocusCleanupRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    setContextMenu(undefined);
  }, [route]);

  const groups = normalizeGroups(settings);
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const activeQuery = activeGroup?.kind === "smart" ? (activeGroup.search ?? "") : query;
  const activeLibraryView = useMemo(
    () => activeGroup?.kind === "smart" ? normalizeLibraryView(activeGroup.view) : libraryView,
    [activeGroup, libraryView]
  );

  useEffect(() => {
    updateRuntimeProfileContext({
      route,
      bigPicture,
      area: bigPicture ? "big-picture" : route,
      totalGames: route === "library" ? games.length : route === "wishlist" ? wishlistCount : allGames.length,
      wishlistItems: wishlistCount,
      cardsPerRow,
      activeGroupId: activeGroup?.id,
      activeGroupName: activeGroup?.name,
      libraryQuery: activeQuery
    });
  }, [activeGroup?.id, activeGroup?.name, activeQuery, allGames.length, bigPicture, cardsPerRow, games.length, route, wishlistCount]);

  // Big Picture uses the user's library sort and stacks the Big Picture filter
  // sheet on top. "All Games" and group tabs get filtered+sorted; Recent and
  // Installed tabs are computed inside BigPictureScreen from their own pools.
  const bpSortedAll = useMemo(() => {
    const filtered = applyLibraryFilters(allGames, bpFilters);
    return sortGamesByField(filtered, libraryView.sort.field, libraryView.sort.direction);
  }, [allGames, bpFilters, libraryView.sort.field, libraryView.sort.direction]);

  const bigPictureGroupGames = useMemo(() => {
    const map = new Map<string, Game[]>();
    const currentGroups = normalizeGroups(settings);
    const baseSort = libraryView.sort;
    for (const group of currentGroups) {
      let scoped: Game[];
      if (group.kind === "manual") {
        const ids = new Set(group.gameIds);
        scoped = allGames.filter((game) => ids.has(game.id));
      } else {
        const normalized = normalizeLibraryView(group.view);
        scoped = [...allGames];
        const scopedSearch = (group.search ?? "").trim().toLocaleLowerCase();
        if (scopedSearch) scoped = scoped.filter((game) => game.title.toLocaleLowerCase().includes(scopedSearch));
        scoped = applyLibraryFilters(scoped, normalized.filters);
      }
      scoped = applyLibraryFilters(scoped, bpFilters);
      scoped = sortGamesByField(scoped, baseSort.field, baseSort.direction);
      map.set(group.id, scoped);
    }
    return map;
  }, [settings, allGames, bpFilters, libraryView.sort]);

  const bpFacets = useMemo(() => {
    const sourceSet = new Set<ProviderId>();
    const genreSet = new Set<string>();
    const tagSet = new Set<string>();
    const playerModeSet = new Set<PlayerMode>();
    for (const game of allGames) {
      for (const source of game.sourceIds) sourceSet.add(source.provider);
      for (const genre of game.genres) genreSet.add(genre);
      for (const tag of game.tags) tagSet.add(tag);
      for (const mode of game.playerModes) playerModeSet.add(mode);
    }
    return {
      sources: [...sourceSet].sort(),
      genres: [...genreSet].sort((a, b) => a.localeCompare(b)),
      tags: [...tagSet].sort((a, b) => a.localeCompare(b)),
      playerModes: [...playerModeSet]
    };
  }, [allGames]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const currentGroups = normalizeGroups(settings);
    for (const group of currentGroups) {
      if (group.kind === "manual") {
        counts.set(group.id, allGames.filter((game) => group.gameIds.includes(game.id)).length);
      } else {
        const normalized = normalizeLibraryView(group.view);
        let scoped = [...allGames];
        const scopedSearch = (group.search ?? "").trim().toLocaleLowerCase();
        if (scopedSearch) scoped = scoped.filter((game) => game.title.toLocaleLowerCase().includes(scopedSearch));
        scoped = applyLibraryFilters(scoped, normalized.filters);
        counts.set(group.id, scoped.length);
      }
    }
    return counts;
  }, [settings, allGames]);

  useEffect(() => {
    if (activeGroupId && settings && !activeGroup) {
      setActiveGroupId(undefined);
    }
  }, [activeGroupId, activeGroup, settings, setActiveGroupId]);

  function loadHome(options: { dedupe?: boolean } = {}): Promise<HomeModel> {
    const dedupe = options.dedupe !== false;
    if (dedupe && homePromiseRef.current) {
      homeDebug("renderer get reused in-flight request");
      return homePromiseRef.current;
    }

    const startedAt = performance.now();
    homeDebug("renderer get started", { dedupe });
    const promise = window.hynite.home.get().then((nextHome) => {
      homeDebug("renderer get finished", {
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        generatedAt: nextHome.generatedAt,
        stale: nextHome.stale,
        popularNow: nextHome.popularNow.length,
        heroTitles: nextHome.popularNow.slice(0, 5).map((game) => game.title)
      });
      return nextHome;
    }).catch((error: unknown) => {
      console.error("[home] renderer get failed", error);
      throw error;
    }).finally(() => {
      if (homePromiseRef.current === promise) {
        homePromiseRef.current = undefined;
      }
    });
    if (dedupe) {
      homePromiseRef.current = promise;
    }
    return promise;
  }

  function clearHomeDiscoveryLoadingTimer(): void {
    if (homeDiscoveryLoadingTimerRef.current) {
      clearTimeout(homeDiscoveryLoadingTimerRef.current);
      homeDiscoveryLoadingTimerRef.current = undefined;
    }
  }

  function trackHomeDiscoveryLoading(nextHome: HomeModel): void {
    const pending = nextHome.stale && !homeHasDiscoveryContent(nextHome);
    if (!pending) {
      clearHomeDiscoveryLoadingTimer();
      setHomeDiscoveryLoading(false);
      return;
    }

    setHomeDiscoveryLoading(true);
    if (homeDiscoveryLoadingTimerRef.current) {
      return;
    }

    homeDiscoveryLoadingTimerRef.current = setTimeout(() => {
      homeDiscoveryLoadingTimerRef.current = undefined;
      homeDebug("renderer discovery loading timeout elapsed", {
        timeoutMs: HOME_DISCOVERY_LOADING_MAX_MS
      });
      setHomeDiscoveryLoading(false);
    }, HOME_DISCOVERY_LOADING_MAX_MS);
  }

  function scheduleHomeRefresh(options: { retryIfStale?: boolean; delayMs?: number } = {}): void {
    const token = ++homeApplyTokenRef.current;
    if (homeRefreshTimerRef.current) {
      clearTimeout(homeRefreshTimerRef.current);
    }
    const delayMs = options.delayMs ?? HOME_REFRESH_DEBOUNCE_MS;
    homeDebug("renderer refresh scheduled", {
      token,
      delayMs,
      retryIfStale: options.retryIfStale,
      staleRetry: homeRefreshRetryRef.current
    });
    homeRefreshTimerRef.current = setTimeout(() => {
      homeRefreshTimerRef.current = undefined;
      void loadHome({ dedupe: false }).then((nextHome) => {
        if (homeApplyTokenRef.current === token) {
          setHome(nextHome);
          trackHomeDiscoveryLoading(nextHome);
        }
        if (nextHome.stale && options.retryIfStale && homeRefreshRetryRef.current < HOME_STALE_RETRY_MAX) {
          homeRefreshRetryRef.current += 1;
          homeDebug("renderer stale result; retrying", {
            attempt: homeRefreshRetryRef.current,
            max: HOME_STALE_RETRY_MAX
          });
          scheduleHomeRefresh({ retryIfStale: true, delayMs: HOME_STALE_RETRY_DELAY_MS });
        } else {
          if (nextHome.stale && options.retryIfStale) {
            console.warn("[home] renderer stale retries exhausted", {
              attempts: homeRefreshRetryRef.current,
              popularNow: nextHome.popularNow.length
            });
          }
          homeRefreshRetryRef.current = 0;
        }
      }).catch(console.error);
    }, delayMs);
  }

  function refresh(): Promise<void> {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const promise = runRefresh().finally(() => {
      if (refreshPromiseRef.current === promise) {
        refreshPromiseRef.current = undefined;
      }
    });
    refreshPromiseRef.current = promise;
    return promise;
  }

  async function runRefresh() {
    const startedAt = performance.now();
    const span = profileSpan("renderer-render", "renderer:refresh", {
      query: queryRef.current
    });
    const effectiveQuery = queryRef.current;
    let effectiveLibraryView = libraryViewRef.current;
    let loadedSettings: AppSettings | undefined;
    if (!libraryViewHydratedRef.current) {
      loadedSettings = await window.hynite.settings.get();
      effectiveLibraryView = normalizeLibraryView(loadedSettings.libraryView);
      libraryViewRef.current = effectiveLibraryView;
      setLibraryViewState(effectiveLibraryView);
      libraryViewHydratedRef.current = true;
    }
    const effectiveSettings = loadedSettings ?? settingsRef.current;
    const effectiveGroup = normalizeGroups(effectiveSettings).find((group) => group.id === activeGroupIdRef.current);
    profileStartup("refresh:start", "Renderer refresh started", {
      query: effectiveQuery,
      sort: effectiveLibraryView.sort,
      filters: effectiveLibraryView.filters,
      groupId: effectiveGroup?.id
    });
    const homePromise = loadHome();
    const librarySpan = profileSpan("library", "renderer:library-refresh-ipc");
    const [nextGames, nextRecentGames, nextSettings, nextWishlistCount] = await Promise.all([
      window.hynite.library.list(libraryQueryForView(effectiveQuery, effectiveLibraryView, effectiveGroup)),
      window.hynite.library.list({ search: "", sort: "recent", installState: "all" }),
      loadedSettings ? Promise.resolve(loadedSettings) : window.hynite.settings.get(),
      window.hynite.wishlist.count()
    ]);
    librarySpan.end("ok", { games: nextGames.length, recentGames: nextRecentGames.length });
    setGames(nextGames);
    setAllGames(nextRecentGames);
    setLibraryGameIds(new Set(nextRecentGames.map((game) => game.id)));
    setWishlistCount(nextWishlistCount);
    setRecentGames(nextRecentGames.filter((game) => gameActivityTime(game) > 0));
    settingsRef.current = nextSettings;
    soundEngine.applySettings(nextSettings);
    setSettings(nextSettings);
    void window.hynite.local
      .getIssues()
      .then((issues) => setLocalIssueCount(Array.isArray(issues) ? issues.length : 0))
      .catch(() => setLocalIssueCount(0));
    profileStartup("refresh:end", "Renderer refresh local data loaded", {
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      games: nextGames.length,
      recentGames: nextRecentGames.length,
      hasSettings: Boolean(nextSettings),
      hydratedFilters: libraryViewHydratedRef.current
    });
    span.end("ok", {
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      games: nextGames.length,
      recentGames: nextRecentGames.length
    });
    const homeToken = homeApplyTokenRef.current;
    void homePromise.then((nextHome) => {
      if (homeApplyTokenRef.current !== homeToken) {
        return;
      }
      const homeSpan = profileSpan("home", "renderer:home-model-apply");
      profileStartup("home:end", "Renderer home model loaded", {
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        stale: nextHome.stale,
        popularNow: nextHome.popularNow.length
      });
      setHome(nextHome);
      trackHomeDiscoveryLoading(nextHome);
      if (nextHome.stale) {
        scheduleHomeRefresh({ retryIfStale: true });
      }
      homeSpan.end("ok", { stale: nextHome.stale, popularNow: nextHome.popularNow.length });
    }).catch((error: unknown) => {
      profileStartup("home:error", "Renderer home model failed", { error: error instanceof Error ? error.message : String(error) });
      console.error(error);
    }).finally(() => {
      if (!homeFirstLoadedRef.current) {
        homeFirstLoadedRef.current = true;
      }
    });
  }

  useEffect(() => {
    if (!initialLoadComplete) return;
    profileStartup("startup-overlay:paint-wait", "Initial load complete; waiting for paint");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      profileStartup("startup-overlay:hidden", "Startup overlay hidden");
      setStartupDone(true);
      window.hynite.startup.signalReady({ mode: "app" });
    }));
  }, [initialLoadComplete]);

  useEffect(() => {
    if (!startupDone || startupSoundPlayedRef.current) {
      return;
    }
    startupSoundPlayedRef.current = true;
    // Delay matches the splash dismiss animation (300ms) so sound plays when the window appears
    const t = setTimeout(() => {
      soundEngine.play("startup");
      musicEngine.onStartupComplete();
    }, 310);
    return () => clearTimeout(t);
  }, [startupDone]);

  useEffect(() => {
    if (!initialLoadStartedRef.current) {
      initialLoadStartedRef.current = true;
      profileStartup("initial-load:start", "Initial renderer load started");
      const span = profileSpan("startup", "initial-load");
      void Promise.all([
        refresh(),
        window.hynite.sync.status().then((status) => {
          profileStartup("sync-status:initial", "Initial sync status loaded", { active: status.active, phase: status.phase });
          handledSyncSuccessAtRef.current = status.lastSuccessAt;
          setSyncStatus(status);
        })
      ])
        .catch((error: unknown) => {
          span.end("error", { error: error instanceof Error ? error.message : String(error) });
          profileStartup("initial-load:error", "Initial renderer load failed", { error: error instanceof Error ? error.message : String(error) });
          console.error(error);
        })
        .finally(() => {
          span.end("ok");
          profileStartup("initial-load:end", "Initial renderer load finished");
          setInitialLoadComplete(true);
        });
    }
    void window.hynite.updater.status().then(setUpdaterStatus).catch(() => undefined);
    const unsubscribeUpdater = window.hynite.updater.onStatusChanged(setUpdaterStatus);
    const unsubscribeSync = window.hynite.sync.onStatusChanged((status) => {
      const syncSpan = profileSpan("renderer-render", "renderer:sync-status-update", {
        active: status.active,
        phase: status.phase,
        backgroundActive: status.backgroundActive
      });
      profileStartup("sync-status:update", "Sync status update received", {
        active: status.active,
        phase: status.phase,
        backgroundActive: status.backgroundActive
      });
      setSyncStatus(status);
      if (!status.active && status.phase === "complete" && status.lastSuccessAt && handledSyncSuccessAtRef.current !== status.lastSuccessAt) {
        handledSyncSuccessAtRef.current = status.lastSuccessAt;
        void refresh();
      }
      syncSpan.end("ok");
    });
    const unsubscribeGameUpdated = window.hynite.games.onUpdated((game) => {
      const updateSpan = profileSpan("renderer-render", "renderer:game-update-apply", { id: game.id, title: game.title });
      profileStartup("game:update", "Game update received", { id: game.id, title: game.title });
      setGames((current) => current.map((item) => (item.id === game.id ? game : item)));
      setAllGames((current) => mergeRecentSortedGame(current, game));
      setRecentGames((current) => mergeRecentActivityGame(current, game));
      setLibraryGameIds((current) => new Set([...current, game.id]));
      setSelected((current) => (current?.id === game.id ? game : current));
      scheduleHomeRefresh({ retryIfStale: true, delayMs: HOME_STALE_RETRY_DELAY_MS });
      updateSpan.end("ok");
    });
    const unsubscribeHomeUpdated = window.hynite.home.onUpdated((nextHome) => {
      const token = ++homeApplyTokenRef.current;
      homeDebug("renderer update event received", {
        token,
        generatedAt: nextHome.generatedAt,
        stale: nextHome.stale,
        popularNow: nextHome.popularNow.length,
        heroTitles: nextHome.popularNow.slice(0, 5).map((game) => game.title)
      });
      homeRefreshRetryRef.current = 0;
      setHome(nextHome);
      trackHomeDiscoveryLoading(nextHome);
      if (!homeFirstLoadedRef.current) {
        homeFirstLoadedRef.current = true;
      }
    });
    return () => {
      if (homeRefreshTimerRef.current) {
        clearTimeout(homeRefreshTimerRef.current);
        homeRefreshTimerRef.current = undefined;
      }
      clearHomeDiscoveryLoadingTimer();
      if (homeIntentPrefetchTimerRef.current) {
        clearTimeout(homeIntentPrefetchTimerRef.current);
        homeIntentPrefetchTimerRef.current = undefined;
      }
      unsubscribeSync();
      unsubscribeGameUpdated();
      unsubscribeHomeUpdated();
      unsubscribeUpdater();
    };
  }, []);

  useEffect(() => {
    if (!libraryViewHydratedRef.current) return;
    const startedAt = performance.now();
    const effectiveLibraryView = activeLibraryView;
    profileStartup("library-filter:start", "Library filter query started", {
      query: activeQuery,
      sort: effectiveLibraryView.sort,
      filters: effectiveLibraryView.filters,
      groupId: activeGroup?.id
    });
    void window.hynite.library.list(libraryQueryForView(query, libraryView, activeGroup))
      .then((nextGames) => {
        profileStartup("library-filter:end", "Library filter query finished", {
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          games: nextGames.length
        });
        setGames(nextGames);
      })
      .catch((error: unknown) => {
        profileStartup("library-filter:error", "Library filter query failed", { error: error instanceof Error ? error.message : String(error) });
        console.error(error);
      });
  }, [query, libraryView, activeGroup, activeQuery, activeLibraryView]);

  // Persist filters/sort to settings (debounced) once hydration has happened.
  useEffect(() => {
    if (!libraryViewHydratedRef.current) return;
    if (librarySaveTimerRef.current) clearTimeout(librarySaveTimerRef.current);
    const nextLibraryView = normalizeLibraryView(libraryView);
    librarySaveTimerRef.current = setTimeout(() => {
      void window.hynite.settings.update({ libraryView: nextLibraryView }).catch((error: unknown) => {
        console.error("Failed to persist libraryView", error);
      });
    }, 300);
    return () => {
      if (librarySaveTimerRef.current) clearTimeout(librarySaveTimerRef.current);
    };
  }, [libraryView]);

  async function syncSteam() {
    setBusy(true);
    try {
      await window.hynite.library.sync("steam");
      await refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  }

  function openGameContextMenu(event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) {
    event.preventDefault();
    event.stopPropagation();
    const mouse = "clientX" in event && event.clientX > 0 && event.clientY > 0;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({
      game,
      x: mouse ? event.clientX : rect.left + Math.min(36, rect.width / 2),
      y: mouse ? event.clientY : rect.top + Math.min(36, rect.height / 2)
    });
  }

  async function persistGroups(nextGroups: GameGroup[]): Promise<AppSettings | undefined> {
    const next = await window.hynite.settings.update({ gameGroups: nextGroups });
    settingsRef.current = next;
    setSettings(next);
    return next;
  }

  function createSmartGroup(name: string) {
    const now = new Date().toISOString();
    const nextGroup: GameGroup = {
      id: makeGroupId("smart"),
      kind: "smart",
      name,
      search: activeQuery.trim() ? activeQuery : undefined,
      view: normalizeLibraryView(activeLibraryView),
      createdAt: now,
      updatedAt: now
    };
    void persistGroups([...normalizeGroups(settings), nextGroup]).then(() => {
      setActiveGroupId(nextGroup.id);
      setRoute("library");
    }).catch(console.error);
  }

  function requestSmartGroup(defaultName: string) {
    setNameDialog({
      title: "Create smart group",
      initialValue: defaultName,
      submitLabel: "Create",
      onSubmit: createSmartGroup
    });
  }

  function createManualGroupForGame(game: Game, name: string) {
    const now = new Date().toISOString();
    const nextGroup: GameGroup = {
      id: makeGroupId("manual"),
      kind: "manual",
      name,
      gameIds: [game.id],
      createdAt: now,
      updatedAt: now
    };
    void persistGroups([...normalizeGroups(settingsRef.current), nextGroup]).then(() => {
      setActiveGroupId(nextGroup.id);
      setRoute("library");
    }).catch(console.error);
  }

  function requestManualGroup(game: Game) {
    setNameDialog({
      title: "Create manual group",
      initialValue: game.title,
      submitLabel: "Create",
      onSubmit: (name) => createManualGroupForGame(game, name)
    });
  }

  function updateSmartGroup(group: GameGroup, patch: Partial<Extract<GameGroup, { kind: "smart" }>>) {
    if (group.kind !== "smart") {
      return;
    }
    const now = new Date().toISOString();
    const nextGroups = normalizeGroups(settings).map((item) =>
      item.id === group.id && item.kind === "smart" ? { ...item, ...patch, updatedAt: now } : item
    );
    void persistGroups(nextGroups).catch(console.error);
  }

  function setScopedQuery(next: string) {
    if (activeGroup?.kind === "smart") {
      updateSmartGroup(activeGroup, { search: next.trim() ? next : undefined });
    } else {
      setQuery(next);
    }
  }

  function setScopedLibraryView(next: LibraryView) {
    if (activeGroup?.kind === "smart") {
      updateSmartGroup(activeGroup, { view: normalizeLibraryView(next) });
    } else {
      setLibraryView(next);
    }
  }

  function renameGroup(group: GameGroup) {
    setNameDialog({
      title: "Rename group",
      initialValue: group.name,
      submitLabel: "Rename",
      onSubmit: (name) => {
        if (name === group.name) return;
        const now = new Date().toISOString();
        void persistGroups(normalizeGroups(settingsRef.current).map((item) => item.id === group.id ? { ...item, name, updatedAt: now } : item)).catch(console.error);
      }
    });
  }

  function deleteGroup(group: GameGroup) {
    const confirmed = window.confirm(`Delete "${group.name}"?`);
    if (!confirmed) {
      return;
    }
    void persistGroups(normalizeGroups(settings).filter((item) => item.id !== group.id)).then(() => {
      if (activeGroupId === group.id) {
        setActiveGroupId(undefined);
      }
    }).catch(console.error);
  }

  function hydrateHomeDetail(game: Game): Promise<GameDetail> {
    const cached = homeDetailCacheRef.current.get(game.id);
    if (cached) {
      return Promise.resolve(cached);
    }

    const inFlight = homeDetailPrefetchRef.current.get(game.id);
    if (inFlight) {
      return inFlight;
    }

    const startedAt = performance.now();
    const promise = (async () => {
      const detail = libraryGameIds.has(game.id)
        ? await window.hynite.games.get(game.id)
        : await window.hynite.games.hydrateDiscovery(game);
      homeDetailCacheRef.current.set(game.id, detail);
      homeDebug("detail prefetch loaded", {
        id: game.id,
        title: game.title,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        screenshots: detail.screenshots.length,
        hasTrailer: Boolean(detail.trailerUrl),
        hasAboutText: Boolean(detail.aboutText)
      });
      return detail;
    })().finally(() => {
      homeDetailPrefetchRef.current.delete(game.id);
    });

    homeDetailPrefetchRef.current.set(game.id, promise);
    return promise;
  }

  function scheduleHomeDetailPrefetch(game: Game): void {
    if (homeDetailCacheRef.current.has(game.id) || homeDetailPrefetchRef.current.has(game.id)) {
      return;
    }
    if (homeIntentPrefetchTimerRef.current) {
      clearTimeout(homeIntentPrefetchTimerRef.current);
    }
    homeIntentPrefetchTimerRef.current = setTimeout(() => {
      homeIntentPrefetchTimerRef.current = undefined;
      if (homeIntentPrefetchRunningRef.current || homeDetailCacheRef.current.has(game.id) || homeDetailPrefetchRef.current.has(game.id)) {
        return;
      }
      homeIntentPrefetchRunningRef.current = true;
      void hydrateHomeDetail(game)
        .catch((error) => {
          homeDebug("detail intent prefetch failed", {
            id: game.id,
            title: game.title,
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          homeIntentPrefetchRunningRef.current = false;
        });
    }, HOME_DETAIL_INTENT_PREFETCH_DELAY_MS);
  }

  async function selectGame(game: Game) {
    const span = profileSpan("renderer-render", "renderer:detail-open", { id: game.id, title: game.title });
    soundEngine.play("gameSelect");
    const cachedHomeDetail = homeDetailCacheRef.current.get(game.id);
    if (cachedHomeDetail) {
      console.log("[detail-skeleton] cache hit →", game.title);
      const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "home-detail-cache" });
      setSelected(cachedHomeDetail);
      applySpan.end("ok");
      span.end("ok", { id: game.id, title: game.title, source: "home-detail-cache" });
      return;
    }

    if (!libraryGameIds.has(game.id)) {
      const hasRichData = Boolean(game.shortDescription || game.aboutText || game.screenshots.length || game.trailerUrl);
      if (!hasRichData) {
        console.log("[detail-skeleton] discovery path, sparse → skeleton for", game.title);
        setSelectedPending(game);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        try {
          const detail = await hydrateHomeDetail(game);
          console.log("[detail-skeleton] discovery hydrated, showing overlay", game.title);
          detailFromSkeletonRef.current = true;
          setSelectedPending(undefined);
          setSelected(detail);
        } catch {
          detailFromSkeletonRef.current = true;
          setSelectedPending(undefined);
          const partialDetail = { ...game, sourceMatches: [] };
          setSelected(partialDetail);
          void window.hynite.sources.searchTitle(game.title, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT })
            .then((sourceMatches) => {
              const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "source-search" });
              setSelected((current) => (current?.id === game.id ? { ...game, sourceMatches } : current));
              applySpan.end("ok");
            })
            .catch(console.error);
        }
        span.end("ok", { id: game.id, title: game.title, source: "discovery", hydrationDeferred: false });
        return;
      }

      console.log("[detail-skeleton] discovery path, rich data →", game.title);
      const partialDetail = { ...game, sourceMatches: [] };
      const applyPartialSpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "discovery-partial" });
      setSelected(partialDetail);
      applyPartialSpan.end("ok", { partial: true });
      span.end("ok", { id: game.id, title: game.title, source: "discovery-partial", hydrationDeferred: true });
      void hydrateHomeDetail(game)
        .then((detail) => {
          const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "discovery" });
          setSelected((current) => (current?.id === game.id ? detail : current));
          applySpan.end("ok");
        })
        .catch(() => {
          void window.hynite.sources.searchTitle(game.title, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT })
            .then((sourceMatches) => {
              const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "source-search" });
              setSelected((current) => (current?.id === game.id ? { ...game, sourceMatches } : current));
              applySpan.end("ok");
            })
            .catch((error) => {
              console.error(error);
            });
        });
      return;
    }

    console.log("[detail-skeleton] library path → showing skeleton for", game.title);
    setSelectedPending(game);
    // Yield back to the event handler so React flushes the batch and paints the skeleton
    // before starting the IPC call. Without this, React batches pending+resolved together.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    try {
      const ipcSpan = profileSpan("renderer-render", "renderer:detail-open:games-get", { id: game.id, title: game.title });
      console.log("[detail-skeleton] ipc start", game.title);
      const detail = await window.hynite.games.get(game.id);
      ipcSpan.end("ok", {
        id: game.id,
        title: game.title,
        screenshots: detail.screenshots.length,
        sourceMatches: detail.sourceMatches?.length ?? 0,
        hasTrailer: Boolean(detail.trailerUrl),
        hasAboutText: Boolean(detail.aboutText)
      });
      const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "library" });
      homeDetailCacheRef.current.set(game.id, detail);
      console.log("[detail-skeleton] ipc done, showing overlay", game.title);
      detailFromSkeletonRef.current = true;
      setSelectedPending(undefined);
      setSelected(detail);
      applySpan.end("ok");
      span.end("ok", { id: game.id, title: game.title, source: "library" });
    } catch {
      try {
        const sourceSpan = profileSpan("renderer-render", "renderer:detail-open:source-search", { id: game.id, title: game.title });
        const sourceMatches = await window.hynite.sources.searchTitle(game.title, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT });
        sourceSpan.end("ok", { id: game.id, title: game.title, sourceMatches: sourceMatches.length });
        const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "source-search" });
        detailFromSkeletonRef.current = true;
        setSelectedPending(undefined);
        setSelected({ ...game, sourceMatches });
        applySpan.end("ok");
        span.end("ok", { id: game.id, title: game.title, source: "source-search" });
      } catch (error) {
        setSelectedPending(undefined);
        span.end("error", { id: game.id, title: game.title, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
  }

  useEffect(() => {
    const handleAction = (action: { kind: "details" | "launch"; gameId: string } | undefined) => {
      if (!action) return;
      if (action.kind === "launch") {
        void launchGame(action.gameId).catch(console.error);
        return;
      }
      void window.hynite.games.get(action.gameId)
        .then((game) => selectGame(game))
        .catch(console.error);
    };

    void window.hynite.spotlight.consumePendingAction().then(handleAction).catch(console.error);
    const unsubscribeDetails = window.hynite.games.onOpenDetailsRequested((gameId) => handleAction({ kind: "details", gameId }));
    const unsubscribeLaunch = window.hynite.games.onLaunchRequested((gameId) => handleAction({ kind: "launch", gameId }));
    return () => {
      unsubscribeDetails();
      unsubscribeLaunch();
    };
  }, []);

  function selectWishlistItem(item: SteamWishlistItem) {
    const libraryGame = allGamesRef.current.find((game) => game.id === `steam:${item.appid}`) ?? gamesRef.current.find((game) => game.id === `steam:${item.appid}`);
    if (libraryGame) {
      void selectGame(libraryGame);
      return;
    }
    void selectGame({
      id: `steam:${item.appid}`,
      title: item.title,
      sortTitle: item.sortTitle,
      sourceIds: [{ provider: "steam", externalId: item.appid }],
      installState: "unknown",
      coverUrl: item.coverUrl,
      libraryCapsuleUrl: item.libraryCapsuleUrl,
      headerUrl: item.headerUrl,
      backgroundUrl: item.backgroundUrl,
      logoUrl: item.logoUrl,
      communityIconUrl: item.communityIconUrl,
      screenshots: [],
      genres: [],
      tags: [],
      playerModes: [],
      developers: [],
      publishers: [],
      contentDescriptors: [],
      releaseDate: item.releaseDate,
      metadataStatus: item.metadataStatus
    });
  }

  async function setCardsPerRow(value: number) {
    setSettings(await window.hynite.settings.update({ cardsPerRow: normalizeCardsPerRow(value) }));
  }

  const homeNeedsWishlist = useMemo(() => {
    const layout = settings?.home ?? defaultHomeLayout;
    return layout.modules.some((module) => module.source.kind === "wishlist" || module.source.kind === "wishlistUpcoming");
  }, [settings?.home]);

  useEffect(() => {
    if (!homeNeedsWishlist) {
      setHomeWishlistItems([]);
      return;
    }
    let cancelled = false;
    void window.hynite.wishlist.list({})
      .then((items) => { if (!cancelled) setHomeWishlistItems(items); })
      .catch((error) => console.error("Failed to load wishlist for home", error));
    return () => { cancelled = true; };
  }, [homeNeedsWishlist]);

  async function persistHomeLayout(next: HomeLayout) {
    setSettings((current) => current ? { ...current, home: next } : current);
    try {
      const updated = await window.hynite.settings.update({ home: next });
      setSettings(updated);
    } catch (error) {
      console.error("Failed to persist home layout", error);
    }
  }

  const routeContent = useMemo(() => {
    if (route === "home") {
      return <HomeScreen home={home} settings={settings} libraryGames={allGames} libraryGameIds={libraryGameIds} wishlistItems={homeWishlistItems} groups={settings?.gameGroups ?? []} onSelect={(game) => void selectGame(game)} onOpenSettings={() => setRoute("settings")} onGameContextMenu={openGameContextMenu} onGameIntent={scheduleHomeDetailPrefetch} onLayoutChange={(next) => void persistHomeLayout(next)} discoveryLoading={homeDiscoveryLoading} />;
    }
    if (route === "steam") {
      return <SteamStoreScreen settings={settings} onSettingsChanged={setSettings} onOpenSettings={() => setRoute("settings")} />;
    }
    if (route === "library") {
      return (
        <ProfileScope id="LibraryScreen">
          <LibraryScreen
            games={games}
            facetGames={allGames.length > 0 ? allGames : games}
            query={activeQuery}
            setQuery={setScopedQuery}
            view={activeLibraryView}
            setView={setScopedLibraryView}
            activeGroup={activeGroup}
            onSelect={(game) => void selectGame(game)}
            onGameContextMenu={openGameContextMenu}
            onCreateSmartGroup={requestSmartGroup}
            onRenameGroup={renameGroup}
            onDeleteGroup={deleteGroup}
            onOpenSettings={() => setRoute("settings")}
            cardsPerRow={cardsPerRow}
          />
        </ProfileScope>
      );
    }
    if (route === "wishlist") {
      return (
        <ProfileScope id="WishlistScreen">
          <WishlistScreen
            settings={settings}
            onSelect={selectWishlistItem}
            onOpenSettings={() => setRoute("settings")}
            onCountChanged={setWishlistCount}
            cardsPerRow={cardsPerRow}
          />
        </ProfileScope>
      );
    }
    if (route === "search") {
      return <SteamSearchScreen onSelect={(result) => void selectGame(gameFromSteamSearchResult(result))} />;
    }
    if (route === "local") {
      if (!settings) return null;
      const localGames = allGames.filter((game) => game.sourceIds.some((source) => source.provider === "local"));
      return (
        <LocalGamesScreen
          settings={settings}
          setSettings={setSettings}
          localGames={localGames}
          onGameSelected={(game) => void selectGame(game)}
          onLibraryRefresh={() => void refresh()}
          onIssueCountChange={setLocalIssueCount}
        />
      );
    }
    return (
      <SettingsScreen
        settings={settings}
        setSettings={setSettings}
        syncStatus={syncStatus}
        syncBusy={busy || Boolean(syncStatus?.active)}
        onSync={() => void syncSteam()}
        onLibraryCleared={() => {
          setSelected(undefined);
          void refresh();
        }}
        onSeed={() => void window.hynite.debug.seed().then(() => refresh())}
      />
    );
  }, [route, home, homeDiscoveryLoading, games, allGames, activeQuery, settings, syncStatus, libraryGameIds, activeLibraryView, activeGroup, busy, cardsPerRow, wishlistCount]);

  // Dev helpers — available in the browser console:
  //   window.__fakeUpdate()       shows "Update available", click the button to simulate download
  //   window.__clearFakeUpdate()  resets back to real updater state
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__fakeUpdate = () => {
      const fakeVersion = "99.0.0";
      const base: UpdaterStatus = { phase: "available", supported: true, currentVersion: "0.0.0", availableVersion: fakeVersion };
      setFakeUpdaterStatus(base);
      fakeDownloadRef.current = () => {
        let pct = 0;
        const tick = setInterval(() => {
          pct = Math.min(pct + 2, 100);
          setFakeUpdaterStatus({ ...base, phase: "downloading", percent: pct });
          if (pct >= 100) {
            clearInterval(tick);
            setFakeUpdaterStatus({ ...base, phase: "downloaded" });
          }
        }, 80);
      };
    };
    (window as unknown as Record<string, unknown>).__clearFakeUpdate = () => {
      setFakeUpdaterStatus(undefined);
      fakeDownloadRef.current = undefined;
    };
    console.log("%c[Hynite dev]%c  __fakeUpdate() · __clearFakeUpdate()", "color:#a78bfa;font-weight:700", "color:#888");
    return () => {
      delete (window as unknown as Record<string, unknown>).__fakeUpdate;
      delete (window as unknown as Record<string, unknown>).__clearFakeUpdate;
    };
  }, []);

  return (
    <>
    <div className="app-shell">
      <TitleBar onEnterBigPicture={() => setBigPicture(true)} />
      <div className="app-body">
        <aside className="rail">
          <div className="rail-brand">
            <BrandLogo className="rail-logo" sizes="38px" />
          </div>
          {routes.map((item) => {
            const Icon = item.icon;
            const isLibrary = item.id === "library";
            const isActive = route === item.id && !(isLibrary && Boolean(activeGroupId));
            return (
              <button
                key={item.id}
                className={isActive ? "active" : ""}
                onClick={() => {
                  if (item.id === "library") {
                    setActiveGroupId(undefined);
                  }
                  setRoute(item.id);
                }}
              >
                <Icon size={17} />
                <span className="rail-label">{item.label}</span>
                {isLibrary ? <span className="rail-count-pill">{allGames.length}</span> : null}
                {item.id === "wishlist" ? <span className="rail-count-pill">{wishlistCount}</span> : null}
                {item.id === "local" && localIssueCount > 0 ? (
                  <span className="rail-issue-badge" title={`${localIssueCount} item${localIssueCount === 1 ? "" : "s"} need review`}>
                    {localIssueCount}
                  </span>
                ) : null}
              </button>
            );
          })}
          <UpdaterPill
            status={fakeUpdaterStatus ?? updaterStatus}
            onDownload={fakeUpdaterStatus ? () => fakeDownloadRef.current?.() : undefined}
            onInstall={fakeUpdaterStatus ? () => { setFakeUpdaterStatus(undefined); fakeDownloadRef.current = undefined; } : undefined}
          />
          <div className={groups.length > 0 ? "rail-lists has-groups" : "rail-lists"}>
            {groups.length > 0 ? (
              <div className="rail-section rail-groups-section">
                <p>
                  <span className="rail-label">Groups</span>
                </p>
                <div className="group-list">
                  {groups.map((group) => {
                    return (
                      <button
                        key={group.id}
                        type="button"
                        className={activeGroupId === group.id && route === "library" ? "group-link active" : "group-link"}
                        onClick={() => {
                          setActiveGroupId(group.id);
                          setRoute("library");
                        }}
                      >
                        <Folder size={14} />
                        <span className="rail-label group-copy">
                          <strong>{group.name}</strong>
                        </span>
                        <span className="rail-count-pill">{groupCounts.get(group.id) ?? 0}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="rail-section rail-recents-section">
              <p>
                <span className="rail-label">Recent</span>
              </p>
              <div className="recent-list">
                {recentGames.slice(0, 30).map((game) => (
                  <RecentGameItem
                    key={game.id}
                    game={game}
                    onAction={(g) => (canLaunch(g) ? void launchGame(g) : void selectGame(g))}
                    onSelect={(g) => void selectGame(g)}
                    onContextMenu={(event, g) => openGameContextMenu(event, g)}
                  />
                ))}
              </div>
            </div>
          </div>
        </aside>
        <section className="content" ref={contentRef}>
          <AnimatePresence mode="wait">
            <motion.div
              key={route}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {routeContent}
            </motion.div>
          </AnimatePresence>
        </section>
        <AnimatePresence>
          {selected ? (
            <DetailOverlay
              key={`detail-${selected.id}`}
              game={selected}
              settings={settings}
              onSettingsChanged={setSettings}
              reduceMotion={settings?.reduceMotion}
              fromSkeleton={detailFromSkeletonRef.current}
              onFromSkeletonHandled={() => { detailFromSkeletonRef.current = false; }}
              onClose={() => setSelected(undefined)}
              onGameUpdated={setSelected}
              onChanged={() => void refresh()}
            />
          ) : selectedPending ? (
            <DetailOverlaySkeleton
              key={`skeleton-${selectedPending.id}`}
              game={selectedPending}
              onClose={() => setSelectedPending(undefined)}
            />
          ) : null}
        </AnimatePresence>
        <GameContextMenu
          request={contextMenu}
          settings={settings}
          activeGroup={activeGroup}
          onClose={() => setContextMenu(undefined)}
          onSelect={(game) => void selectGame(game)}
          onSettingsChanged={(next) => {
            settingsRef.current = next;
            setSettings(next);
          }}
          onCreateManualGroup={requestManualGroup}
          onChanged={() => void refresh()}
        />
        {nameDialog ? <NameDialog state={nameDialog} onClose={() => setNameDialog(undefined)} /> : null}
        {switchPrompt ? <SteamSwitchModal prompt={switchPrompt} /> : null}
        {launchFailurePrompt ? (
          <LaunchFailureModal
            failure={launchFailurePrompt}
            onClose={() => setLaunchFailurePrompt(undefined)}
            onReport={reportCurrentLaunchFailure}
          />
        ) : null}
        {settingsHealthWarning ? (
          <SettingsResetWarningModal warning={settingsHealthWarning} onClose={() => setSettingsHealthWarning(undefined)} />
        ) : null}
      </div>
      <footer className="statusbar">
        <span className="status-dot" />
        <span>{games.length} games</span>
        <span>{home?.stale ? "cached discovery" : "online discovery"}</span>
        <label className="status-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={MIN_CARDS_PER_ROW}
            max={MAX_CARDS_PER_ROW}
            step={1}
            value={cardsPerRow}
            style={zoomSliderStyle(cardsPerRow)}
            onChange={(event) => void setCardsPerRow(Number(event.currentTarget.value))}
          />
          <strong>{cardsPerRow}</strong>
        </label>
        <span>v0.1.0</span>
        {musicStatus.settingsEnabled && musicStatus.hasTracks && musicStatus.active && musicStatus.pauseReason && (
          <span className="music-pause-chip">
            <Music2 size={10} />
            {musicStatus.pauseReason}
          </span>
        )}
        {musicStatus.settingsEnabled && musicStatus.hasTracks && musicStatus.active && musicStatus.currentTrackTitle ? (
          <CurrentTrackCredit status={musicStatus} />
        ) : null}
      </footer>
    </div>
    {!startupDone && (
      <div className="startup-overlay">
        <StartupLoading />
      </div>
    )}
    <AnimatePresence>
      {launchHandoff ? <LaunchHandoffOverlay key={launchHandoff.token} state={launchHandoff} /> : null}
    </AnimatePresence>
    <AnimatePresence>
      {bigPicture ? (
        <motion.div
          key="big-picture-overlay"
          className="big-picture-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          <ProfileScope id="BigPictureScreen">
            <BigPictureScreen
              games={bpSortedAll.length > 0 ? bpSortedAll : games}
              recentGames={recentGames}
              settings={settings}
              groupGames={bigPictureGroupGames}
              activeFilterCount={countActiveFilters(bpFilters)}
              onOpenFilters={() => setBpFiltersOpen(true)}
              onLaunch={(game) => void launchGame(game)}
              onSelect={(game) => void selectGame(game)}
              onBack={() => {
                if (bpFiltersOpen) {
                  setBpFiltersOpen(false);
                  return true;
                }
                if (contextMenu) {
                  setContextMenu(undefined);
                  return true;
                }
                if (nameDialog) {
                  setNameDialog(undefined);
                  return true;
                }
                if (selectedRef.current) {
                  setSelected(undefined);
                  return true;
                }
                return false;
              }}
              onExit={() => setBigPicture(false)}
              defaultTabId={settings?.bigPictureDefaultTabId}
              onSetDefaultTab={(tabId) => {
                void window.hynite.settings.update({ bigPictureDefaultTabId: tabId ?? undefined }).then(setSettings).catch(console.error);
              }}
              detailOpen={Boolean(selected)}
              filterOpen={bpFiltersOpen}
            />
          </ProfileScope>
          <LibraryFiltersPanel
            open={bpFiltersOpen}
            onClose={() => setBpFiltersOpen(false)}
            filters={bpFilters}
            onChange={setBpFilters}
            onReset={() => setBpFilters({})}
            facets={bpFacets}
            query=""
            onRequestSmartGroup={() => undefined}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
    </>
  );
}

export function App() {
  const [onboardingState, setOnboardingState] = useState<OnboardingState | undefined>();
  const [previewFinished, setPreviewFinished] = useState(false);

  useEffect(() => {
    void window.hynite.onboarding.state()
      .then(setOnboardingState)
      .catch((error: unknown) => {
        console.error("Failed to load onboarding state", error);
        setOnboardingState({ shouldShow: false, firstRun: false, preview: false });
      });
  }, []);

  if (!onboardingState) {
    return (
      <div className="startup-overlay">
        <StartupLoading />
      </div>
    );
  }

  if (onboardingState.preview && previewFinished) {
    return (
      <div className="onboarding-shell">
        <div className="onboarding-preview-complete">
          <strong>Preview complete</strong>
          <span>No settings, sources, library rows, caches, sync state, or background jobs were changed.</span>
          <button className="primary-action" type="button" onClick={() => setPreviewFinished(false)}>
            Replay onboarding
          </button>
        </div>
      </div>
    );
  }

  if (onboardingState.shouldShow) {
    return (
      <OnboardingExperience
        state={onboardingState}
        onFinished={(_settings, skipped) => {
          if (onboardingState.preview) {
            setPreviewFinished(true);
            return;
          }
          setOnboardingState({
            ...onboardingState,
            shouldShow: false,
            completedAt: new Date().toISOString()
          });
          void skipped;
        }}
      />
    );
  }

  return <LauncherShell />;
}
