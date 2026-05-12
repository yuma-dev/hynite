import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Play, X, Download, Info, SlidersHorizontal } from "lucide-react";
import type { AppSettings, Game, GameGroup } from "@hynite/core";
import { expandPaletteToSlots, extractPalette, getCachedPalette, paletteFromSeed, type CoverPalette } from "./colorExtract";
import { soundEngine } from "./sound";
import ColorBends from "./ColorBends";

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
  onExit: () => void;
};

type ViewMode = "shelf" | "grid";

const PALETTE_DEBOUNCE_MS = 250;
const PALETTE_TWEEN_MS = 700;
// Total color slots passed to the ColorBends shader. Dominant colors fill
// more slots, giving them proportionally more visual weight.
const COLOR_SLOTS = 8;

function gameCoverUrl(game: Game): string | undefined {
  return game.libraryCapsuleUrl ?? game.coverUrl ?? game.headerUrl;
}

function gameHeroUrl(game: Game): string | undefined {
  return game.backgroundUrl ?? game.headerUrl ?? game.trailerPosterUrl ?? game.screenshots[0]?.fullUrl;
}

function canLaunch(game: Game): boolean {
  return game.installState === "installed";
}

function buildTabs(
  games: Game[],
  recentGames: Game[],
  groups: GameGroup[],
  groupGames: Map<string, Game[]>
): BigPictureTab[] {
  const tabs: BigPictureTab[] = [];
  if (recentGames.length) {
    tabs.push({ id: "recent", label: "Recent", games: recentGames.slice(0, 30) });
  }
  const installed = games.filter((g) => g.installState === "installed");
  if (installed.length) {
    tabs.push({ id: "installed", label: "Installed", games: installed });
  }
  tabs.push({ id: "all", label: "All Games", games });
  for (const group of groups) {
    const list = groupGames.get(group.id);
    if (!list || list.length === 0) continue;
    tabs.push({ id: `group:${group.id}`, label: group.name, games: list });
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
  onExit
}: Props) {
  const groups = useMemo<GameGroup[]>(() => settings?.gameGroups ?? [], [settings]);
  const tabs = useMemo(
    () => buildTabs(games, recentGames, groups, groupGames),
    [games, recentGames, groups, groupGames]
  );

  const [tabIndex, setTabIndex] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("shelf");
  const [gridColumns, setGridColumns] = useState(6);

  const rowRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const navSoundReadyRef = useRef(false);

  const currentTab = tabs[Math.min(tabIndex, tabs.length - 1)];
  const focusedGame: Game | undefined = currentTab?.games[Math.min(focusedIndex, (currentTab?.games.length ?? 1) - 1)];

  useEffect(() => {
    setFocusedIndex(0);
  }, [tabIndex, viewMode]);

  // ── Palette: hash-based fallback is instant. Real extraction is debounced
  // and tweened toward over PALETTE_TWEEN_MS via rAF. We tween across a fixed
  // COLOR_SLOTS so dominant colors keep their proportional share.
  const targetPaletteRef = useRef<CoverPalette>(paletteFromSeed("hynite"));
  const tweenFromRef = useRef<Rgb[]>(paletteToSlots(targetPaletteRef.current));
  const tweenToRef = useRef<Rgb[]>(paletteToSlots(targetPaletteRef.current));
  const tweenStartRef = useRef<number>(performance.now());
  const initialSlots = paletteToSlots(targetPaletteRef.current).map(rgbToHex);
  const [animColors, setAnimColors] = useState<string[]>(initialSlots);

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
  }, [palettesEqual]);

  useEffect(() => {
    let raf = 0;
    let lastKey: string | undefined;
    const loop = () => {
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
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!focusedGame) return;
    // 1. Instant hash-based palette so something always changes.
    const seed = `${focusedGame.id}::${focusedGame.title}`;
    const seeded = paletteFromSeed(seed);

    // 2. If the cover already has an extracted palette cached, use it now.
    const url = gameCoverUrl(focusedGame) ?? gameHeroUrl(focusedGame);
    const cached = url ? getCachedPalette(url) : undefined;
    if (cached) {
      setTargetPalette(cached);
    } else {
      setTargetPalette(seeded);
    }

    // 3. Debounce real extraction so quick flicks don't churn.
    if (!url) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void extractPalette(url).then((next) => {
        if (cancelled) return;
        if (next) setTargetPalette(next);
        // If extraction returns undefined the seeded palette stays — already set above.
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
          setViewMode("shelf");
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
        setTabIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "]" || event.key === "e" || event.key === "E") {
        event.preventDefault();
        setTabIndex((i) => Math.min(i + 1, tabs.length - 1));
        return;
      }

      const count = currentTab?.games.length ?? 0;
      if (viewMode === "shelf") {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setFocusedIndex((i) => Math.min(i + 1, count - 1));
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setFocusedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setViewMode("grid");
          return;
        }
      } else {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setFocusedIndex((i) => Math.min(i + 1, count - 1));
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setFocusedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setFocusedIndex((i) => Math.min(i + gridColumns, count - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setFocusedIndex((i) => {
            if (i < gridColumns) {
              setViewMode("shelf");
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
  }, [currentTab, focusedGame, tabs.length, viewMode, gridColumns, onExit, onLaunch, onSelect]);

  // ── Scroll focused card flush to the left edge of the carousel
  useEffect(() => {
    if (viewMode !== "shelf") return;
    const row = rowRef.current;
    if (!row) return;
    const focused = row.querySelector<HTMLElement>('[data-focused="true"]');
    if (!focused) return;
    const focusedLeft = focused.offsetLeft;
    const rowStyle = getComputedStyle(row);
    const padLeft = parseFloat(rowStyle.paddingLeft) || 0;
    row.scrollTo({ left: focusedLeft - padLeft, behavior: "smooth" });
  }, [focusedIndex, tabIndex, viewMode]);

  // ── Scroll grid focused cell into view
  useEffect(() => {
    if (viewMode !== "grid") return;
    const grid = gridRef.current;
    if (!grid) return;
    const focused = grid.querySelector<HTMLElement>('[data-focused="true"]');
    focused?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIndex, viewMode, tabIndex]);

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

  return (
    <div className={viewMode === "grid" ? "big-picture grid-view" : "big-picture"}>
      <div className="bp-background" aria-hidden>
        <ColorBends
          colors={animColors}
          speed={0.18}
          scale={1.2}
          frequency={1.1}
          warpStrength={1.1}
          mouseInfluence={1.4}
          parallax={0.6}
          noise={0.08}
          iterations={3}
          intensity={1.4}
          bandWidth={7}
          autoRotate={4}
          transparent={false}
        />
        <div className="bp-vignette" />
      </div>

      <header className="bp-top">
        <div className="bp-tabs" role="tablist">
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={i === tabIndex}
              className={i === tabIndex ? "bp-tab active" : "bp-tab"}
              onClick={() => setTabIndex(i)}
            >
              {tab.label}
              <span className="bp-tab-count">{tab.games.length}</span>
            </button>
          ))}
        </div>
        <div className="bp-top-actions">
          <button
            type="button"
            className={activeFilterCount > 0 ? "bp-filter active" : "bp-filter"}
            onClick={onOpenFilters}
            aria-label="Filters"
          >
            <SlidersHorizontal size={16} />
            <span>Filter</span>
            {activeFilterCount > 0 ? <span className="bp-filter-badge">{activeFilterCount}</span> : null}
          </button>
          <button type="button" className="bp-exit" onClick={onExit} aria-label="Exit Big Picture (Esc)">
            <X size={18} />
            <span>Exit</span>
          </button>
        </div>
      </header>

      {viewMode === "shelf" ? (
        <>
          <section className="bp-hero">
            <AnimatePresence mode="wait">
              {focusedGame ? (
                <motion.div
                  key={focusedGame.id}
                  className="bp-hero-inner"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 14 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                >
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
                      </button>
                    ) : (
                      <button type="button" className="bp-play secondary" onClick={() => onSelect(focusedGame)}>
                        <Download size={20} />
                        <span>View</span>
                      </button>
                    )}
                    <button type="button" className="bp-info" onClick={() => onSelect(focusedGame)} aria-label="Details">
                      <Info size={18} />
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
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
        </>
      ) : (
        <section className="bp-grid-wrap">
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
        </section>
      )}

      <footer className="bp-footer">
        <span className="bp-hint">
          ← → games · [ ] tabs · {viewMode === "shelf" ? "↓ grid" : "↑ shelf"} · Enter play · Esc {viewMode === "grid" ? "back" : "exit"}
        </span>
        <span className="bp-position">
          {currentTab && currentTab.games.length > 0
            ? `${Math.min(focusedIndex, currentTab.games.length - 1) + 1} / ${currentTab.games.length}`
            : "—"}
        </span>
      </footer>
    </div>
  );
}
