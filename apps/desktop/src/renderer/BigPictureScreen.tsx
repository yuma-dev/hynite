import { memo, Profiler, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Play, X, Download, Info, SlidersHorizontal, Plus, Star, Github } from "lucide-react";
import type { AppSettings, ControllerActionId, ControllerSettings, Game, GameGroup } from "@hynite/core";
import { expandPaletteToSlots, extractPalette, fallbackPalette, getCachedPalette, type CoverPalette, type PaletteDebugInfo } from "./colorExtract";
import { soundEngine } from "./sound";
import ColorBends from "./ColorBends";
import { bindingLabel, bindingPressed, normalizeControllerSettings, readGamepadState } from "./controllerInput";
import { isProfileEnabled } from "./startupProfile";
import { profileReactRender, startRuntimeInteraction, updateRuntimeProfileContext } from "./runtimeFrameProfile";
import { clampIndex, getGridRenderCount, getShelfWindow } from "./bigPictureLayout";

type BigPictureTab = {
  id: string;
  label: string;
  games: Game[];
};

type Props = {
  games: Game[];
  recentGames: Game[];
  settings: AppSettings | undefined;
  groupGames: Map<string, Game[]>;
  activeFilterCount: number;
  onOpenFilters: () => void;
  onLaunch: (game: Game) => void;
  onSelect: (game: Game) => void;
  onBack: () => boolean;
  onExit: () => void;
  defaultTabId?: string;
  onSetDefaultTab?: (tabId: string | undefined) => void;
  detailOpen?: boolean;
  filterOpen?: boolean;
};

type ViewMode = "shelf" | "grid";
type TransitionDirection = "left" | "right" | "up" | "down" | "none";

const PALETTE_DEBOUNCE_MS = 250;
const PALETTE_TWEEN_MS = 700;
// Total color slots passed to the ColorBends shader. Dominant colors fill
// more slots, giving them proportionally more visual weight.
const COLOR_SLOTS = 8;
const GAMEPAD_REPEAT_INITIAL_MS = 280;
const GAMEPAD_REPEAT_MS = 110;
const STICK_THRESHOLD = 0.55;
const VIEW_TRANSITION: { duration: number; ease: [number, number, number, number] } = {
  duration: 0.42,
  ease: [0.16, 1, 0.3, 1]
};
const GRID_FOCUS_SCROLL_PAD = 72;
const SHELF_OVERSCAN_BEFORE = 1;
const SHELF_OVERSCAN_AFTER = 8;
const GRID_MIN_ROWS = 4;
const GRID_OVERSCAN_ROWS = 2;
const GRID_BATCH_ROWS = 3;
const SHELF_CONTENT_VARIANTS: Variants = {
  initial: (direction: TransitionDirection) => ({
    x: direction === "left" ? "-100%" : direction === "right" ? "100%" : 0,
    y: direction === "down" ? "100%" : direction === "up" ? "-100%" : 0
  }),
  animate: {
    x: 0,
    y: 0,
    transition: VIEW_TRANSITION
  },
  exit: (direction: TransitionDirection) => ({
    x: direction === "left" ? "100%" : direction === "right" ? "-100%" : 0,
    y: direction === "down" ? "-100%" : direction === "up" ? "100%" : 0,
    transition: VIEW_TRANSITION
  })
};
const GRID_CONTENT_VARIANTS: Variants = {
  initial: (direction: TransitionDirection) => ({
    x: direction === "left" ? "-100%" : direction === "right" ? "100%" : 0,
    y: direction === "down" ? "100%" : direction === "up" ? "-100%" : 0
  }),
  animate: {
    x: 0,
    y: 0,
    transition: VIEW_TRANSITION
  },
  exit: (direction: TransitionDirection) => ({
    x: direction === "left" ? "100%" : direction === "right" ? "-100%" : 0,
    y: direction === "down" ? "-100%" : direction === "up" ? "100%" : 0,
    transition: VIEW_TRANSITION
  })
};
const DIGITAL_CONTROLLER_ACTIONS: ControllerActionId[] = [
  "moveUp",
  "moveDown",
  "moveLeft",
  "moveRight",
  "previousGroup",
  "nextGroup",
  "play",
  "details",
  "filters",
  "back",
  "toggleGrid",
  "exitBigPicture",
  "favoriteTab"
];

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

function gameCoverUrl(game: Game): string | undefined {
  return game.libraryCapsuleUrl ?? (isVerifiedVerticalCoverUrl(game.coverUrl) ? game.coverUrl : undefined);
}

function isVerifiedVerticalCoverUrl(value: string | undefined): boolean {
  return Boolean(value && (/(?:\/|%2f)library_(?:600x900|capsule)(?:_2x)?\.(?:jpg|png|webp)(?:\?|$)/i.test(value) || /steamgriddb\.com\/grid\//i.test(value)));
}

function canLaunch(game: Game): boolean {
  return game.installState === "installed";
}

type ShelfImagePriority = "focused" | "near" | "lazy";

const BigPictureShelfCard = memo(function BigPictureShelfCard({
  game,
  absoluteIndex,
  focused,
  cover,
  imagePriority,
  onActivate,
  onFocus
}: {
  game: Game;
  absoluteIndex: number;
  focused: boolean;
  cover: string | undefined;
  imagePriority: ShelfImagePriority;
  onActivate: (game: Game) => void;
  onFocus: (index: number) => void;
}) {
  return (
    <button
      type="button"
      data-focused={focused}
      className={focused ? "bp-card focused" : "bp-card"}
      onClick={() => {
        if (focused) {
          onActivate(game);
        } else {
          onFocus(absoluteIndex);
        }
      }}
      aria-label={game.title}
    >
      {cover ? (
        <img
          src={cover}
          alt=""
          loading={imagePriority === "lazy" ? "lazy" : "eager"}
          decoding="async"
          fetchPriority={imagePriority === "focused" ? "high" : "auto"}
        />
      ) : (
        <span className="bp-card-fallback">{game.title}</span>
      )}
    </button>
  );
});

const BigPictureGridCard = memo(function BigPictureGridCard({
  game,
  absoluteIndex,
  focused,
  cover,
  onActivate,
  onFocus
}: {
  game: Game;
  absoluteIndex: number;
  focused: boolean;
  cover: string | undefined;
  onActivate: (game: Game) => void;
  onFocus: (index: number) => void;
}) {
  return (
    <button
      type="button"
      data-focused={focused}
      className={focused ? "bp-grid-card focused" : "bp-grid-card"}
      onClick={() => {
        if (focused) {
          onActivate(game);
        } else {
          onFocus(absoluteIndex);
        }
      }}
      aria-label={game.title}
    >
      <div className="bp-grid-card-cover">
        {cover ? (
          <img src={cover} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="bp-card-fallback">{game.title}</span>
        )}
      </div>
    </button>
  );
});

function buildTabs(
  games: Game[],
  recentGames: Game[],
  groups: GameGroup[],
  groupGames: Map<string, Game[]>,
  defaultTabId?: string
): BigPictureTab[] {
  const groupTabs: BigPictureTab[] = [];
  for (const group of groups) {
    const list = groupGames.get(group.id);
    if (!list || list.length === 0) continue;
    groupTabs.push({ id: `group:${group.id}`, label: group.name, games: list });
  }

  const devGames = games.filter((g) => g.id === "hynite:self");
  const regularGames = games.filter((g) => g.id !== "hynite:self");
  const regularRecent = recentGames.filter((g) => g.id !== "hynite:self");

  const tabs: BigPictureTab[] = [];

  // Favorited group tab goes first if set
  if (defaultTabId) {
    const favIdx = groupTabs.findIndex((t) => t.id === defaultTabId);
    if (favIdx >= 0) tabs.push(...groupTabs.splice(favIdx, 1));
  }

  if (regularRecent.length) {
    tabs.push({ id: "recent", label: "Recent", games: regularRecent.slice(0, 30) });
  }
  const installed = regularGames.filter((g) => g.installState === "installed");
  if (installed.length) {
    tabs.push({ id: "installed", label: "Installed", games: installed });
  }
  tabs.push({ id: "all", label: "All Games", games: regularGames });
  tabs.push(...groupTabs);
  if (devGames.length > 0) {
    tabs.push({ id: "dev", label: "Dev", games: devGames });
  }

  return tabs.filter((t) => t.games.length > 0 || t.id === "all");
}

// ── palette tweening ────────────────────────────────────────────────────────
type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function paletteToSlots(p: CoverPalette): Rgb[] {
  return expandPaletteToSlots(p, COLOR_SLOTS).map(hexToRgb);
}

function backgroundBaseFromColor(hex: string | undefined): string {
  if (!hex) return "#08080b";
  const { r, g, b } = hexToRgb(hex);
  const mix = 0.2;
  return rgbToHex({
    r: r * mix + 6,
    g: g * mix + 6,
    b: b * mix + 9
  });
}

function paletteDebugEnabled(): boolean {
  try {
    return localStorage.getItem("hynite:paletteDebug") === "1";
  } catch {
    return false;
  }
}

function logPaletteDebug(game: Game, info: PaletteDebugInfo): void {
  if (!paletteDebugEnabled()) return;
  const payload = {
    game: { id: game.id, title: game.title },
    ...info
  };
  if (info.source === "failed" || info.source === "missing-url") {
    console.warn("[hynite:palette]", payload);
  } else {
    console.debug("[hynite:palette]", payload);
  }
}

// ── component ───────────────────────────────────────────────────────────────

export function BigPictureScreen({
  games,
  recentGames,
  settings,
  groupGames,
  activeFilterCount,
  onOpenFilters,
  onLaunch,
  onSelect,
  onBack,
  onExit,
  defaultTabId,
  onSetDefaultTab,
  detailOpen,
  filterOpen
}: Props) {
  const groups = useMemo<GameGroup[]>(() => settings?.gameGroups ?? [], [settings]);
  const tabs = useMemo(
    () => buildTabs(games, recentGames, groups, groupGames, defaultTabId),
    [games, recentGames, groups, groupGames, defaultTabId]
  );

  const [tabIndex, setTabIndex] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("shelf");
  const [noiseOverride, setNoiseOverride] = useState(0.6);
  const [gridColumns, setGridColumns] = useState(6);
  const [gridRenderCount, setGridRenderCount] = useState(0);
  const [transitionDirection, setTransitionDirection] = useState<TransitionDirection>("none");

  const gridRef = useRef<HTMLDivElement | null>(null);
  const navSoundReadyRef = useRef(false);
  const gamepadRepeatRef = useRef<Record<string, { pressed: boolean; lastAt: number; nextDelay: number }>>({});
  const paletteTweenVersionRef = useRef(0);
  const [paletteTweenVersion, setPaletteTweenVersion] = useState(0);
  // Block exitBigPicture for 500ms after mount so the enter combo doesn't immediately exit.
  const exitBlockedRef = useRef(true);
  const defaultTabAppliedRef = useRef(false);
  const currentTabIdRef = useRef<string | undefined>(undefined);
  const defaultTabIdRef = useRef<string | undefined>(defaultTabId);

  const currentTab = tabs[Math.min(tabIndex, tabs.length - 1)];
  const currentGameCount = currentTab?.games.length ?? 0;
  const clampedFocusedIndex = clampIndex(focusedIndex, currentGameCount);
  const focusedGame: Game | undefined = currentTab?.games[clampedFocusedIndex];
  currentTabIdRef.current = currentTab?.id;
  defaultTabIdRef.current = defaultTabId;
  const controller = useMemo<ControllerSettings>(() => normalizeControllerSettings(settings), [settings]);
  const binding = useCallback((action: ControllerActionId) => controller.bindings[action], [controller]);
  const reduceMotion = useReducedMotion();
  const shelfWindow = useMemo(
    () => getShelfWindow({
      focusedIndex: clampedFocusedIndex,
      count: currentGameCount,
      overscanBefore: SHELF_OVERSCAN_BEFORE,
      overscanAfter: SHELF_OVERSCAN_AFTER
    }),
    [clampedFocusedIndex, currentGameCount]
  );
  const shelfGames = useMemo(
    () => currentTab?.games.slice(shelfWindow.start, shelfWindow.end) ?? [],
    [currentTab?.games, shelfWindow.end, shelfWindow.start]
  );
  const visibleGridGames = useMemo(
    () => currentTab?.games.slice(0, gridRenderCount) ?? [],
    [currentTab?.games, gridRenderCount]
  );
  const computedGridRenderCount = useCallback((count: number, targetIndex: number, currentRenderCount: number) =>
    getGridRenderCount({
      count,
      focusedIndex: targetIndex,
      columns: gridColumns,
      currentRenderCount,
      minimumRows: GRID_MIN_ROWS,
      overscanRows: GRID_OVERSCAN_ROWS,
      batchRows: GRID_BATCH_ROWS
    }), [gridColumns]);
  const ensureGridRenderCount = useCallback((targetIndex: number, count = currentGameCount) => {
    setGridRenderCount((current) => computedGridRenderCount(count, targetIndex, current));
  }, [computedGridRenderCount, currentGameCount]);
  const finishInteractionAfterTransition = useCallback((span: ReturnType<typeof startRuntimeInteraction>, details?: Record<string, unknown>) => {
    window.setTimeout(() => span.end("ok", details), Math.round(VIEW_TRANSITION.duration * 1000) + 80);
  }, []);
  const profileFocusMove = useCallback((direction: "up" | "down" | "left" | "right") => {
    const span = startRuntimeInteraction("bp:focus-move", {
      direction,
      viewMode,
      tabId: currentTab?.id,
      tabLabel: currentTab?.label,
      fromIndex: focusedIndex,
      gameCount: currentTab?.games.length ?? 0
    });
    window.setTimeout(() => span.end("ok"), 140);
  }, [currentTab?.games.length, currentTab?.id, currentTab?.label, focusedIndex, viewMode]);

  useEffect(() => {
    const dev = ((window as unknown as Record<string, unknown>).__hyniteDev ?? {}) as Record<string, unknown>;
    dev.setBgNoise = (value: number) => {
      setNoiseOverride(value);
      console.log(`[hynite dev] Background noise set to ${value}`);
    };
    (window as unknown as Record<string, unknown>).__hyniteDev = dev;
  }, []);

  useEffect(() => {
    updateRuntimeProfileContext({
      bigPicture: true,
      area: "big-picture",
      totalGames: currentGameCount,
      visibleGames: viewMode === "grid" ? gridRenderCount : shelfWindow.end - shelfWindow.start,
      bpViewMode: viewMode,
      bpTabId: currentTab?.id,
      bpTabLabel: currentTab?.label,
      bpFocusedIndex: clampedFocusedIndex,
      bpFocusedTitle: focusedGame?.title,
      bpGridColumns: gridColumns,
      bpShelfWindowStart: viewMode === "shelf" ? shelfWindow.start : undefined,
      bpShelfWindowEnd: viewMode === "shelf" ? shelfWindow.end : undefined
    });
  }, [clampedFocusedIndex, currentGameCount, currentTab?.id, currentTab?.label, focusedGame?.title, gridColumns, gridRenderCount, shelfWindow.end, shelfWindow.start, viewMode]);

  useEffect(() => {
    setTabIndex((current) => clampIndex(current, tabs.length));
  }, [tabs.length]);

  useEffect(() => {
    setFocusedIndex((current) => clampIndex(current, currentGameCount));
  }, [currentGameCount]);

  useEffect(() => {
    setFocusedIndex(0);
    setGridRenderCount(getGridRenderCount({
      count: currentGameCount,
      focusedIndex: 0,
      columns: gridColumns,
      currentRenderCount: 0,
      minimumRows: GRID_MIN_ROWS,
      overscanRows: GRID_OVERSCAN_ROWS,
      batchRows: GRID_BATCH_ROWS
    }));
    gridRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [currentTab?.id]);

  useEffect(() => {
    setGridRenderCount((current) => computedGridRenderCount(currentGameCount, clampedFocusedIndex, current));
  }, [clampedFocusedIndex, computedGridRenderCount, currentGameCount, gridColumns]);

  useEffect(() => {
    const timer = setTimeout(() => { exitBlockedRef.current = false; }, 500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (defaultTabAppliedRef.current || !defaultTabId) return;
    const idx = tabs.findIndex((t) => t.id === defaultTabId);
    if (idx >= 0) {
      defaultTabAppliedRef.current = true;
      setTransitionDirection(idx >= tabIndex ? "right" : "left");
      setTabIndex(idx);
    }
  }, [defaultTabId, tabIndex, tabs]);

  const switchTab = useCallback((nextIndex: number) => {
    setTabIndex((current) => {
      const next = Math.max(0, Math.min(nextIndex, tabs.length - 1));
      if (next !== current) {
        const fromTab = tabs[current];
        const toTab = tabs[next];
        finishInteractionAfterTransition(startRuntimeInteraction("bp:switch-folder", {
          fromTabId: fromTab?.id,
          fromTabLabel: fromTab?.label,
          toTabId: toTab?.id,
          toTabLabel: toTab?.label,
          toGameCount: toTab?.games.length ?? 0,
          viewMode
        }), { toTabId: toTab?.id, toGameCount: toTab?.games.length ?? 0 });
        setTransitionDirection(next > current ? "right" : "left");
        setFocusedIndex(0);
        setGridRenderCount(computedGridRenderCount(toTab?.games.length ?? 0, 0, 0));
        gridRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
      return next;
    });
  }, [computedGridRenderCount, finishInteractionAfterTransition, tabs, viewMode]);

  const shiftTab = useCallback((delta: -1 | 1) => {
    setTabIndex((current) => {
      const next = Math.max(0, Math.min(current + delta, tabs.length - 1));
      if (next !== current) {
        const fromTab = tabs[current];
        const toTab = tabs[next];
        finishInteractionAfterTransition(startRuntimeInteraction("bp:switch-folder", {
          fromTabId: fromTab?.id,
          fromTabLabel: fromTab?.label,
          toTabId: toTab?.id,
          toTabLabel: toTab?.label,
          toGameCount: toTab?.games.length ?? 0,
          viewMode
        }), { toTabId: toTab?.id, toGameCount: toTab?.games.length ?? 0 });
        setTransitionDirection(delta > 0 ? "right" : "left");
        setFocusedIndex(0);
        setGridRenderCount(computedGridRenderCount(toTab?.games.length ?? 0, 0, 0));
        gridRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
      return next;
    });
  }, [computedGridRenderCount, finishInteractionAfterTransition, tabs, viewMode]);

  const enterGrid = useCallback(() => {
    setViewMode((mode) => {
      if (mode !== "grid") {
        ensureGridRenderCount(focusedIndex, currentTab?.games.length ?? 0);
        finishInteractionAfterTransition(startRuntimeInteraction("bp:enter-grid", {
          tabId: currentTabIdRef.current,
          gameCount: currentTab?.games.length ?? 0,
          focusedIndex
        }), { gameCount: currentTab?.games.length ?? 0 });
        setTransitionDirection("down");
      }
      return "grid";
    });
  }, [currentTab?.games.length, ensureGridRenderCount, finishInteractionAfterTransition, focusedIndex]);

  const exitGrid = useCallback(() => {
    setViewMode((mode) => {
      if (mode !== "shelf") {
        finishInteractionAfterTransition(startRuntimeInteraction("bp:exit-grid", {
          tabId: currentTabIdRef.current,
          gameCount: currentTab?.games.length ?? 0,
          focusedIndex
        }), { gameCount: currentTab?.games.length ?? 0 });
        setTransitionDirection("up");
      }
      return "shelf";
    });
  }, [currentTab?.games.length, finishInteractionAfterTransition, focusedIndex]);

  const toggleGrid = useCallback(() => {
    setViewMode((mode) => {
      const enteringGrid = mode !== "grid";
      if (enteringGrid) {
        ensureGridRenderCount(focusedIndex, currentTab?.games.length ?? 0);
      }
      finishInteractionAfterTransition(startRuntimeInteraction(enteringGrid ? "bp:enter-grid" : "bp:exit-grid", {
        tabId: currentTabIdRef.current,
        gameCount: currentTab?.games.length ?? 0,
        focusedIndex,
        source: "toggle"
      }), { gameCount: currentTab?.games.length ?? 0 });
      setTransitionDirection(mode === "grid" ? "up" : "down");
      return mode === "grid" ? "shelf" : "grid";
    });
  }, [currentTab?.games.length, ensureGridRenderCount, finishInteractionAfterTransition, focusedIndex]);

  // ── Palette: cover extraction is debounced and tweened toward over
  // PALETTE_TWEEN_MS via rAF. We tween across fixed COLOR_SLOTS so dominant
  // colors keep their proportional share.
  const targetPaletteRef = useRef<CoverPalette>(fallbackPalette());
  const tweenFromRef = useRef<Rgb[]>(paletteToSlots(targetPaletteRef.current));
  const tweenToRef = useRef<Rgb[]>(paletteToSlots(targetPaletteRef.current));
  const tweenStartRef = useRef<number>(performance.now());
  const initialSlots = paletteToSlots(targetPaletteRef.current).map(rgbToHex);
  const [animColors, setAnimColors] = useState<string[]>(initialSlots);
  const backgroundBase = backgroundBaseFromColor(animColors[0]);
  const shelfGlowColor = animColors[0] ?? "#ffffff";

  const palettesEqual = useCallback((a: CoverPalette, b: CoverPalette): boolean => {
    if (a.colors.length !== b.colors.length) return false;
    for (let i = 0; i < a.colors.length; i++) {
      if (a.colors[i]!.hex !== b.colors[i]!.hex) return false;
      if (Math.abs(a.colors[i]!.weight - b.colors[i]!.weight) > 0.01) return false;
    }
    return true;
  }, []);

  const setTargetPalette = useCallback((next: CoverPalette) => {
    if (palettesEqual(next, targetPaletteRef.current)) return;
    // Snapshot the currently displayed slots (mid-tween) as the new "from"
    // so the transition continues smoothly instead of snapping.
    const elapsed = performance.now() - tweenStartRef.current;
    const t = Math.min(1, elapsed / PALETTE_TWEEN_MS);
    const e = t * t * (3 - 2 * t);
    tweenFromRef.current = tweenFromRef.current.map((from, i) => lerpRgb(from, tweenToRef.current[i]!, e));
    targetPaletteRef.current = next;
    tweenToRef.current = paletteToSlots(next);
    tweenStartRef.current = performance.now();
    paletteTweenVersionRef.current += 1;
    setPaletteTweenVersion(paletteTweenVersionRef.current);
  }, [palettesEqual]);

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    let lastKey: string | undefined;
    const loop = () => {
      if (stopped) return;
      const t = Math.min(1, (performance.now() - tweenStartRef.current) / PALETTE_TWEEN_MS);
      const e = t * t * (3 - 2 * t);
      const hex: string[] = tweenFromRef.current.map((from, i) =>
        rgbToHex(lerpRgb(from, tweenToRef.current[i]!, e))
      );
      const key = hex.join("|");
      if (key !== lastKey) {
        lastKey = key;
        setAnimColors(hex);
      }
      if (t < 1) {
        raf = requestAnimationFrame(loop);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [paletteTweenVersion]);

  useEffect(() => {
    if (!focusedGame) return;
    // Big Picture color is cover-art only. No hero/header fallback, because
    // wide store art often has unrelated marketing colors.
    const url = gameCoverUrl(focusedGame);
    const cached = url ? getCachedPalette(url) : undefined;
    logPaletteDebug(focusedGame, url
      ? { url, source: cached ? "cache" : undefined, palette: cached }
      : { source: "missing-url", error: "no verified cover url" });
    if (cached) {
      setTargetPalette(cached);
    } else {
      setTargetPalette(fallbackPalette());
    }

    // Debounce extraction so quick flicks don't churn.
    if (!url) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const span = startRuntimeInteraction("bp:palette-extract", {
        gameId: focusedGame.id,
        title: focusedGame.title,
        source: cached ? "cache-refresh" : "uncached"
      });
      void extractPalette(url, (info) => logPaletteDebug(focusedGame, info))
        .then((next) => {
          if (cancelled) {
            span.end("cancelled", { gameId: focusedGame.id, title: focusedGame.title });
            return;
          }
          logPaletteDebug(focusedGame, {
            url,
            source: next ? "extracted" : "failed",
            palette: next,
            error: next ? undefined : "using neutral fallback"
          });
          setTargetPalette(next ?? fallbackPalette());
          span.end(next ? "ok" : "error", { gameId: focusedGame.id, title: focusedGame.title, extracted: Boolean(next) });
        })
        .catch((error: unknown) => {
          span.end("error", { gameId: focusedGame.id, title: focusedGame.title, error: error instanceof Error ? error.message : String(error) });
        });
    }, PALETTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [focusedGame, setTargetPalette]);

  // ── Navigation sound on focus change (after first mount)
  useEffect(() => {
    if (!navSoundReadyRef.current) {
      navSoundReadyRef.current = true;
      return;
    }
    soundEngine.play("navigation");
  }, [focusedIndex]);

  // ── Keyboard
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (viewMode === "grid") {
          exitGrid();
        } else {
          onExit();
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (focusedGame) {
          if (canLaunch(focusedGame)) onLaunch(focusedGame);
          else onSelect(focusedGame);
        }
        return;
      }

      // Tab switching (LB/RB analogs).
      if (event.key === "[" || event.key === "q" || event.key === "Q") {
        event.preventDefault();
        shiftTab(-1);
        return;
      }
      if (event.key === "]" || event.key === "e" || event.key === "E") {
        event.preventDefault();
        shiftTab(1);
        return;
      }

      const count = currentTab?.games.length ?? 0;
      if (count <= 0) return;
      if (viewMode === "shelf") {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          profileFocusMove("right");
          setTransitionDirection("right");
          setFocusedIndex((i) => {
            const next = Math.min(i + 1, count - 1);
            return next;
          });
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          profileFocusMove("left");
          setTransitionDirection("left");
          setFocusedIndex((i) => {
            const next = Math.max(i - 1, 0);
            return next;
          });
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          enterGrid();
          return;
        }
      } else {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          profileFocusMove("right");
          setTransitionDirection("right");
          setFocusedIndex((i) => {
            const next = Math.min(i + 1, count - 1);
            ensureGridRenderCount(next, count);
            return next;
          });
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          profileFocusMove("left");
          setTransitionDirection("left");
          setFocusedIndex((i) => {
            const next = Math.max(i - 1, 0);
            ensureGridRenderCount(next, count);
            return next;
          });
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          profileFocusMove("down");
          setTransitionDirection("down");
          setFocusedIndex((i) => {
            const next = Math.min(i + gridColumns, count - 1);
            ensureGridRenderCount(next, count);
            return next;
          });
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          profileFocusMove("up");
          setTransitionDirection("up");
          setFocusedIndex((i) => {
            if (i < gridColumns) {
              exitGrid();
              return i;
            }
            const next = Math.max(i - gridColumns, 0);
            ensureGridRenderCount(next, count);
            return next;
          });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTab, enterGrid, ensureGridRenderCount, exitGrid, focusedGame, profileFocusMove, shiftTab, viewMode, gridColumns, onExit, onLaunch, onSelect]);

  const moveFocus = useCallback((direction: "up" | "down" | "left" | "right") => {
    const count = currentTab?.games.length ?? 0;
    if (count <= 0) return;
    if (viewMode === "shelf") {
      if (direction === "right") {
        profileFocusMove("right");
        setTransitionDirection("right");
        setFocusedIndex((i) => Math.min(i + 1, count - 1));
      }
      if (direction === "left") {
        profileFocusMove("left");
        setTransitionDirection("left");
        setFocusedIndex((i) => Math.max(i - 1, 0));
      }
      if (direction === "down") {
        profileFocusMove("down");
        enterGrid();
      }
      return;
    }
    if (direction === "right") {
      profileFocusMove("right");
      setTransitionDirection("right");
      setFocusedIndex((i) => {
        const next = Math.min(i + 1, count - 1);
        ensureGridRenderCount(next, count);
        return next;
      });
    }
    if (direction === "left") {
      profileFocusMove("left");
      setTransitionDirection("left");
      setFocusedIndex((i) => {
        const next = Math.max(i - 1, 0);
        ensureGridRenderCount(next, count);
        return next;
      });
    }
    if (direction === "down") {
      profileFocusMove("down");
      setTransitionDirection("down");
      setFocusedIndex((i) => {
        const next = Math.min(i + gridColumns, count - 1);
        ensureGridRenderCount(next, count);
        return next;
      });
    }
    if (direction === "up") {
      profileFocusMove("up");
      setTransitionDirection("up");
      setFocusedIndex((i) => {
        if (i < gridColumns) {
          exitGrid();
          return i;
        }
        const next = Math.max(i - gridColumns, 0);
        ensureGridRenderCount(next, count);
        return next;
      });
    }
  }, [currentTab?.games.length, ensureGridRenderCount, enterGrid, exitGrid, gridColumns, profileFocusMove, viewMode]);

  const runControllerAction = useCallback((action: string) => {
    if (action === "exitBigPicture") {
      if (exitBlockedRef.current) return;
      onExit();
      return;
    }
    // When a submenu is open, redirect navigation into it and suppress main list movement.
    if (filterOpen) {
      if (action === "back") { onBack(); return; }
      if (["moveUp", "moveDown", "moveLeft", "moveRight", "play"].includes(action)) {
        window.dispatchEvent(new CustomEvent("bp-filter-action", { detail: { action } }));
      }
      return;
    }
    if (detailOpen) {
      if (action === "back") { onBack(); return; }
      if (action === "moveUp" || action === "moveDown") {
        window.dispatchEvent(new CustomEvent("bp-scroll", { detail: { direction: action === "moveUp" ? "up" : "down" } }));
      }
      return;
    }
    if (action === "favoriteTab") {
      const tabId = currentTabIdRef.current;
      if (tabId?.startsWith("group:") && onSetDefaultTab) {
        const wasDef = tabId === defaultTabIdRef.current;
        onSetDefaultTab(wasDef ? undefined : tabId);
      }
      return;
    }
    if (action === "moveUp" || action === "moveDown" || action === "moveLeft" || action === "moveRight") {
      moveFocus(action === "moveUp" ? "up" : action === "moveDown" ? "down" : action === "moveLeft" ? "left" : "right");
      return;
    }
    if (action === "previousGroup") {
      shiftTab(-1);
      return;
    }
    if (action === "nextGroup") {
      shiftTab(1);
      return;
    }
    if (action === "play" && focusedGame) {
      if (canLaunch(focusedGame)) onLaunch(focusedGame);
      else onSelect(focusedGame);
      return;
    }
    if (action === "details" && focusedGame) {
      onSelect(focusedGame);
      return;
    }
    if (action === "filters") {
      onOpenFilters();
      return;
    }
    if (action === "toggleGrid") {
      toggleGrid();
      return;
    }
    if (action === "back") {
      if (onBack()) return;
      if (viewMode === "grid") exitGrid();
    }
  }, [detailOpen, exitGrid, filterOpen, focusedGame, moveFocus, onBack, onExit, onLaunch, onOpenFilters, onSelect, onSetDefaultTab, shiftTab, toggleGrid, viewMode]);

  useEffect(() => {
    if (!controller.enabled) return;
    let raf = 0;
    const poll = () => {
      if (!controller.backgroundInput && !document.hasFocus()) {
        gamepadRepeatRef.current = {};
        raf = requestAnimationFrame(poll);
        return;
      }
      const { pressed, axes, connected } = readGamepadState();
      if (!connected) {
        gamepadRepeatRef.current = {};
        raf = requestAnimationFrame(poll);
        return;
      }

      const now = performance.now();
      const activeActions: string[] = [];
      const axisX = Math.abs(axes[0] ?? 0) > Math.abs(axes[2] ?? 0) ? axes[0] ?? 0 : axes[2] ?? 0;
      const axisY = Math.abs(axes[1] ?? 0) > Math.abs(axes[3] ?? 0) ? axes[1] ?? 0 : axes[3] ?? 0;
      if (axisX <= -STICK_THRESHOLD) activeActions.push("moveLeft");
      if (axisX >= STICK_THRESHOLD) activeActions.push("moveRight");
      if (axisY <= -STICK_THRESHOLD) activeActions.push("moveUp");
      if (axisY >= STICK_THRESHOLD) activeActions.push("moveDown");
      for (const action of DIGITAL_CONTROLLER_ACTIONS) {
        if (bindingPressed(controller.bindings[action], pressed)) {
          activeActions.push(action);
        }
      }

      const repeatState = gamepadRepeatRef.current;
      const uniqueActions = [...new Set(activeActions)];
      for (const action of uniqueActions) {
        const state = repeatState[action] ?? { pressed: false, lastAt: 0, nextDelay: GAMEPAD_REPEAT_INITIAL_MS };
        if (!state.pressed || now - state.lastAt >= state.nextDelay) {
          runControllerAction(action);
          repeatState[action] = { pressed: true, lastAt: now, nextDelay: state.pressed ? GAMEPAD_REPEAT_MS : GAMEPAD_REPEAT_INITIAL_MS };
        }
      }
      for (const action of Object.keys(repeatState)) {
        if (!uniqueActions.includes(action)) {
          repeatState[action] = { pressed: false, lastAt: 0, nextDelay: GAMEPAD_REPEAT_INITIAL_MS };
        }
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [controller, runControllerAction]);

  // ── Scroll grid focused cell into view
  useEffect(() => {
    if (viewMode !== "grid") return;
    const grid = gridRef.current;
    if (!grid) return;
    const focused = grid.querySelector<HTMLElement>('[data-focused="true"]');
    const span = startRuntimeInteraction("bp:grid-scroll-into-view", {
      tabId: currentTab?.id,
      focusedIndex,
      gridColumns
    });
    if (focused) {
      const gridRect = grid.getBoundingClientRect();
      const focusedRect = focused.getBoundingClientRect();
      if (focusedRect.top < gridRect.top + GRID_FOCUS_SCROLL_PAD) {
        grid.scrollTo({
          top: Math.max(0, grid.scrollTop + focusedRect.top - gridRect.top - GRID_FOCUS_SCROLL_PAD),
          behavior: reduceMotion ? "auto" : "smooth"
        });
      } else if (focusedRect.bottom > gridRect.bottom - GRID_FOCUS_SCROLL_PAD) {
        grid.scrollTo({
          top: grid.scrollTop + focusedRect.bottom - gridRect.bottom + GRID_FOCUS_SCROLL_PAD,
          behavior: reduceMotion ? "auto" : "smooth"
        });
      }
    }
    requestAnimationFrame(() => span.end(focused ? "ok" : "error", { hasFocusedCell: Boolean(focused) }));
  }, [currentTab?.id, focusedIndex, gridColumns, reduceMotion, viewMode]);

  // ── Track grid column count via ResizeObserver on the grid
  useEffect(() => {
    if (viewMode !== "grid") return;
    const grid = gridRef.current;
    if (!grid) return;
    const recompute = () => {
      const cell = grid.querySelector<HTMLElement>(".bp-grid-card");
      if (!cell) return;
      const cellW = cell.offsetWidth + 18; // gap
      const cols = Math.max(1, Math.round(grid.clientWidth / cellW));
      setGridColumns(cols);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [viewMode, currentTab]);

  const activateGame = useCallback((game: Game) => {
    if (canLaunch(game)) onLaunch(game);
    else onSelect(game);
  }, [onLaunch, onSelect]);

  const focusShelfIndex = useCallback((index: number) => {
    setTransitionDirection(index > focusedIndex ? "right" : "left");
    setFocusedIndex(index);
  }, [focusedIndex]);

  const focusGridIndex = useCallback((index: number) => {
    setTransitionDirection(index > focusedIndex ? "right" : "left");
    ensureGridRenderCount(index);
    setFocusedIndex(index);
  }, [ensureGridRenderCount, focusedIndex]);

  const handleGridScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const grid = event.currentTarget;
    if (grid.scrollTop + grid.clientHeight < grid.scrollHeight - 600) return;
    setGridRenderCount((current) => Math.min(currentGameCount, current + GRID_BATCH_ROWS * Math.max(1, gridColumns)));
  }, [currentGameCount, gridColumns]);

  const groupPointerX = tabs.length > 1 ? (tabIndex / (tabs.length - 1)) * 1.6 - 0.8 : 0;
  const currentTabIsGroup = currentTab?.id?.startsWith("group:");
  const isDefaultTab = currentTab?.id === defaultTabId;
  const motionDirection = reduceMotion ? "none" : transitionDirection;

  return (
    <div
      className={[
        viewMode === "grid" ? "big-picture grid-view" : "big-picture",
        settings?.bigPictureGrayscaleCovers === false ? "bp-no-cover-grayscale" : ""
      ].filter(Boolean).join(" ")}
      style={{
        "--bp-bg-base": backgroundBase,
        "--bp-glow-color": shelfGlowColor,
        "--bp-focused-index": clampedFocusedIndex,
        "--bp-window-start": shelfWindow.start
      } as CSSProperties}
    >
      <div className="bp-background" aria-hidden>
        <ProfileScope id="BigPictureColorBends">
          <ColorBends
            colors={animColors}
            speed={0.18}
            scale={1.2}
            frequency={1.1}
            warpStrength={1.1}
            mouseInfluence={1.4}
            parallax={0.6}
            noise={noiseOverride}
            iterations={3}
            intensity={1.25}
            bandWidth={7}
            autoRotate={4}
            transparent={true}
            pointerOverrideX={groupPointerX}
          />
        </ProfileScope>
        <div className="bp-vignette" />
      </div>

      <header className="bp-top">
        <div className="bp-tabs" role="tablist">
          <span className="bp-group-cue left">{bindingLabel(binding("previousGroup"))}</span>
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={i === tabIndex}
              className={i === tabIndex ? "bp-tab active" : "bp-tab"}
              onClick={() => switchTab(i)}
            >
              {tab.label}
              <span className="bp-tab-count">{tab.games.length}</span>
            </button>
          ))}
          <span className="bp-group-cue right">{bindingLabel(binding("nextGroup"))}</span>
        </div>
        <div className="bp-top-actions">
          {currentTabIsGroup && onSetDefaultTab ? (
            <button
              type="button"
              className={isDefaultTab ? "bp-favorite-tab active" : "bp-favorite-tab"}
              onClick={() => onSetDefaultTab(isDefaultTab ? undefined : currentTab!.id)}
              aria-label={isDefaultTab ? "Remove default startup tab" : "Set as default startup tab"}
              title={isDefaultTab ? "Remove as default startup tab" : "Set as default startup tab"}
            >
              {isDefaultTab ? <Star size={14} fill="currentColor" /> : <Plus size={14} />}
              <kbd>{bindingLabel(binding("favoriteTab"))}</kbd>
            </button>
          ) : null}
          <button
            type="button"
            className={activeFilterCount > 0 ? "bp-filter active" : "bp-filter"}
            onClick={onOpenFilters}
            aria-label="Filters"
          >
            <SlidersHorizontal size={16} />
            <span>Filter</span>
            <kbd>{bindingLabel(binding("filters"))}</kbd>
            {activeFilterCount > 0 ? <span className="bp-filter-badge">{activeFilterCount}</span> : null}
          </button>
          <button type="button" className="bp-exit" onClick={onExit} aria-label="Exit Big Picture (Esc)">
            <X size={18} />
            <span>Exit</span>
            <kbd>{bindingLabel(binding("exitBigPicture"))}</kbd>
          </button>
        </div>
      </header>

      <div className="bp-stage-viewport">
        <AnimatePresence initial={false} custom={motionDirection}>
          {viewMode === "shelf" ? (
            <motion.div
              key={`shelf-${currentTab?.id ?? "empty"}`}
              className="bp-view-stage bp-shelf-stage"
              custom={motionDirection}
              variants={SHELF_CONTENT_VARIANTS}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <ProfileScope id="BigPictureShelf">
              <section className="bp-hero">
                {focusedGame ? (
                  <div className="bp-hero-inner">
                    {focusedGame.logoUrl ? (
                      <img className="bp-hero-logo" src={focusedGame.logoUrl} alt={focusedGame.title} />
                    ) : (
                      <h1 className="bp-hero-title">{focusedGame.title}</h1>
                    )}
                    {focusedGame.shortDescription ? (
                      <p className="bp-hero-summary">{focusedGame.shortDescription}</p>
                    ) : null}
                    <div className="bp-hero-actions">
                      {focusedGame.id === "hynite:self" ? (
                        <button type="button" className="bp-play" onClick={() => void window.hynite.native.openExternal("https://github.com/yuma-dev/hynite/releases")}>
                          <Github size={20} />
                          <span>Download from Github</span>
                        </button>
                      ) : canLaunch(focusedGame) ? (
                        <button type="button" className="bp-play" onClick={() => onLaunch(focusedGame)}>
                          <Play size={20} fill="currentColor" />
                          <span>Play</span>
                          <kbd>{bindingLabel(binding("play"))}</kbd>
                        </button>
                      ) : (
                        <button type="button" className="bp-play secondary" onClick={() => onSelect(focusedGame)}>
                          <Info size={20} />
                          <span>View</span>
                          <kbd>{bindingLabel(binding("play"))}</kbd>
                        </button>
                      )}
                      {focusedGame.id !== "hynite:self" && (
                        <button type="button" className="bp-info" onClick={() => onSelect(focusedGame)} aria-label={canLaunch(focusedGame) ? "Details" : "Download / Install"}>
                          {canLaunch(focusedGame) ? <Info size={18} /> : <Download size={18} />}
                          <kbd>{bindingLabel(binding("details"))}</kbd>
                        </button>
                      )}
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="bp-row-wrap">
                <div className="bp-row">
                  <div className="bp-row-track">
                    {shelfGames.map((game, localIndex) => {
                      const absoluteIndex = shelfWindow.start + localIndex;
                      const isFocused = absoluteIndex === clampedFocusedIndex;
                      return (
                        <BigPictureShelfCard
                          key={game.id}
                          game={game}
                          absoluteIndex={absoluteIndex}
                          focused={isFocused}
                          cover={gameCoverUrl(game)}
                          imagePriority={isFocused ? "focused" : absoluteIndex > clampedFocusedIndex && absoluteIndex <= clampedFocusedIndex + 2 ? "near" : "lazy"}
                          onActivate={activateGame}
                          onFocus={focusShelfIndex}
                        />
                      );
                    })}
                  </div>
                </div>
              </section>
              </ProfileScope>
            </motion.div>
          ) : (
            <motion.section
              key={`grid-${currentTab?.id ?? "empty"}`}
              className="bp-view-stage bp-grid-wrap"
              custom={motionDirection}
              variants={GRID_CONTENT_VARIANTS}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <ProfileScope id="BigPictureGrid">
              <div className="bp-grid" ref={gridRef} onScroll={handleGridScroll}>
                {visibleGridGames.map((game, i) => (
                  <BigPictureGridCard
                    key={game.id}
                    game={game}
                    absoluteIndex={i}
                    focused={i === clampedFocusedIndex}
                    cover={gameCoverUrl(game)}
                    onActivate={activateGame}
                    onFocus={focusGridIndex}
                  />
                ))}
              </div>
              </ProfileScope>
            </motion.section>
          )}
        </AnimatePresence>
      </div>

    </div>
  );
}
