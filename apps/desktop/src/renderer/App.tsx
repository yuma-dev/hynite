import { AnimatePresence, motion } from "framer-motion";
import Hls from "hls.js";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
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
  Flame,
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
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  TrendingUp,
  Trophy,
  Tv,
  Users,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { defaultLibraryView, gameActivityTime, makeGameId, makeSortTitle, resolveLaunchableSteamAccounts, type AppSettings, type ControllerActionId, type ControllerButtonBinding, type ControllerSettings, type DownloadSourceInfo, type Game, type GameAssetCandidate, type GameAssetKind, type GameAssetProvider, type GameAssetUpdate, type GameDetail, type GameGroup, type HomeModel, type HomeTrendRow, type InstallState, type LibraryDateFilter, type LibraryFilters, type LibraryOwnership, type LibrarySortField, type LibrarySortDirection, type LibraryView, type ManualGameGroup, type MusicSettings, type PlayerMode, type ProviderId, type SoundEffectId, type SoundEffectPlayback, type SoundEffectSettings, type SoundSettings, type SourceExactMatch, type SourceImportResult, type SourceMatch, type SteamAccountSettings, type SteamLocalAccount, type SteamSearchResult, type SyncStatus } from "@hynite/core";
import { profileImageError, profileImageStart, profileSpan, profileStartup } from "./startupProfile";
import { LocalGamesScreen } from "./LocalGamesScreen";
import { BigPictureScreen } from "./BigPictureScreen";
import { normalizeSoundSettings, soundEngine, SOUND_EFFECT_DEFINITIONS } from "./sound";
import { musicEngine, normalizeMusicSettings, type MusicStatus } from "./music";
import { bindingLabel, bindingPressed, controllerBindingOrder, CONTROLLER_ACTION_HELP, CONTROLLER_ACTION_LABELS, firstPressedBinding, normalizeControllerSettings, pressedButtonIndexes, readGamepadState } from "./controllerInput";

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

const STEAM_SWITCH_CONFIRM_EVENT = "hynite:steam-switch-confirm";
const LAUNCH_GAME_EVENT = "hynite:launch-game";
const TRAILER_AUDIO_STORAGE_KEY = "hynite:trailer-audio:v1";
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

function requestSteamSwitchConfirmation(prompt: Omit<SteamSwitchPrompt, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    const detail = { ...prompt, handled: false, resolve };
    window.dispatchEvent(new CustomEvent(STEAM_SWITCH_CONFIRM_EVENT, { detail }));
    if (!detail.handled) {
      resolve(false);
    }
  });
}

async function runLaunchFlow(id: string, preferredSteamId?: string): Promise<boolean> {
  const result = await window.hynite.games.launch(id, preferredSteamId);
  if (result.kind === "launched") {
    soundEngine.play("gameLaunch");
    musicEngine.onGameLaunch();
    return true;
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
    const switchResult = await window.hynite.steam.switchAndLaunch(result.gameId, result.target.steamId);
    if (switchResult.kind === "launched") {
      soundEngine.play("gameLaunch");
      musicEngine.onGameLaunch();
      return true;
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

type Route = "home" | "trending" | "library" | "search" | "local" | "settings";

const routes: Array<{ id: Route; label: string; icon: typeof Home }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "trending", label: "Trending", icon: Flame },
  { id: "library", label: "Library", icon: Library },
  { id: "search", label: "Search", icon: Search },
  { id: "local", label: "Add games", icon: Plus },
  { id: "settings", label: "Settings", icon: Settings }
];

const HERO_AUTOPLAY_MS = 9000;
const HOME_ROW_BATCH_SIZE = 12;
const HOME_ROW_STEP_ITEMS = 3;
const LIBRARY_GRID_BATCH_SIZE = 72;
const DEFAULT_CARDS_PER_ROW = 8;
const MIN_CARDS_PER_ROW = 4;
const MAX_CARDS_PER_ROW = 12;
const DOWNLOAD_MATCH_BATCH_SIZE = 20;
const DOWNLOAD_MATCH_SEARCH_LIMIT = 500;
const APP_ASSET_BASE_URL = import.meta.env.BASE_URL;
const sourceAvailabilityCache = new Map<string, SourceExactMatch[]>();

function appAsset(name: string): string {
  return `${APP_ASSET_BASE_URL}${name}`;
}

function BrandLogo({ className, sizes }: { className?: string; sizes: string }) {
  return (
    <img
      className={className}
      src={appAsset("logo-128.png")}
      srcSet={`${appAsset("logo-64.png")} 64w, ${appAsset("logo-128.png")} 128w, ${appAsset("logo-256.png")} 256w`}
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

function primaryCover(game: Game): string | undefined {
  return game.libraryCapsuleUrl ?? (isVerifiedVerticalCoverUrl(game.coverUrl) ? game.coverUrl : undefined);
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

function formatNumber(value?: number): string {
  return value === undefined ? "Unknown" : value.toLocaleString();
}

function formatCompactNumber(value?: number): string | undefined {
  if (!value) {
    return undefined;
  }

  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
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

function GameCover({
  game,
  onSelect,
  onContextMenu,
  wide = false,
  inLibrary = true
}: {
  game: Game;
  onSelect: (game: Game) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
  wide?: boolean;
  inLibrary?: boolean;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const cover = primaryCover(game);
  const coverProfileRef = useRef<ReturnType<typeof profileImageStart> | undefined>();
  const logoProfileRef = useRef<ReturnType<typeof profileImageStart> | undefined>();
  const isInstalled = game.installState === "installed";
  const launchable = canLaunch(game);
  const playtimeLabel = formatHours(game.playtimeMinutes);
  const familyShared = isFamilySharedOnly(game);
  const familyOwnersTooltip = familyShared
    ? `Shared by Steam Family${familySharedOwners(game).length > 0 ? `: ${familySharedOwners(game).join(", ")}` : ""}`
    : undefined;

  useEffect(() => {
    if (!cover) return undefined;
    const span = profileImageStart(cover, { role: "cover", gameId: game.id, title: game.title, lazy: true });
    coverProfileRef.current = span;
    return () => {
      if (coverProfileRef.current === span) {
        span.end("cancelled", { role: "cover", gameId: game.id, title: game.title });
        coverProfileRef.current = undefined;
      }
    };
  }, [cover, game.id, game.title]);

  useEffect(() => {
    if (!game.logoUrl) return undefined;
    const span = profileImageStart(game.logoUrl, { role: "logo", gameId: game.id, title: game.title, lazy: true });
    logoProfileRef.current = span;
    return () => {
      if (logoProfileRef.current === span) {
        span.end("cancelled", { role: "logo", gameId: game.id, title: game.title });
        logoProfileRef.current = undefined;
      }
    };
  }, [game.logoUrl, game.id, game.title]);

  return (
    <div
      className={wide ? "wide-game" : "game-cover"}
      style={fallbackArt(game)}
      data-cover-src={cover ?? ""}
      role="button"
      tabIndex={0}
      aria-label={game.title}
      onClick={() => onSelect(game)}
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
            className={imgLoaded ? "cover-img loaded" : "cover-img"}
            src={cover}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              setImgLoaded(true);
              coverProfileRef.current?.end("ok", {
                role: "cover",
                gameId: game.id,
                title: game.title,
                naturalWidth: event.currentTarget.naturalWidth,
                naturalHeight: event.currentTarget.naturalHeight,
                lazy: true
              });
              coverProfileRef.current = undefined;
            }}
            onError={() => {
              profileImageError(cover, { role: "cover", gameId: game.id, title: game.title, lazy: true });
              coverProfileRef.current?.end("error", { role: "cover", gameId: game.id, title: game.title });
              coverProfileRef.current = undefined;
            }}
          />
        ) : null}
        <span className="cover-reveal">
          <span className="cover-logo">
            {game.logoUrl ? (
              <img
                className="cover-logo-img"
                src={game.logoUrl}
                alt={game.title}
                loading="lazy"
                decoding="async"
                onLoad={(event) => {
                  logoProfileRef.current?.end("ok", {
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
                    profileImageError(game.logoUrl, { role: "logo", gameId: game.id, title: game.title, lazy: true });
                  }
                  logoProfileRef.current?.end("error", { role: "logo", gameId: game.id, title: game.title });
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
          <span className="cover-playtime">{playtimeLabel}</span>
        </span>
      </span>
      {familyShared ? (
        <span className="cover-family-badge" title={familyOwnersTooltip}>
          Family
        </span>
      ) : null}
    </div>
  );
}

function GameRow({
  title,
  description,
  games,
  cardsPerRow,
  onSelect,
  onGameContextMenu
}: {
  title: string;
  description?: string;
  games: Game[];
  cardsPerRow: number;
  onSelect: (game: Game) => void;
  onGameContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
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
          {visibleGames.map((game) => (
            <GameCover key={game.id} game={game} onSelect={onSelect} onContextMenu={onGameContextMenu} />
          ))}
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
  onOpenSettings
}: {
  home?: HomeModel;
  settings?: AppSettings;
  libraryGameIds: Set<string>;
  onSelect: (game: Game) => void;
  onOpenSettings: () => void;
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
      onPointerEnter={() => setHeroPaused(true)}
      onPointerLeave={() => setHeroPaused(false)}
      onFocus={() => setHeroPaused(true)}
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
      ) : (
        <div className="hero-empty">
          <h1 className="hero-logo-title">
            <BrandLogo className="hero-logo" sizes="clamp(72px, 8vw, 104px)" />
          </h1>
          <p>Pair Steam to build the first library view.</p>
          <button className="primary-action" onClick={onOpenSettings}>
            <Settings size={16} />
            Open settings
          </button>
        </div>
      )}
    </section>
  );
}

function HomeScreen({
  home,
  settings,
  libraryGameIds,
  onSelect,
  onOpenSettings,
  onGameContextMenu
}: {
  home?: HomeModel;
  settings?: AppSettings;
  libraryGameIds: Set<string>;
  onSelect: (game: Game) => void;
  onOpenSettings: () => void;
  onGameContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
}) {
  const cardsPerRow = normalizeCardsPerRow(settings?.cardsPerRow);
  return (
    <main className="page">
      <Hero home={home} settings={settings} libraryGameIds={libraryGameIds} onSelect={onSelect} onOpenSettings={onOpenSettings} />
      <GameRow title="Recently played" games={home?.continuePlaying ?? []} cardsPerRow={cardsPerRow} onSelect={onSelect} onGameContextMenu={onGameContextMenu} />
      <GameRow title="Most played" games={home?.mostPlayed ?? []} cardsPerRow={cardsPerRow} onSelect={onSelect} onGameContextMenu={onGameContextMenu} />
    </main>
  );
}

function trendSummary(game: Game): string {
  return game.shortDescription || [game.genres[0], game.developers[0], game.releaseDate ? `Released ${formatDate(game.releaseDate)}` : undefined].filter(Boolean).join(" · ") || "Steam trend signal";
}

function trendStats(game: Game): string[] {
  const reviewPercent = game.discovery?.reviewScore ? `${Math.round(game.discovery.reviewScore * 100)}% review signal` : undefined;
  return [
    game.discovery?.ccu ? `${formatCompactNumber(game.discovery.ccu)} peak players` : undefined,
    game.discovery?.owners ? `${game.discovery.owners} owners` : undefined,
    reviewPercent,
    game.discovery?.discountPercent ? `-${game.discovery.discountPercent}%` : undefined,
    game.discovery?.priceText,
    game.discovery?.storeCategory
  ].filter(Boolean) as string[];
}

function scrollToTrendRow(row: HomeTrendRow) {
  document.getElementById(`trend-row-${row.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function TrendingScreen({
  home,
  settings,
  libraryGameIds,
  onSelect,
  onGameContextMenu
}: {
  home?: HomeModel;
  settings?: AppSettings;
  libraryGameIds: Set<string>;
  onSelect: (game: Game) => void;
  onGameContextMenu?: (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, game: Game) => void;
}) {
  const rows = home?.trendingRows ?? [];
  const spotlight = rows.find((row) => row.games.length > 0)?.games[0] ?? home?.popularNow[0];
  const spotlightImage = spotlight ? heroStill(spotlight) : undefined;
  const reduceMotion = Boolean(settings?.reduceMotion);

  if (!spotlight || rows.length === 0) {
    return (
      <main className="page">
        <div className="empty-state">
          <TrendingUp size={34} />
          <h2>No trend data yet</h2>
          <p>Discovery will appear when the Steam and SteamSpy endpoints respond.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page trending-page">
      <section className="trend-hero">
        <div className="hero-media">
          <motion.span
            style={spotlightImage ? { backgroundImage: `url(${spotlightImage})` } : undefined}
            initial={reduceMotion ? false : { opacity: 0, scale: 1.03 }}
            animate={{ opacity: 0.74, scale: 1.08 }}
            transition={{ duration: reduceMotion ? 0 : 0.36, ease: "easeOut" }}
          />
        </div>
        <div className="hero-shade" />
        <motion.button
          className="trend-hero-frame"
          style={fallbackArt(spotlight)}
          onClick={() => onSelect(spotlight)}
          initial={reduceMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.24, ease: "easeOut" }}
        >
          <span style={spotlightImage ? { backgroundImage: `url(${spotlightImage})` } : undefined} />
        </motion.button>
        <motion.div className="trend-copy" initial={reduceMotion ? false : { opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduceMotion ? 0 : 0.24, ease: "easeOut" }}>
          <span className="trend-kicker">
            <TrendingUp size={15} />
            {spotlight.discovery?.signal ?? "Trending"}
          </span>
          <h1>{spotlight.title}</h1>
          <p>{trendSummary(spotlight)}</p>
          <SourceAvailabilityTag game={spotlight} libraryGameIds={libraryGameIds} />
          <div className="trend-stat-list">
            {trendStats(spotlight).slice(0, 5).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <div className="hero-actions">
            <button className="secondary-action" onClick={() => onSelect(spotlight)}>
              <BookOpen size={16} />
              Info
            </button>
            {spotlight.discovery?.storeUrl ? (
              <button className="secondary-action" onClick={() => openExternalUrl(spotlight.discovery?.storeUrl)}>
                <ExternalLink size={16} />
                {spotlight.discovery?.priceText ?? "Store"}
              </button>
            ) : null}
          </div>
        </motion.div>
      </section>
      <nav className="trend-tabs" aria-label="Trending categories">
        {rows.map((row) => (
          <button key={row.id} type="button" onClick={() => scrollToTrendRow(row)}>
            <span>{row.title}</span>
            <em>{row.games.length}</em>
          </button>
        ))}
      </nav>
      <div className="trend-rows">
        {rows.map((row) => (
          <div key={row.id} id={`trend-row-${row.id}`} className="trend-row-anchor">
            <GameRow title={row.title} description={row.description} games={row.games} cardsPerRow={normalizeCardsPerRow(settings?.cardsPerRow)} onSelect={onSelect} onGameContextMenu={onGameContextMenu} />
          </div>
        ))}
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
        cmp = (Date.parse(a.lastPlayedAt ?? a.addedAt ?? "") || 0) - (Date.parse(b.lastPlayedAt ?? b.addedAt ?? "") || 0);
        break;
    }
    if (cmp === 0) cmp = a.title.localeCompare(b.title);
    return cmp * dir;
  });
  return sorted;
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
  const [visibleCount, setVisibleCount] = useState(LIBRARY_GRID_BATCH_SIZE);
  const normalizedCardsPerRow = normalizeCardsPerRow(cardsPerRow);

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
  const visibleGames = games.slice(0, visibleCount);
  const hasMoreGames = visibleCount < games.length;

  useEffect(() => {
    setVisibleCount(LIBRARY_GRID_BATCH_SIZE);
  }, [games]);

  useEffect(() => {
    if (!hasMoreGames) return undefined;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleCount((current) => Math.min(games.length, current + LIBRARY_GRID_BATCH_SIZE));
      }
    }, { rootMargin: "720px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [games.length, hasMoreGames]);

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
          <div className="library-grid" ref={gridRef} style={cardGridStyle(normalizedCardsPerRow)} onPointerOver={spotlight.onPointerOver} onPointerLeave={spotlight.onPointerLeave}>
            {visibleGames.map((game) => (
              <GameCover key={game.id} game={game} onSelect={onSelect} onContextMenu={onGameContextMenu} />
            ))}
          </div>
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

type SettingsTab = "steam" | "metadata" | "sources" | "audio" | "view" | "controller" | "advanced";

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
  const [steamMessage, setSteamMessage] = useState<string | undefined>();
  const [metadataMessage, setMetadataMessage] = useState<string | undefined>();
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

  async function clearLibrary() {
    const result = await window.hynite.library.clear();
    onLibraryCleared();
    setSteamMessage(`Cleared ${result.cleared} games from the local library.`);
  }

  async function setAutoHideAfterLaunch(value: boolean) {
    const next = await window.hynite.settings.update({ autoHideAfterLaunch: value });
    setSettings(next);
  }

  async function setCardsPerRow(value: number) {
    const next = await window.hynite.settings.update({ cardsPerRow: normalizeCardsPerRow(value) });
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
                    disabled={musicSettings.startupDelayEnabled === false}
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
                </div>
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
  const [selectedUrls, setSelectedUrls] = useState<Record<GameAssetKind, string | undefined>>(() => ({
    grid: gameAssetUrl(game, "grid"),
    hero: gameAssetUrl(game, "hero"),
    logo: gameAssetUrl(game, "logo"),
    icon: gameAssetUrl(game, "icon"),
    header: gameAssetUrl(game, "header"),
    poster: gameAssetUrl(game, "poster")
  }));
  const [fitModes, setFitModes] = useState<Record<GameAssetKind, AssetFitMode>>({
    grid: "crop",
    hero: "crop",
    logo: "contain",
    icon: "crop",
    header: "crop",
    poster: "crop"
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

  const activeUrl = selectedUrls[activeKind];
  const activeSlot = assetSlot(activeKind);
  const activeCrop = cropByKind[activeKind];
  const activeFit = fitModes[activeKind];
  const dirty = ASSET_SLOTS.some((slot) => selectedUrls[slot.kind] !== gameAssetUrl(game, slot.kind));

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
    for (const slot of ASSET_SLOTS) {
      const next = selectedUrls[slot.kind];
      if (next !== gameAssetUrl(game, slot.kind)) {
        update[slot.kind] = next ?? null;
      }
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
            <p className="eyebrow">Artwork</p>
            <h2 id="asset-editor-title">Edit game assets</h2>
          </div>
          <button className="close-button inline-close" type="button" onClick={onClose} aria-label="Close asset editor">
            <X size={18} />
          </button>
        </div>
        <div className="asset-editor-body">
          <aside className="asset-slot-list" aria-label="Asset slots">
            {ASSET_SLOTS.map((slot) => {
              const url = selectedUrls[slot.kind];
              return (
                <button
                  key={slot.kind}
                  type="button"
                  className={slot.kind === activeKind ? "active" : undefined}
                  onClick={() => setActiveKind(slot.kind)}
                  aria-current={slot.kind === activeKind ? "true" : undefined}
                >
                  <span className={`asset-slot-thumb ${slot.className}`}>
                    {url ? <img src={url} alt="" /> : null}
                  </span>
                  <span>
                    <strong>{slot.label}</strong>
                    <em>{slot.ratio}</em>
                  </span>
                </button>
              );
            })}
          </aside>
          <main className="asset-editor-main">
            <div className="asset-preview-row">
              <div className={`asset-preview-frame ${activeSlot.className}`}>
                {activeUrl ? (
                  <img
                    src={activeUrl}
                    alt=""
                    style={{
                      objectFit: activeFit === "contain" ? "contain" : "cover",
                      transform: activeFit === "crop" ? `scale(${activeCrop.zoom}) translate(${-activeCrop.x / 8}%, ${-activeCrop.y / 8}%)` : undefined
                    }}
                  />
                ) : (
                  <span>No asset selected</span>
                )}
              </div>
              <div className="asset-controls">
                <div>
                  <h3>{activeSlot.label}</h3>
                  <p>{activeSlot.ratio}</p>
                </div>
                <div className="segmented-control">
                  <button
                    type="button"
                    className={activeFit === "crop" ? "active" : undefined}
                    onClick={() => setFitModes((current) => ({ ...current, [activeKind]: "crop" }))}
                  >
                    <Crop size={14} />
                    Crop
                  </button>
                  <button
                    type="button"
                    className={activeFit === "contain" ? "active" : undefined}
                    onClick={() => setFitModes((current) => ({ ...current, [activeKind]: "contain" }))}
                  >
                    <Images size={14} />
                    Fit
                  </button>
                </div>
                {activeFit === "crop" ? (
                  <div className="crop-controls">
                    <label>
                      <span>Zoom</span>
                      <input
                        type="range"
                        min="1"
                        max="2.2"
                        step="0.02"
                        value={activeCrop.zoom}
                        onChange={(event) => setCropByKind((current) => ({ ...current, [activeKind]: { ...current[activeKind], zoom: Number(event.target.value) } }))}
                      />
                    </label>
                    <label>
                      <span>X</span>
                      <input
                        type="range"
                        min="-50"
                        max="50"
                        step="1"
                        value={activeCrop.x}
                        onChange={(event) => setCropByKind((current) => ({ ...current, [activeKind]: { ...current[activeKind], x: Number(event.target.value) } }))}
                      />
                    </label>
                    <label>
                      <span>Y</span>
                      <input
                        type="range"
                        min="-50"
                        max="50"
                        step="1"
                        value={activeCrop.y}
                        onChange={(event) => setCropByKind((current) => ({ ...current, [activeKind]: { ...current[activeKind], y: Number(event.target.value) } }))}
                      />
                    </label>
                  </div>
                ) : null}
                <label className="custom-asset-url">
                  <span>Custom URL</span>
                  <div>
                    <input value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} placeholder="https://..." />
                    <button type="button" className="icon-action" onClick={applyCustomUrl}>
                      <Link2 size={14} />
                      Use
                    </button>
                  </div>
                </label>
              </div>
            </div>

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

            {error ? <p className="error-line">{error}</p> : null}
            {warnings.length ? <p className="asset-warning">{warnings.slice(0, 3).join(" ")}</p> : null}
            {loading ? (
              <div className="asset-loading">
                <RefreshCw size={16} />
                Loading assets
              </div>
            ) : filteredCandidates.length ? (
              <div className="asset-candidate-grid">
                {filteredCandidates.map((candidate) => {
                  const selected = selectedUrls[candidate.kind] === candidate.url;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      className={selected ? "selected" : undefined}
                      onClick={() => selectCandidate(candidate)}
                    >
                      <span className={`asset-candidate-image ${assetSlot(candidate.kind).className}`}>
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
            {saving ? "Saving..." : "Save assets"}
          </button>
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
  onClose,
  onGameUpdated,
  onChanged
}: {
  game: GameDetail;
  settings?: AppSettings;
  onSettingsChanged: (settings: AppSettings) => void;
  reduceMotion?: boolean;
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
    <motion.div className="detail-modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.section
        className="detail-modal"
        initial={{ y: 34, scale: 0.985, opacity: 0 }}
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
    onChanged();
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
    onChanged();
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

export function App() {
  const [route, setRoute] = useState<Route>("home");
  const routeRef = useRef<Route>("home");
  const [home, setHome] = useState<HomeModel | undefined>();
  const [games, setGames] = useState<Game[]>([]);
  const [recentGames, setRecentGames] = useState<Game[]>([]);
  const [allGames, setAllGames] = useState<Game[]>([]);
  const [libraryGameIds, setLibraryGameIds] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<GameDetail | undefined>();
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [localIssueCount, setLocalIssueCount] = useState(0);
  const [activeGroupId, setActiveGroupIdState] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<GameContextMenuRequest | undefined>();
  const [nameDialog, setNameDialog] = useState<NameDialogState | undefined>();
  const [switchPrompt, setSwitchPrompt] = useState<SteamSwitchPrompt | undefined>();
  const [launchHandoff, setLaunchHandoff] = useState<LaunchHandoffState | undefined>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus | undefined>();
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
  const [homeFirstLoaded, setHomeFirstLoaded] = useState(false);
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
  const homeApplyTokenRef = useRef(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const reduceLaunchMotion = Boolean(settings?.reduceMotion || prefersReducedMotion);
  const cardsPerRow = normalizeCardsPerRow(settings?.cardsPerRow);

  useEffect(() => {
    profileStartup("app:mounted", "App component mounted");
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
      return homePromiseRef.current;
    }

    const promise = window.hynite.home.get().finally(() => {
      if (homePromiseRef.current === promise) {
        homePromiseRef.current = undefined;
      }
    });
    if (dedupe) {
      homePromiseRef.current = promise;
    }
    return promise;
  }

  function scheduleHomeRefresh(): void {
    const token = ++homeApplyTokenRef.current;
    if (homeRefreshTimerRef.current) {
      clearTimeout(homeRefreshTimerRef.current);
    }
    homeRefreshTimerRef.current = setTimeout(() => {
      homeRefreshTimerRef.current = undefined;
      void loadHome({ dedupe: false }).then((nextHome) => {
        if (homeApplyTokenRef.current === token) {
          setHome(nextHome);
        }
      }).catch(console.error);
    }, 250);
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
    const [nextGames, nextRecentGames, nextSettings] = await Promise.all([
      window.hynite.library.list(libraryQueryForView(effectiveQuery, effectiveLibraryView, effectiveGroup)),
      window.hynite.library.list({ search: "", sort: "recent", installState: "all" }),
      loadedSettings ? Promise.resolve(loadedSettings) : window.hynite.settings.get()
    ]);
    librarySpan.end("ok", { games: nextGames.length, recentGames: nextRecentGames.length });
    setGames(nextGames);
    setAllGames(nextRecentGames);
    setLibraryGameIds(new Set(nextRecentGames.map((game) => game.id)));
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
        popularNow: nextHome.popularNow.length,
        trendingRows: nextHome.trendingRows.length
      });
      setHome(nextHome);
      homeSpan.end("ok", { stale: nextHome.stale, popularNow: nextHome.popularNow.length, trendingRows: nextHome.trendingRows.length });
    }).catch((error: unknown) => {
      profileStartup("home:error", "Renderer home model failed", { error: error instanceof Error ? error.message : String(error) });
      console.error(error);
    }).finally(() => {
      if (!homeFirstLoadedRef.current) {
        homeFirstLoadedRef.current = true;
        setHomeFirstLoaded(true);
      }
    });
  }

  useEffect(() => {
    if (!initialLoadComplete || !homeFirstLoaded) return;
    profileStartup("startup-overlay:paint-wait", "Initial load complete; waiting for paint");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      profileStartup("startup-overlay:hidden", "Startup overlay hidden");
      setStartupDone(true);
      window.hynite.startup.signalReady();
    }));
  }, [initialLoadComplete, homeFirstLoaded]);

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
      setRecentGames((current) => current.map((item) => (item.id === game.id ? game : item)));
      setLibraryGameIds((current) => new Set([...current, game.id]));
      setSelected((current) => (current?.id === game.id ? game : current));
      scheduleHomeRefresh();
      updateSpan.end("ok");
    });
    return () => {
      if (homeRefreshTimerRef.current) {
        clearTimeout(homeRefreshTimerRef.current);
        homeRefreshTimerRef.current = undefined;
      }
      unsubscribeSync();
      unsubscribeGameUpdated();
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
      void refresh();
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

  async function selectGame(game: Game) {
    const span = profileSpan("renderer-render", "renderer:detail-open", { id: game.id, title: game.title });
    soundEngine.play("gameSelect");
    try {
      const ipcSpan = profileSpan("renderer-render", "renderer:detail-open:games-get", { id: game.id, title: game.title });
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
      setSelected(detail);
      applySpan.end("ok");
      span.end("ok", { id: game.id, title: game.title, source: "library" });
    } catch {
      try {
        const partialDetail = { ...game, sourceMatches: [] };
        const applyPartialSpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "discovery-partial" });
        setSelected(partialDetail);
        applyPartialSpan.end("ok", { partial: true });
        span.end("ok", { id: game.id, title: game.title, source: "discovery-partial", hydrationDeferred: true });
        const hydrateSpan = profileSpan("renderer-render", "renderer:detail-open:hydrate-discovery", { id: game.id, title: game.title });
        const detail = await window.hynite.games.hydrateDiscovery(game);
        hydrateSpan.end("ok", {
          id: game.id,
          title: game.title,
          screenshots: detail.screenshots.length,
          hasTrailer: Boolean(detail.trailerUrl),
          hasAboutText: Boolean(detail.aboutText)
        });
        const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "discovery" });
        setSelected(detail);
        applySpan.end("ok");
      } catch {
        try {
          const sourceSpan = profileSpan("renderer-render", "renderer:detail-open:source-search", { id: game.id, title: game.title });
          const sourceMatches = await window.hynite.sources.searchTitle(game.title, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT });
          sourceSpan.end("ok", { id: game.id, title: game.title, sourceMatches: sourceMatches.length });
          const applySpan = profileSpan("renderer-render", "renderer:detail-open:apply-state", { id: game.id, title: game.title, source: "source-search" });
          setSelected({ ...game, sourceMatches });
          applySpan.end("ok");
          span.end("ok", { id: game.id, title: game.title, source: "source-search" });
        } catch (error) {
          span.end("error", { id: game.id, title: game.title, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
    }
  }

  async function setCardsPerRow(value: number) {
    setSettings(await window.hynite.settings.update({ cardsPerRow: normalizeCardsPerRow(value) }));
  }

  const routeContent = useMemo(() => {
    if (route === "home") {
      return <HomeScreen home={home} settings={settings} libraryGameIds={libraryGameIds} onSelect={(game) => void selectGame(game)} onOpenSettings={() => setRoute("settings")} onGameContextMenu={openGameContextMenu} />;
    }
    if (route === "trending") {
      return <TrendingScreen home={home} settings={settings} libraryGameIds={libraryGameIds} onSelect={(game) => void selectGame(game)} onGameContextMenu={openGameContextMenu} />;
    }
    if (route === "library") {
      return (
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
  }, [route, home, games, allGames, activeQuery, settings, syncStatus, libraryGameIds, activeLibraryView, activeGroup, busy, cardsPerRow]);

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
                {item.id === "local" && localIssueCount > 0 ? (
                  <span className="rail-issue-badge" title={`${localIssueCount} item${localIssueCount === 1 ? "" : "s"} need review`}>
                    {localIssueCount}
                  </span>
                ) : null}
              </button>
            );
          })}
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
                {recentGames.slice(0, 30).map((game) => {
                  const isInstalled = game.installState === "installed";
                  const launchable = canLaunch(game);
                  const RecentActionIcon = isInstalled ? Play : launchable ? Download : Info;
                  const actionLabel = isInstalled ? `Play ${game.title}` : launchable ? `Download ${game.title}` : `View details for ${game.title}`;
                  return (
                    <div key={game.id} className="recent-link" onContextMenu={(event) => openGameContextMenu(event, game)}>
                      <button
                        type="button"
                        className="recent-icon-button"
                        onClick={() => (launchable ? void launchGame(game) : void selectGame(game))}
                        aria-label={actionLabel}
                      >
                        <span className={game.communityIconUrl ? "recent-icon has-image" : "recent-icon"} style={!game.communityIconUrl ? fallbackArt(game) : undefined}>
                          {game.communityIconUrl ? <img src={game.communityIconUrl} alt="" /> : null}
                          <span className="recent-play-overlay">
                            <RecentActionIcon size={13} fill={isInstalled ? "currentColor" : "none"} />
                          </span>
                        </span>
                      </button>
                      <button type="button" className="recent-details-button" onClick={() => void selectGame(game)} aria-label={`View details for ${game.title}`}>
                        <span className="rail-label">
                          <strong>{game.title}</strong>
                          <em>{activityLabel(game)}</em>
                        </span>
                      </button>
                    </div>
                  );
                })}
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
              game={selected}
              settings={settings}
              onSettingsChanged={setSettings}
              reduceMotion={settings?.reduceMotion}
              onClose={() => setSelected(undefined)}
              onGameUpdated={setSelected}
              onChanged={() => void refresh()}
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
