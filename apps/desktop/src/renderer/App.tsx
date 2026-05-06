import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  Clipboard,
  Download,
  Gamepad2,
  Home,
  Library,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { AppSettings, Game, GameDetail, HomeModel, SourceImportResult, SourceMatch } from "@hynite/core";

type Route = "home" | "library" | "discover" | "sources" | "settings";

const routes: Array<{ id: Route; label: string; icon: typeof Home }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "library", label: "Library", icon: Library },
  { id: "discover", label: "Discover", icon: Sparkles },
  { id: "sources", label: "Sources", icon: Download },
  { id: "settings", label: "Settings", icon: Settings }
];

function fallbackArt(game: Game): CSSProperties {
  const seed = [...game.title].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const hue = seed % 360;
  return {
    "--cover-a": `oklch(0.48 0.12 ${hue})`,
    "--cover-b": `oklch(0.2 0.08 ${(hue + 80) % 360})`
  } as CSSProperties;
}

function coverGlow(game?: Game): CSSProperties {
  if (!game) {
    return { "--glow": "rgba(255,255,255,0.12)" } as CSSProperties;
  }
  const seed = [...game.title].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return { "--glow": `oklch(0.58 0.12 ${seed % 360} / 0.55)` } as CSSProperties;
}

function GameCover({ game, onSelect, wide = false }: { game: Game; onSelect: (game: Game) => void; wide?: boolean }) {
  const info = [
    game.installState === "installed" ? "Installed" : "Not installed",
    game.genres[0],
    game.playtimeMinutes ? `${Math.round(game.playtimeMinutes / 60)}h` : undefined
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button className={wide ? "wide-game" : "game-cover"} style={{ ...fallbackArt(game), ...coverGlow(game) }} onClick={() => onSelect(game)}>
      <span className="cover-art" style={game.coverUrl ? { backgroundImage: `url(${game.coverUrl})` } : undefined}>
        <span className="cover-reveal">
          <span className="cover-title">{game.title}</span>
          <span className="cover-meta">{info}</span>
        </span>
      </span>
    </button>
  );
}

function GameRow({ title, games, onSelect }: { title: string; games: Game[]; onSelect: (game: Game) => void }) {
  if (games.length === 0) {
    return null;
  }

  return (
    <motion.section className="game-row" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      <div className="cover-strip">
        {games.map((game) => (
          <GameCover key={game.id} game={game} onSelect={onSelect} />
        ))}
      </div>
    </motion.section>
  );
}

function Hero({ home, onSelect, onSync }: { home?: HomeModel; onSelect: (game: Game) => void; onSync: () => void }) {
  const heroGame = home?.continuePlaying[0] ?? home?.popularNow[0] ?? home?.recommended[0];

  return (
    <section className="hero" style={coverGlow(heroGame)}>
      <div className="hero-glow hero-glow-a" />
      <div className="hero-glow hero-glow-b" />
      {heroGame ? (
        <>
          <button className="hero-cover" style={fallbackArt(heroGame)} onClick={() => onSelect(heroGame)}>
            <span style={heroGame.coverUrl ? { backgroundImage: `url(${heroGame.coverUrl})` } : undefined} />
          </button>
          <div className="hero-copy">
            <p className="eyebrow">{heroGame.installState === "installed" ? "Continue playing" : "Popular now"}</p>
            <h1>{heroGame.title}</h1>
            <p>
              {[heroGame.genres[0], heroGame.developers[0], heroGame.releaseDate].filter(Boolean).join(" · ") || "Steam discovery"}
            </p>
            <div className="hero-actions">
              <button className="primary-action" onClick={() => (heroGame.installState === "installed" ? window.hynite.games.launch(heroGame.id) : onSelect(heroGame))}>
                <Play size={16} />
                {heroGame.installState === "installed" ? "Play" : "Details"}
              </button>
              <button className="secondary-action" onClick={() => onSelect(heroGame)}>
                <BookOpen size={16} />
                Info
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="hero-empty">
          <Gamepad2 size={36} />
          <h1>Hynite</h1>
          <p>Sync Steam to build the first library view.</p>
          <button className="primary-action" onClick={onSync}>
            <RefreshCw size={16} />
            Sync Steam
          </button>
        </div>
      )}
    </section>
  );
}

function HomeScreen({ home, onSelect, onSync }: { home?: HomeModel; onSelect: (game: Game) => void; onSync: () => void }) {
  return (
    <main className="page">
      <Hero home={home} onSelect={onSelect} onSync={onSync} />
      <GameRow title="Jump back in" games={home?.continuePlaying ?? []} onSelect={onSelect} />
      <GameRow title="Recommended for you" games={home?.recommended ?? []} onSelect={onSelect} />
      <GameRow title="Popular now" games={home?.popularNow ?? []} onSelect={onSelect} />
    </main>
  );
}

function LibraryScreen({
  games,
  query,
  setQuery,
  onSelect,
  onSync
}: {
  games: Game[];
  query: string;
  setQuery: (query: string) => void;
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
          <p>Steam sync will scan installed app manifests from your Steam libraries.</p>
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

function DiscoverScreen({ home, onSelect }: { home?: HomeModel; onSelect: (game: Game) => void }) {
  return (
    <main className="page">
      <div className="screen-title">
        <h1>Discover</h1>
        <p>{home?.stale ? "Showing cached Steam discovery data" : "Steam-powered popular and local-taste rows"}</p>
      </div>
      <GameRow title="Popular now" games={home?.popularNow ?? []} onSelect={onSelect} />
      <GameRow title="Recommended" games={home?.recommended ?? []} onSelect={onSelect} />
      <GameRow title="New and notable" games={home?.newAndNotable ?? []} onSelect={onSelect} />
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
    <main className="page source-page">
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
    </main>
  );
}

function SettingsScreen({
  settings,
  setSettings,
  onSeed
}: {
  settings?: AppSettings;
  setSettings: (settings: AppSettings) => void;
  onSeed: () => void;
}) {
  const [roots, setRoots] = useState(settings?.steamLibraryRoots.join("\n") ?? "");

  useEffect(() => {
    setRoots(settings?.steamLibraryRoots.join("\n") ?? "");
  }, [settings]);

  async function save() {
    const next = await window.hynite.settings.update({
      steamLibraryRoots: roots
        .split("\n")
        .map((root) => root.trim())
        .filter(Boolean)
    });
    setSettings(next);
  }

  return (
    <main className="page settings-page">
      <div className="screen-title">
        <h1>Settings</h1>
        <p>Steam roots are optional. Hynite also scans common Windows Steam paths.</p>
      </div>
      <section className="settings-section">
        <h2>Steam library roots</h2>
        <textarea value={roots} onChange={(event) => setRoots(event.target.value)} placeholder="D:\\SteamLibrary" />
        <button className="primary-action" onClick={() => void save()}>
          Save
        </button>
      </section>
      <section className="settings-section">
        <h2>Development</h2>
        <button className="secondary-action" onClick={onSeed}>
          Add demo game
        </button>
      </section>
    </main>
  );
}

function DetailOverlay({ game, onClose, onChanged }: { game: GameDetail; onClose: () => void; onChanged: () => void }) {
  async function copy(text: string) {
    await window.hynite.clipboard.copy(text);
  }

  return (
    <AnimatePresence>
      <motion.aside className="detail-overlay" style={coverGlow(game)} initial={{ x: 460 }} animate={{ x: 0 }} exit={{ x: 460 }} transition={{ duration: 0.26 }}>
        <div className="detail-hero">
          <div className="detail-glow" />
          <button className="close-button" onClick={onClose}>
            <X size={18} />
          </button>
          <div className="detail-cover" style={fallbackArt(game)}>
            <span style={game.coverUrl ? { backgroundImage: `url(${game.coverUrl})` } : undefined} />
          </div>
          <p className="eyebrow">Game info</p>
          <h1>{game.title}</h1>
          <p>{[game.developers[0], game.genres[0], game.releaseDate].filter(Boolean).join(" · ")}</p>
          <button className="primary-action" disabled={game.installState !== "installed"} onClick={() => void window.hynite.games.launch(game.id)}>
            <Play size={16} />
            Play
          </button>
        </div>
        <div className="detail-section">
          <h2>Metadata</h2>
          <dl>
            <div>
              <dt>Provider</dt>
              <dd>{game.sourceIds.map((source) => source.provider).join(", ")}</dd>
            </div>
            <div>
              <dt>Playtime</dt>
              <dd>{game.playtimeMinutes ? `${Math.round(game.playtimeMinutes / 60)}h` : "None"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{game.metadataStatus}</dd>
            </div>
          </dl>
        </div>
        <div className="detail-section source-matches">
          <h2>Download options</h2>
          {game.sourceMatches.length === 0 ? (
            <p className="muted">No source matches.</p>
          ) : (
            game.sourceMatches.map((match) => (
              <div className="match-row" key={match.id}>
                <div>
                  <strong>{match.title}</strong>
                  <span>
                    {match.sourceName} · {match.confidence} · {match.fileSize ?? "size unknown"}
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
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>("home");
  const [home, setHome] = useState<HomeModel | undefined>();
  const [games, setGames] = useState<Game[]>([]);
  const [selected, setSelected] = useState<GameDetail | undefined>();
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [nextGames, nextHome, nextSettings] = await Promise.all([
      window.hynite.library.list({ search: query, sort: "title", installState: "all" }),
      window.hynite.home.get(),
      window.hynite.settings.get()
    ]);
    setGames(nextGames);
    setHome(nextHome);
    setSettings(nextSettings);
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    void window.hynite.library.list({ search: query, sort: "title", installState: "all" }).then(setGames);
  }, [query]);

  async function syncSteam() {
    setBusy(true);
    try {
      await window.hynite.library.sync("steam");
      await refresh();
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
      return <HomeScreen home={home} onSelect={(game) => void selectGame(game)} onSync={() => void syncSteam()} />;
    }
    if (route === "library") {
      return <LibraryScreen games={games} query={query} setQuery={setQuery} onSelect={(game) => void selectGame(game)} onSync={() => void syncSteam()} />;
    }
    if (route === "discover") {
      return <DiscoverScreen home={home} onSelect={(game) => void selectGame(game)} />;
    }
    if (route === "sources") {
      return <SourcesScreen />;
    }
    return <SettingsScreen settings={settings} setSettings={setSettings} onSeed={() => void window.hynite.debug.seed().then(refresh)} />;
  }, [route, home, games, query, settings]);

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
            {games.slice(0, 5).map((game) => (
              <button key={game.id} className="recent-link" onClick={() => void selectGame(game)}>
                {game.title}
              </button>
            ))}
          </div>
        </aside>
        <section className="content">{routeContent}</section>
        {selected ? <DetailOverlay game={selected} onClose={() => setSelected(undefined)} onChanged={() => void refresh()} /> : null}
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
