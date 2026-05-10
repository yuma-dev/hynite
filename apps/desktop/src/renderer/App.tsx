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
  Clock3,
  Download,
  ExternalLink,
  Film,
  Flame,
  Globe2,
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
  Play,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  TrendingUp,
  Trophy,
  Users,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { defaultLibraryView, gameActivityTime, makeGameId, makeSortTitle, resolveLaunchableSteamAccounts, type AppSettings, type DownloadSourceInfo, type Game, type GameDetail, type HomeModel, type HomeTrendRow, type InstallState, type LibraryDateFilter, type LibraryFilters, type LibraryOwnership, type LibrarySortField, type LibrarySortDirection, type LibraryView, type PlayerMode, type ProviderId, type SourceExactMatch, type SourceImportResult, type SourceMatch, type SteamAccountSettings, type SteamLocalAccount, type SteamSearchResult, type SyncStatus } from "@hynite/core";
import { profileStartup } from "./startupProfile";

async function launchGame(id: string, preferredSteamId?: string): Promise<void> {
  const result = await window.hynite.games.launch(id, preferredSteamId);
  if (result.kind === "launched") {
    return;
  }
  if (result.kind === "no-account") {
    window.alert(result.reason);
    return;
  }
  if (result.kind === "requires-switch") {
    const fromLabel = result.currentAccountName ?? "the currently active account";
    const toLabel = result.target.personaName
      ? `${result.target.personaName} (${result.target.accountName})`
      : result.target.accountName;
    const confirmed = window.confirm(
      `Launching ${result.gameTitle} requires switching from ${fromLabel} to ${toLabel}.\n\nSteam will close and restart silently. Continue?`
    );
    if (!confirmed) return;
    const switchResult = await window.hynite.steam.switchAndLaunch(result.gameId, result.target.steamId);
    if (switchResult.kind === "no-account") {
      window.alert(switchResult.reason);
    }
  }
}

type Route = "home" | "trending" | "library" | "search" | "settings";

const routes: Array<{ id: Route; label: string; icon: typeof Home }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "trending", label: "Trending", icon: Flame },
  { id: "library", label: "Library", icon: Library },
  { id: "search", label: "Search", icon: Search },
  { id: "settings", label: "Settings", icon: Settings }
];

const HERO_AUTOPLAY_MS = 9000;
const HOME_ROW_BATCH_SIZE = 12;
const HOME_ROW_STEP_ITEMS = 3;
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

function TitleBar() {
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

function StartupLoading({ syncStatus }: { syncStatus?: SyncStatus }) {
  const progress =
    syncStatus?.active && syncStatus.total && syncStatus.current !== undefined
      ? Math.min(100, Math.round((syncStatus.current / Math.max(1, syncStatus.total)) * 100))
      : undefined;

  return (
    <main className="startup-screen">
      <div className="startup-mark">
        <BrandLogo className="startup-logo" sizes="88px" />
        <span />
      </div>
      <div className="startup-copy">
        <h1>Hynite</h1>
        <p>{syncStatus?.active ? syncStatus.message : "Loading library"}</p>
      </div>
      <div className={progress === undefined ? "startup-progress" : "startup-progress determinate"} aria-label="Startup progress">
        <span style={progress === undefined ? undefined : { width: `${progress}%` }} />
      </div>
    </main>
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

function primaryCover(game: Game): string | undefined {
  return game.libraryCapsuleUrl ?? (isVerifiedVerticalCoverUrl(game.coverUrl) ? game.coverUrl : undefined);
}

function heroStill(game: Game): string | undefined {
  return game.headerUrl ?? game.trailerPosterUrl ?? game.screenshots[0]?.fullUrl ?? game.backgroundUrl;
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
  wide = false,
  inLibrary = true
}: {
  game: Game;
  onSelect: (game: Game) => void;
  wide?: boolean;
  inLibrary?: boolean;
}) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const cover = primaryCover(game);
  const isInstalled = game.installState === "installed";
  const launchable = canLaunch(game);
  const playtimeLabel = formatHours(game.playtimeMinutes);
  const familyShared = isFamilySharedOnly(game);
  const familyOwnersTooltip = familyShared
    ? `Shared by Steam Family${familySharedOwners(game).length > 0 ? `: ${familySharedOwners(game).join(", ")}` : ""}`
    : undefined;

  return (
    <div
      className={wide ? "wide-game" : "game-cover"}
      style={fallbackArt(game)}
      data-cover-src={cover ?? ""}
      role="button"
      tabIndex={0}
      aria-label={game.title}
      onClick={() => onSelect(game)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(game); } }}
    >
      <span className="cover-art">
        {cover ? (
          <img
            className={imgLoaded ? "cover-img loaded" : "cover-img"}
            src={cover}
            alt=""
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
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
              />
            ) : (
              <span className="cover-logo-fallback">{game.title}</span>
            )}
          </span>
          {isInstalled ? (
            <button
              className="cover-action cover-action-play"
              type="button"
              onClick={(e) => { e.stopPropagation(); void launchGame(game.id); }}
              aria-label={`Play ${game.title}`}
            >
              <Play size={22} fill="currentColor" />
            </button>
          ) : inLibrary && launchable ? (
            <button
              className="cover-action cover-action-download"
              type="button"
              onClick={(e) => { e.stopPropagation(); void launchGame(game.id); }}
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

function GameRow({ title, description, games, onSelect }: { title: string; description?: string; games: Game[]; onSelect: (game: Game) => void }) {
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
        <div className="cover-strip" ref={stripRef} onScroll={onRowScroll} onPointerOver={spotlight.onPointerOver} onPointerLeave={spotlight.onPointerLeave}>
          {visibleGames.map((game) => (
            <GameCover key={game.id} game={game} onSelect={onSelect} />
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    let hls: Hls | undefined;
    setFailed(false);
    video.removeAttribute("src");

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
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("error", onError);
    video.load();

    return () => {
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
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
  onSync
}: {
  home?: HomeModel;
  settings?: AppSettings;
  libraryGameIds: Set<string>;
  onSelect: (game: Game) => void;
  onSync: () => void;
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
          <button className="primary-action" onClick={onSync}>
            <RefreshCw size={16} />
            Sync Steam
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
  onSync
}: {
  home?: HomeModel;
  settings?: AppSettings;
  libraryGameIds: Set<string>;
  onSelect: (game: Game) => void;
  onSync: () => void;
}) {
  return (
    <main className="page">
      <Hero home={home} settings={settings} libraryGameIds={libraryGameIds} onSelect={onSelect} onSync={onSync} />
      <GameRow title="Recently played" games={home?.continuePlaying ?? []} onSelect={onSelect} />
      <GameRow title="Most played" games={home?.mostPlayed ?? []} onSelect={onSelect} />
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

function TrendingScreen({ home, settings, libraryGameIds, onSelect }: { home?: HomeModel; settings?: AppSettings; libraryGameIds: Set<string>; onSelect: (game: Game) => void }) {
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
            <GameRow title={row.title} description={row.description} games={row.games} onSelect={onSelect} />
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
  manual: "Manual"
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
  facets
}: {
  open: boolean;
  onClose: () => void;
  filters: LibraryFilters;
  onChange: (next: LibraryFilters) => void;
  onReset: () => void;
  facets: { sources: ProviderId[]; genres: string[]; tags: string[]; playerModes: PlayerMode[] };
}) {
  const [tagSearch, setTagSearch] = useState("");
  const visibleTags = useMemo(() => {
    const needle = tagSearch.trim().toLocaleLowerCase();
    const list = needle ? facets.tags.filter((tag) => tag.toLocaleLowerCase().includes(needle)) : facets.tags;
    return list.slice(0, 60);
  }, [facets.tags, tagSearch]);

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
            <div className="filter-panel-body">
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
  onSelect,
  onSync
}: {
  games: Game[];
  facetGames: Game[];
  query: string;
  setQuery: (query: string) => void;
  view: LibraryView;
  setView: (next: LibraryView) => void;
  onSelect: (game: Game) => void;
  onSync: () => void;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const spotlight = useSpotlightGrid(gridRef, 180);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
          <h1>Library</h1>
          <p>{games.length} games</p>
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
          <button className="secondary-action" onClick={onSync}>
            <RefreshCw size={16} />
            Sync
          </button>
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
            <button className="primary-action" onClick={onSync}>
              <RefreshCw size={16} />
              Sync Steam
            </button>
          )}
        </div>
      ) : (
        <div className="library-grid" ref={gridRef} onPointerOver={spotlight.onPointerOver} onPointerLeave={spotlight.onPointerLeave}>
          {games.map((game) => (
            <GameCover key={game.id} game={game} onSelect={onSelect} />
          ))}
        </div>
      )}
      <LibraryFiltersPanel
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={view.filters}
        onChange={setFilters}
        onReset={() => setView({ ...view, filters: defaultLibraryView.filters })}
        facets={facets}
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

type SettingsTab = "steam" | "metadata" | "sources" | "advanced";

function formatRelativeExpiry(expiresAt: string): string {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) {
    return "soon";
  }
  const diffMs = expiry - Date.now();
  if (diffMs <= 0) {
    return "now (token expired — refresh)";
  }
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
  if (hours >= 1) {
    return `in ${hours}h ${minutes}m`;
  }
  return `in ${minutes}m`;
}

function SettingsScreen({
  settings,
  setSettings,
  syncStatus,
  onSeed,
  onLibraryCleared
}: {
  settings?: AppSettings;
  setSettings: (settings: AppSettings) => void;
  syncStatus?: SyncStatus;
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

  useEffect(() => {
    void window.hynite.steam.listLocalAccounts().then(setLocalAccounts).catch(() => undefined);
    void window.hynite.steam.getActiveUser().then((info) => setActiveSteamUser(info.accountName)).catch(() => undefined);
  }, [settings?.steamAccounts.length]);

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

  async function refreshFamilyLibrary(steamId: string) {
    setSteamMessage(undefined);
    try {
      const next = await window.hynite.steam.refreshFamily(steamId);
      setSettings(next);
      setSteamMessage("Steam family session refreshed.");
    } catch (error) {
      setSteamMessage(error instanceof Error ? error.message : "Failed to refresh family session.");
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
                          <>Family library connected · expires {formatRelativeExpiry(account.familySession.expiresAt)}</>
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
                                <button className="secondary-action" onClick={() => void refreshFamilyLibrary(account.steamId)}>
                                  <RefreshCw size={14} />
                                  Refresh
                                </button>
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

          {tab === "advanced" ? (
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

function DetailOverlay({
  game,
  settings,
  onSettingsChanged,
  reduceMotion,
  onClose,
  onChanged
}: {
  game: GameDetail;
  settings?: AppSettings;
  onSettingsChanged: (settings: AppSettings) => void;
  reduceMotion?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  type DetailMediaItem =
    | { kind: "trailer"; label: string; sourceUrl: string; posterUrl?: string }
    | { kind: "image"; label: string; sourceUrl: string; thumbnailUrl: string };
  const [viewer, setViewer] = useState<{ images: ImageViewerItem[]; index: number } | undefined>();
  const [downloadQuery, setDownloadQuery] = useState(game.title);
  const [downloadMatches, setDownloadMatches] = useState<SourceMatch[]>(game.sourceMatches);
  const [downloadSearching, setDownloadSearching] = useState(false);
  const [downloadError, setDownloadError] = useState<string | undefined>();
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(() => new Set());
  const [visibleBySource, setVisibleBySource] = useState<Record<string, number>>({});
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
          <main className="detail-main">
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
                  <button className="primary-action" disabled={!canLaunch(game)} onClick={() => void launchGame(game.id, selectedLaunchSteamId)}>
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
                <p className="muted">No source matches.</p>
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
    </>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>("home");
  const [home, setHome] = useState<HomeModel | undefined>();
  const [games, setGames] = useState<Game[]>([]);
  const [recentGames, setRecentGames] = useState<Game[]>([]);
  const [allGames, setAllGames] = useState<Game[]>([]);
  const [libraryGameIds, setLibraryGameIds] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<GameDetail | undefined>();
  const [settings, setSettings] = useState<AppSettings | undefined>();
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
  const [busy, setBusy] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [startupDone, setStartupDone] = useState(false);
  const contentRef = useRef<HTMLElement | null>(null);
  const handledSyncSuccessAtRef = useRef<string | undefined>();

  useEffect(() => {
    profileStartup("app:mounted", "App component mounted");
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [route]);

  async function refresh() {
    const startedAt = performance.now();
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
    profileStartup("refresh:start", "Renderer refresh started", {
      query: effectiveQuery,
      sort: effectiveLibraryView.sort,
      filters: effectiveLibraryView.filters
    });
    const homePromise = window.hynite.home.get();
    const [nextGames, nextRecentGames, nextSettings] = await Promise.all([
      window.hynite.library.list({
        search: effectiveQuery,
        sort: effectiveLibraryView.sort.field,
        sortDirection: effectiveLibraryView.sort.direction,
        ...effectiveLibraryView.filters
      }),
      window.hynite.library.list({ search: "", sort: "recent", installState: "all" }),
      loadedSettings ? Promise.resolve(loadedSettings) : window.hynite.settings.get()
    ]);
    setGames(nextGames);
    setAllGames(nextRecentGames);
    setLibraryGameIds(new Set(nextRecentGames.map((game) => game.id)));
    setRecentGames(nextRecentGames.filter((game) => gameActivityTime(game) > 0));
    setSettings(nextSettings);
    profileStartup("refresh:end", "Renderer refresh local data loaded", {
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      games: nextGames.length,
      recentGames: nextRecentGames.length,
      hasSettings: Boolean(nextSettings),
      hydratedFilters: libraryViewHydratedRef.current
    });
    void homePromise.then((nextHome) => {
      profileStartup("home:end", "Renderer home model loaded", {
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        stale: nextHome.stale,
        popularNow: nextHome.popularNow.length,
        trendingRows: nextHome.trendingRows.length
      });
      setHome(nextHome);
    }).catch((error: unknown) => {
      profileStartup("home:error", "Renderer home model failed", { error: error instanceof Error ? error.message : String(error) });
      console.error(error);
    });
  }

  useEffect(() => {
    if (!initialLoadComplete) return;
    // Wait for two animation frames so the main content has actually painted before hiding the overlay.
    profileStartup("startup-overlay:paint-wait", "Initial load complete; waiting for paint");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      profileStartup("startup-overlay:hidden", "Startup overlay hidden");
      setStartupDone(true);
    }));
  }, [initialLoadComplete]);

  useEffect(() => {
    profileStartup("initial-load:start", "Initial renderer load started");
    void Promise.all([
      refresh(),
      window.hynite.sync.status().then((status) => {
        profileStartup("sync-status:initial", "Initial sync status loaded", { active: status.active, phase: status.phase });
        handledSyncSuccessAtRef.current = status.lastSuccessAt;
        setSyncStatus(status);
      })
    ])
      .catch((error: unknown) => {
        profileStartup("initial-load:error", "Initial renderer load failed", { error: error instanceof Error ? error.message : String(error) });
        console.error(error);
      })
      .finally(() => {
        profileStartup("initial-load:end", "Initial renderer load finished");
        setInitialLoadComplete(true);
      });
    const unsubscribeSync = window.hynite.sync.onStatusChanged((status) => {
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
    });
    const unsubscribeGameUpdated = window.hynite.games.onUpdated((game) => {
      profileStartup("game:update", "Game update received", { id: game.id, title: game.title });
      setGames((current) => current.map((item) => (item.id === game.id ? game : item)));
      setRecentGames((current) => current.map((item) => (item.id === game.id ? game : item)));
      setLibraryGameIds((current) => new Set([...current, game.id]));
      setSelected((current) => (current?.id === game.id ? game : current));
      void window.hynite.home.get().then(setHome).catch(console.error);
    });
    return () => {
      unsubscribeSync();
      unsubscribeGameUpdated();
    };
  }, []);

  useEffect(() => {
    if (!libraryViewHydratedRef.current) return;
    const startedAt = performance.now();
    const effectiveLibraryView = normalizeLibraryView(libraryView);
    profileStartup("library-filter:start", "Library filter query started", {
      query,
      sort: effectiveLibraryView.sort,
      filters: effectiveLibraryView.filters
    });
    void window.hynite.library.list({
      search: query,
      sort: effectiveLibraryView.sort.field,
      sortDirection: effectiveLibraryView.sort.direction,
      ...effectiveLibraryView.filters
    })
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
  }, [query, libraryView]);

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

  async function selectGame(game: Game) {
    try {
      setSelected(await window.hynite.games.get(game.id));
    } catch {
      try {
        setSelected(await window.hynite.games.hydrateDiscovery(game));
      } catch {
        setSelected({ ...game, sourceMatches: await window.hynite.sources.searchTitle(game.title, { limit: DOWNLOAD_MATCH_SEARCH_LIMIT }) });
      }
    }
  }

  const routeContent = useMemo(() => {
    if (route === "home") {
      return <HomeScreen home={home} settings={settings} libraryGameIds={libraryGameIds} onSelect={(game) => void selectGame(game)} onSync={() => void syncSteam()} />;
    }
    if (route === "trending") {
      return <TrendingScreen home={home} settings={settings} libraryGameIds={libraryGameIds} onSelect={(game) => void selectGame(game)} />;
    }
    if (route === "library") {
      return (
        <LibraryScreen
          games={games}
          facetGames={allGames.length > 0 ? allGames : games}
          query={query}
          setQuery={setQuery}
          view={libraryView}
          setView={setLibraryView}
          onSelect={(game) => void selectGame(game)}
          onSync={() => void syncSteam()}
        />
      );
    }
    if (route === "search") {
      return <SteamSearchScreen onSelect={(result) => void selectGame(gameFromSteamSearchResult(result))} />;
    }
    return (
      <SettingsScreen
        settings={settings}
        setSettings={setSettings}
        syncStatus={syncStatus}
        onLibraryCleared={() => {
          setSelected(undefined);
          void refresh();
        }}
        onSeed={() => void window.hynite.debug.seed().then(() => refresh())}
      />
    );
  }, [route, home, games, recentGames, allGames, query, settings, syncStatus, libraryGameIds, libraryView]);

  return (
    <>
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <aside className="rail">
          <div className="rail-brand">
            <BrandLogo className="rail-logo" sizes="38px" />
          </div>
          {routes.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={route === item.id ? "active" : ""} onClick={() => setRoute(item.id)}>
                <Icon size={17} />
                <span className="rail-label">{item.label}</span>
              </button>
            );
          })}
          <button className="rail-sync" disabled={busy} onClick={() => void syncSteam()}>
            <RefreshCw size={15} />
            <span className="rail-label">{busy ? "Syncing" : "Steam sync"}</span>
          </button>
          <div className="rail-section">
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
                  <div key={game.id} className="recent-link">
                    <button
                      type="button"
                      className="recent-icon-button"
                      onClick={() => (launchable ? void launchGame(game.id) : void selectGame(game))}
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
              onChanged={() => void refresh()}
            />
          ) : null}
        </AnimatePresence>
      </div>
      <footer className="statusbar">
        <span className="status-dot" />
        <span>{games.length} games</span>
        <span>{home?.stale ? "cached discovery" : "online discovery"}</span>
        <span>v0.1.0</span>
      </footer>
    </div>
    {!startupDone && (
      <div className="startup-overlay">
        <StartupLoading syncStatus={syncStatus} />
      </div>
    )}
    </>
  );
}
