import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Play, X, Download, Info, SlidersHorizontal, Plus, Star } from "lucide-react";
import type { AppSettings, ControllerActionId, ControllerSettings, Game, GameGroup } from "@hynite/core";
import { expandPaletteToSlots, extractPalette, fallbackPalette, getCachedPalette, type CoverPalette, type PaletteDebugInfo } from "./colorExtract";
import { soundEngine } from "./sound";
import ColorBends from "./ColorBends";
import { bindingLabel, bindingPressed, normalizeControllerSettings, readGamepadState } from "./controllerInput";
import { isProfileEnabled } from "./startupProfile";
import { profileReactRender, startRuntimeInteraction, updateRuntimeProfileContext } from "./runtimeFrameProfile";

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

  const tabs: BigPictureTab[] = [];

  // Favorited group tab goes first if set
  if (defaultTabId) {
    const favIdx = groupTabs.findIndex((t) => t.id === defaultTabId);
    if (favIdx >= 0) tabs.push(...groupTabs.splice(favIdx, 1));
  }

  if (recentGames.length) {
    tabs.push({ id: "recent", label: "Recent", games: recentGames.slice(0, 30) });
  }
  const installed = games.filter((g) => g.installState === "installed");
  if (installed.length) {
    tabs.push({ id: "installed", label: "Installed", games: installed });
  }
  tabs.push({ id: "all", label: "All Games", games });
  tabs.push(...groupTabs);

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
  const [gridColumns, setGridColumns] = useState(6);
  const [transitionDirection, setTransitionDirection] = useState<TransitionDirection>("none");

  const rowRef = useRef<HTMLDivElement | null>(null);
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
  const focusedGame: Game | undefined = currentTab?.games[Math.min(focusedIndex, (currentTab?.games.length ?? 1) - 1)];
  currentTabIdRef.current = currentTab?.id;
  defaultTabIdRef.current = defaultTabId;
  const controller = useMemo<ControllerSettings>(() => normalizeControllerSettings(settings), [settings]);
  const binding = useCallback((action: ControllerActionId) => controller.bindings[action], [controller]);
  const reduceMotion = useReducedMotion();
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
    updateRuntimeProfileContext({
      bigPicture: true,
      area: "big-picture",
      totalGames: currentTab?.games.length ?? 0,
      visibleGames: currentTab?.games.length ?? 0,
      bpViewMode: viewMode,
      bpTabId: currentTab?.id,
      bpTabLabel: currentTab?.label,
      bpFocusedIndex: focusedIndex,
      bpFocusedTitle: focusedGame?.title,
      bpGridColumns: gridColumns
    });
  }, [currentTab?.games.length, currentTab?.id, currentTab?.label, focusedGame?.title, focusedIndex, gridColumns, viewMode]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [tabIndex, viewMode]);

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
        rowRef.current?.scrollTo({ left: 0, behavior: "auto" });
        gridRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
      return next;
    });
  }, [finishInteractionAfterTransition, tabs, viewMode]);

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
        rowRef.current?.scrollTo({ left: 0, behavior: "auto" });
        gridRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
      return next;
    });
  }, [finishInteractionAfterTransition, tabs, viewMode]);

  const enterGrid = useCallback(() => {
    setViewMode((mode) => {
      if (mode !== "grid") {
        finishInteractionAfterTransition(startRuntimeInteraction("bp:enter-grid", {
          tabId: currentTabIdRef.current,
          gameCount: currentTab?.games.length ?? 0,
          focusedIndex
        }), { gameCount: currentTab?.games.length ?? 0 });
        setTransitionDirection("down");
      }
      return "grid";
    });
  }, [currentTab?.games.length, finishInteractionAfterTransition, focusedIndex]);

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
      finishInteractionAfterTransition(startRuntimeInteraction(enteringGrid ? "bp:enter-grid" : "bp:exit-grid", {
        tabId: currentTabIdRef.current,
        gameCount: currentTab?.games.length ?? 0,
        focusedIndex,
        source: "toggle"
      }), { gameCount: currentTab?.games.length ?? 0 });
      setTransitionDirection(mode === "grid" ? "up" : "down");
      return mode === "grid" ? "shelf" : "grid";
    });
  }, [currentTab?.games.length, finishInteractionAfterTransition, focusedIndex]);

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
      if (viewMode === "shelf") {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          profileFocusMove("right");
          setTransitionDirection("right");
          setFocusedIndex((i) => Math.min(i + 1, count - 1));
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          profileFocusMove("left");
          setTransitionDirection("left");
          setFocusedIndex((i) => Math.max(i - 1, 0));
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
          setFocusedIndex((i) => Math.min(i + 1, count - 1));
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          profileFocusMove("left");
          setTransitionDirection("left");
          setFocusedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          profileFocusMove("down");
          setTransitionDirection("down");
          setFocusedIndex((i) => Math.min(i + gridColumns, count - 1));
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
            return Math.max(i - gridColumns, 0);
          });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [currentTab, enterGrid, exitGrid, focusedGame, profileFocusMove, shiftTab, viewMode, gridColumns, onExit, onLaunch, onSelect]);

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
      setFocusedIndex((i) => Math.min(i + 1, count - 1));
    }
    if (direction === "left") {
      profileFocusMove("left");
      setTransitionDirection("left");
      setFocusedIndex((i) => Math.max(i - 1, 0));
    }
    if (direction === "down") {
      profileFocusMove("down");
      setTransitionDirection("down");
      setFocusedIndex((i) => Math.min(i + gridColumns, count - 1));
    }
    if (direction === "up") {
      profileFocusMove("up");
      setTransitionDirection("up");
      setFocusedIndex((i) => {
        if (i < gridColumns) {
          exitGrid();
          return i;
        }
        return Math.max(i - gridColumns, 0);
      });
    }
  }, [currentTab?.games.length, enterGrid, exitGrid, gridColumns, profileFocusMove, viewMode]);

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

  // ── Scroll focused card flush to the left edge of the carousel.
  // Focus styling must not change row layout; otherwise scroll targets drift.
  useLayoutEffect(() => {
    rowRef.current?.scrollTo({ left: 0, behavior: "auto" });
    gridRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [currentTab?.id, viewMode]);

  useLayoutEffect(() => {
    if (viewMode !== "shelf") return;
    const row = rowRef.current;
    if (!row) return;
    const focused = row.querySelector<HTMLElement>('[data-focused="true"]');
    if (!focused) return;
    const rowStyle = getComputedStyle(row);
    const padLeft = parseFloat(rowStyle.paddingLeft) || 0;
    const targetLeft = focused.offsetLeft - padLeft;
    row.scrollTo({ left: Math.max(0, targetLeft), behavior: "auto" });
  }, [currentTab?.id, focusedIndex, viewMode]);

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
      style={{ "--bp-bg-base": backgroundBase } as CSSProperties}
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
            noise={0.6}
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
                      {canLaunch(focusedGame) ? (
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
                      <button type="button" className="bp-info" onClick={() => onSelect(focusedGame)} aria-label={canLaunch(focusedGame) ? "Details" : "Download / Install"}>
                        {canLaunch(focusedGame) ? <Info size={18} /> : <Download size={18} />}
                        <kbd>{bindingLabel(binding("details"))}</kbd>
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="bp-row-wrap">
                <div className="bp-row" ref={rowRef}>
                  {currentTab?.games.map((game, i) => {
                    const cover = gameCoverUrl(game);
                    const isFocused = i === focusedIndex;
                    return (
                      <button
                        key={game.id}
                        type="button"
                        data-focused={isFocused}
                        className={isFocused ? "bp-card focused" : "bp-card"}
                        onClick={() => {
                          if (i === focusedIndex && focusedGame) {
                            if (canLaunch(focusedGame)) onLaunch(focusedGame);
                            else onSelect(focusedGame);
                          } else {
                            setTransitionDirection(i > focusedIndex ? "right" : "left");
                            setFocusedIndex(i);
                          }
                        }}
                        aria-label={game.title}
                      >
                        {cover ? (
                          <img src={cover} alt="" loading="lazy" />
                        ) : (
                          <span className="bp-card-fallback">{game.title}</span>
                        )}
                      </button>
                    );
                  })}
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
              <div className="bp-grid" ref={gridRef}>
                {currentTab?.games.map((game, i) => {
                  const cover = gameCoverUrl(game);
                  const isFocused = i === focusedIndex;
                  return (
                    <button
                      key={game.id}
                      type="button"
                      data-focused={isFocused}
                      className={isFocused ? "bp-grid-card focused" : "bp-grid-card"}
                      onClick={() => {
                        if (i === focusedIndex && focusedGame) {
                          if (canLaunch(focusedGame)) onLaunch(focusedGame);
                          else onSelect(focusedGame);
                        } else {
                          setTransitionDirection(i > focusedIndex ? "right" : "left");
                          setFocusedIndex(i);
                        }
                      }}
                      aria-label={game.title}
                    >
                      <div className="bp-grid-card-cover">
                        {cover ? (
                          <img src={cover} alt="" loading="lazy" />
                        ) : (
                          <span className="bp-card-fallback">{game.title}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              </ProfileScope>
            </motion.section>
          )}
        </AnimatePresence>
      </div>

    </div>
  );
}
