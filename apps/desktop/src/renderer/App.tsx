import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  ExternalLink,
  Film,
  Gamepad2,
  Globe2,
  Home,
  Images,
  KeyRound,
  Library,
  Link2,
  LogOut,
  Monitor,
  Play,
  RefreshCw,
  Search,
  Settings,
  Trophy,
  Users,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { AppSettings, Game, GameDetail, HomeModel, InstallState, SourceImportResult, SourceMatch, SyncStatus } from "@hynite/core";

type Route = "home" | "library" | "settings";

const routes: Array<{ id: Route; label: string; icon: typeof Home }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "library", label: "Library", icon: Library },
  { id: "settings", label: "Settings", icon: Settings }
];

const HERO_AUTOPLAY_MS = 9000;
const HOME_ROW_BATCH_SIZE = 12;
const HOME_ROW_STEP_ITEMS = 3;

function fallbackArt(game: Game): CSSProperties {
  const seed = [...game.title].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const hue = seed % 360;
  return {
    "--cover-a": `oklch(0.48 0.12 ${hue})`,
    "--cover-b": `oklch(0.2 0.08 ${(hue + 80) % 360})`
  } as CSSProperties;
}

function primaryCover(game: Game): string | undefined {
  return game.libraryCapsuleUrl ?? game.coverUrl;
}

function heroStill(game: Game): string | undefined {
  return game.headerUrl ?? game.trailerPosterUrl ?? game.screenshots[0]?.fullUrl ?? game.backgroundUrl;
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

function steamStoreUrl(game: Game): string | undefined {
  const steamId = game.sourceIds.find((source) => source.provider === "steam")?.externalId;
  return game.discovery?.storeUrl ?? (steamId ? `https://store.steampowered.com/app/${encodeURIComponent(steamId)}` : undefined);
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

function heroMeta(game: Game): string[] {
  return [
    game.discovery?.storeCategory ?? game.discovery?.signal,
    game.discovery?.priceText,
    game.releaseDate ? `Released ${formatDate(game.releaseDate)}` : undefined,
    game.genres[0]
  ].filter(Boolean) as string[];
}

function GameCover({ game, onSelect, wide = false }: { game: Game; onSelect: (game: Game) => void; wide?: boolean }) {
  const info = [
    game.installState === "installed" ? "Installed" : "Not installed",
    game.genres[0],
    game.discovery?.signal,
    game.playtimeMinutes ? `${Math.round(game.playtimeMinutes / 60)}h` : undefined
  ]
    .filter(Boolean)
    .join(" · ");
  const cover = primaryCover(game);

  return (
    <button className={wide ? "wide-game" : "game-cover"} style={fallbackArt(game)} onClick={() => onSelect(game)}>
      <span className="cover-art" style={cover ? { backgroundImage: `url(${cover})` } : undefined}>
        <span className="cover-reveal">
          <span className="cover-title">{game.title}</span>
          <span className="cover-meta">{info}</span>
        </span>
      </span>
    </button>
  );
}

function GameRow({ title, games, onSelect }: { title: string; games: Game[]; onSelect: (game: Game) => void }) {
  const stripRef = useRef<HTMLDivElement | null>(null);
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
        <h2>{title}</h2>
      </div>
      <div className="cover-strip-shell">
        {canScrollLeft ? (
          <button className="row-arrow left" type="button" onClick={() => scrollByItems(-1)} aria-label={`Show previous ${title} games`}>
            <ChevronLeft size={18} />
          </button>
        ) : null}
        <div className="cover-strip" ref={stripRef} onScroll={onRowScroll}>
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

function Hero({
  home,
  settings,
  onSelect,
  onSync
}: {
  home?: HomeModel;
  settings?: AppSettings;
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
              <h1>{heroGame.title}</h1>
              <p>{heroGame.shortDescription || heroMeta(heroGame).join(" · ") || "Steam Store feature"}</p>
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
                <button className="secondary-action" onClick={() => onSelect(heroGame)}>
                  <BookOpen size={16} />
                  Info
                </button>
                {heroGame.discovery?.storeUrl ? (
                  <button className="secondary-action" onClick={() => openExternalUrl(heroGame.discovery?.storeUrl)}>
                    <ExternalLink size={16} />
                    {heroGame.discovery?.priceText ?? "Store"}
                  </button>
                ) : null}
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
          <Gamepad2 size={36} />
          <h1>Hynite</h1>
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
  onSelect,
  onSync
}: {
  home?: HomeModel;
  settings?: AppSettings;
  onSelect: (game: Game) => void;
  onSync: () => void;
}) {
  return (
    <main className="page">
      <Hero home={home} settings={settings} onSelect={onSelect} onSync={onSync} />
      <GameRow title="Recently played" games={home?.continuePlaying ?? []} onSelect={onSelect} />
      <GameRow title="Most played" games={home?.mostPlayed ?? []} onSelect={onSelect} />
    </main>
  );
}

function LibraryScreen({
  games,
  query,
  setQuery,
  sort,
  setSort,
  sortDirection,
  setSortDirection,
  installState,
  setInstallState,
  onSelect,
  onSync
}: {
  games: Game[];
  query: string;
  setQuery: (query: string) => void;
  sort: "recent" | "title" | "playtime" | "release";
  setSort: (sort: "recent" | "title" | "playtime" | "release") => void;
  sortDirection: "asc" | "desc";
  setSortDirection: (direction: "asc" | "desc") => void;
  installState: InstallState | "all";
  setInstallState: (state: InstallState | "all") => void;
  onSelect: (game: Game) => void;
  onSync: () => void;
}) {
  return (
    <main className="page">
      <div className="library-head">
        <div>
          <h1>Library</h1>
          <p>{games.length} games</p>
        </div>
        <div className="toolbar">
          <label className="search-box">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search library" />
          </label>
          <select className="plain-select" value={installState} onChange={(event) => setInstallState(event.target.value as InstallState | "all")}>
            <option value="all">All states</option>
            <option value="installed">Installed</option>
            <option value="not_installed">Not installed</option>
            <option value="unknown">Unknown</option>
          </select>
          <select className="plain-select" value={sort} onChange={(event) => setSort(event.target.value as "recent" | "title" | "playtime" | "release")}>
            <option value="title">Title</option>
            <option value="recent">Recent activity</option>
            <option value="playtime">Playtime</option>
            <option value="release">Release date</option>
          </select>
          <button className="secondary-action" onClick={() => setSortDirection(sortDirection === "asc" ? "desc" : "asc")}>
            {sortDirection === "asc" ? "Ascending" : "Descending"}
          </button>
          <button className="secondary-action" onClick={onSync}>
            <RefreshCw size={16} />
            Sync
          </button>
        </div>
      </div>
      {games.length === 0 ? (
        <div className="empty-state">
          <Library size={34} />
          <h2>No games imported</h2>
          <p>Steam sync imports owned games from your paired account.</p>
          <button className="primary-action" onClick={onSync}>
            <RefreshCw size={16} />
            Sync Steam
          </button>
        </div>
      ) : (
        <div className="library-grid">
          {games.map((game) => (
            <GameCover key={game.id} game={game} onSelect={onSelect} />
          ))}
        </div>
      )}
    </main>
  );
}

function SourcesScreen() {
  const [json, setJson] = useState("");
  const [url, setUrl] = useState("");
  const [searchTitle, setSearchTitle] = useState("");
  const [matches, setMatches] = useState<SourceMatch[]>([]);
  const [result, setResult] = useState<SourceImportResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function importJson(value: string) {
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await window.hynite.sources.import({ kind: "json", value }));
      setJson("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Source import failed.");
    }
  }

  async function importUrl() {
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await window.hynite.sources.import({ kind: "url", value: url }));
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Source import failed.");
    }
  }

  async function onFile(file?: File) {
    if (!file) {
      return;
    }
    await importJson(await file.text());
  }

  async function searchSources() {
    setError(undefined);
    try {
      setMatches(await window.hynite.sources.searchTitle(searchTitle));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Source search failed.");
    }
  }

  async function copy(text: string) {
    await window.hynite.clipboard.copy(text);
  }

  return (
    <div className="source-page settings-source-tab">
      <div className="screen-title">
        <h1>Sources</h1>
        <p>User-managed Hydra-compatible JSON sources. Imported links are only shown and copied.</p>
      </div>
      <section className="source-layout">
        <div className="source-panel">
          <h2>Import JSON</h2>
          <textarea value={json} onChange={(event) => setJson(event.target.value)} placeholder='{"name":"My source","downloads":[...]}' />
          <div className="source-actions">
            <label className="file-action">
              File
              <input type="file" accept="application/json,.json" onChange={(event) => void onFile(event.currentTarget.files?.[0])} />
            </label>
            <button className="primary-action" disabled={!json.trim()} onClick={() => void importJson(json)}>
              Import
            </button>
          </div>
        </div>
        <div className="source-panel">
          <h2>Import URL</h2>
          <input className="plain-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/source.json" />
          <button className="primary-action" disabled={!url.trim()} onClick={() => void importUrl()}>
            Import URL
          </button>
          {result ? (
            <p className="result-line">
              Imported {result.importedEntries} entries from {result.name}. Skipped {result.skippedEntries}.
            </p>
          ) : null}
          {error ? <p className="error-line">{error}</p> : null}
        </div>
      </section>
      <section className="source-search">
        <div className="section-head">
          <h2>Search sources</h2>
        </div>
        <div className="source-searchbar">
          <label className="search-box">
            <Search size={15} />
            <input value={searchTitle} onChange={(event) => setSearchTitle(event.target.value)} placeholder="Search by game title" />
          </label>
          <button className="primary-action" disabled={!searchTitle.trim()} onClick={() => void searchSources()}>
            Search
          </button>
        </div>
        <div className="source-results">
          {matches.length === 0 ? <p className="muted">No matches yet.</p> : null}
          {matches.map((match) => (
            <div className="match-row" key={match.id}>
              <div>
                <strong>{match.title}</strong>
                <span>
                  {match.sourceName} · {match.confidence} · {match.fileSize ?? "size unknown"}
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
          ))}
        </div>
      </section>
    </div>
  );
}

function progressText(status?: SyncStatus): string {
  if (!status) {
    return "Sync status unavailable";
  }
  const progress = status.total ? ` · ${status.current ?? 0}/${status.total}` : "";
  const last = status.lastSuccessAt ? ` · last ${formatDate(status.lastSuccessAt)}` : "";
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
            <span>{status?.total ? `${status.current ?? 0}/${status.total}` : "No active progress"}</span>
            <span>{status?.lastSuccessAt ? `Last success ${formatDate(status.lastSuccessAt)}` : "No successful sync yet"}</span>
          </div>
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
  const [apiKey, setApiKey] = useState("");
  const [steamGridDbKey, setSteamGridDbKey] = useState("");
  const [steamMessage, setSteamMessage] = useState<string | undefined>();
  const [metadataMessage, setMetadataMessage] = useState<string | undefined>();

  async function pairSteam() {
    setSteamMessage(undefined);
    const paired = await window.hynite.steam.pair();
    setSettings(await window.hynite.settings.get());
    setSteamMessage(`Paired Steam account ${paired.steamId}.`);
  }

  async function saveApiKey() {
    setSteamMessage(undefined);
    const next = await window.hynite.steam.saveApiKey(apiKey);
    setSettings(next);
    setApiKey("");
    setSteamMessage("Steam Web API key saved.");
  }

  async function disconnectSteam() {
    const next = await window.hynite.steam.disconnect();
    setSettings(next);
    setApiKey("");
    setSteamMessage("Steam account disconnected.");
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
        <span className={syncStatus?.active ? "status-dot active-sync" : "status-dot"} />
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
              <h2>Steam account</h2>
              <div className="steam-account-row">
                <div>
                  <strong>{settings?.steamAccount ? settings.steamAccount.steamId : "No account paired"}</strong>
                  <span>
                    {settings?.steamAccount?.webApiKey
                      ? "Ready to sync owned games, playtime, recent activity, and local install state"
                      : settings?.steamAccount
                        ? "Web API key required for owned games"
                        : "Use Steam login to pair an account"}
                  </span>
                </div>
                <div className="steam-actions">
                  <button className="secondary-action" onClick={() => void pairSteam()}>
                    <Link2 size={16} />
                    Pair
                  </button>
                  <button className="secondary-action" disabled={!settings?.steamAccount} onClick={() => void disconnectSteam()}>
                    <LogOut size={16} />
                    Disconnect
                  </button>
                </div>
              </div>
              <div className="api-key-row">
                <input
                  className="plain-input"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Steam Web API key"
                  disabled={!settings?.steamAccount}
                />
                <button className="primary-action" disabled={!settings?.steamAccount || !apiKey.trim()} onClick={() => void saveApiKey()}>
                  <KeyRound size={16} />
                  Save key
                </button>
              </div>
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
  reduceMotion,
  onClose,
  onChanged
}: {
  game: GameDetail;
  reduceMotion?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  type DetailMediaItem =
    | { kind: "trailer"; label: string; sourceUrl: string; posterUrl?: string }
    | { kind: "image"; label: string; sourceUrl: string; thumbnailUrl: string };
  const [viewer, setViewer] = useState<{ images: ImageViewerItem[]; index: number } | undefined>();

  async function copy(text: string) {
    await window.hynite.clipboard.copy(text);
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

  useEffect(() => {
    setMediaIndex(0);
  }, [game.id]);

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
                    <video controls playsInline poster={activeMedia.posterUrl}>
                      <source src={activeMedia.sourceUrl} />
                    </video>
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
                <div className="detail-action-row">
                  <button className="primary-action" disabled={!canLaunch(game)} onClick={() => void window.hynite.games.launch(game.id)}>
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
                  <dt>Added</dt>
                  <dd>{formatDate(game.addedAt) ?? "Unknown"}</dd>
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
              {game.sourceMatches.length === 0 ? (
                <p className="muted">No source matches.</p>
              ) : (
                game.sourceMatches.map((match) => (
                  <div className="match-row" key={match.id}>
                    <div>
                      <strong>{match.title}</strong>
                      <span>
                        {match.sourceName} / {match.confidence} / {match.fileSize ?? "size unknown"}
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
                ))
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
  const [selected, setSelected] = useState<GameDetail | undefined>();
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [syncStatus, setSyncStatus] = useState<SyncStatus | undefined>();
  const [query, setQuery] = useState("");
  const [librarySort, setLibrarySort] = useState<"recent" | "title" | "playtime" | "release">("title");
  const [librarySortDirection, setLibrarySortDirection] = useState<"asc" | "desc">("asc");
  const [libraryInstallState, setLibraryInstallState] = useState<InstallState | "all">("all");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [nextGames, nextRecentGames, nextHome, nextSettings] = await Promise.all([
      window.hynite.library.list({ search: query, sort: librarySort, sortDirection: librarySortDirection, installState: libraryInstallState }),
      window.hynite.library.list({ search: "", sort: "recent", installState: "all" }),
      window.hynite.home.get(),
      window.hynite.settings.get()
    ]);
    setGames(nextGames);
    setRecentGames(nextRecentGames);
    setHome(nextHome);
    setSettings(nextSettings);
  }

  useEffect(() => {
    void refresh();
    void window.hynite.sync.status().then(setSyncStatus);
    return window.hynite.sync.onStatusChanged((status) => {
      setSyncStatus(status);
      if (!status.active && status.phase === "complete") {
        void refresh();
      }
    });
  }, []);

  useEffect(() => {
    void window.hynite.library.list({ search: query, sort: librarySort, sortDirection: librarySortDirection, installState: libraryInstallState }).then(setGames);
  }, [query, librarySort, librarySortDirection, libraryInstallState]);

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
      setSelected({ ...game, sourceMatches: await window.hynite.sources.searchTitle(game.title) });
    }
  }

  const routeContent = useMemo(() => {
    if (route === "home") {
      return <HomeScreen home={home} settings={settings} onSelect={(game) => void selectGame(game)} onSync={() => void syncSteam()} />;
    }
    if (route === "library") {
      return (
        <LibraryScreen
          games={games}
          query={query}
          setQuery={setQuery}
          sort={librarySort}
          setSort={setLibrarySort}
          sortDirection={librarySortDirection}
          setSortDirection={setLibrarySortDirection}
          installState={libraryInstallState}
          setInstallState={setLibraryInstallState}
          onSelect={(game) => void selectGame(game)}
          onSync={() => void syncSteam()}
        />
      );
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
        onSeed={() => void window.hynite.debug.seed().then(refresh)}
      />
    );
  }, [route, home, games, query, settings, syncStatus, librarySort, librarySortDirection, libraryInstallState]);

  return (
    <div className="app-shell">
      <div className="app-body">
        <aside className="rail">
          <div className="rail-brand">HYNITE</div>
          {routes.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={route === item.id ? "active" : ""} onClick={() => setRoute(item.id)}>
                <Icon size={17} />
                {item.label}
              </button>
            );
          })}
          <button className="rail-sync" disabled={busy} onClick={() => void syncSteam()}>
            <RefreshCw size={15} />
            {busy ? "Syncing" : "Steam sync"}
          </button>
          <div className="rail-section">
            <p>Recent</p>
            <div className="recent-list">
              {recentGames.slice(0, 30).map((game) => (
                <button key={game.id} className="recent-link" onClick={() => void selectGame(game)}>
                  <span className={game.communityIconUrl ? "recent-icon has-image" : "recent-icon"} style={!game.communityIconUrl ? fallbackArt(game) : undefined}>
                    {game.communityIconUrl ? <img src={game.communityIconUrl} alt="" /> : null}
                  </span>
                  <span>
                    <strong>{game.title}</strong>
                    <em>{activityLabel(game)}</em>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </aside>
        <section className="content">{routeContent}</section>
        <AnimatePresence>
          {selected ? <DetailOverlay game={selected} reduceMotion={settings?.reduceMotion} onClose={() => setSelected(undefined)} onChanged={() => void refresh()} /> : null}
        </AnimatePresence>
      </div>
      <footer className="statusbar">
        <span className="status-dot" />
        <span>{games.length} games</span>
        <span>{home?.stale ? "cached discovery" : "online discovery"}</span>
        <span>v0.1.0</span>
      </footer>
    </div>
  );
}
