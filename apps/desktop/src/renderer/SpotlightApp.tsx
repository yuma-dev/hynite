import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { SpotlightSearchResult } from "@hynite/core";
import type { LaunchOutcome } from "../preload";
import { soundEngine } from "./sound";

const PAGE_SIZE = 30;
const LOAD_MORE_THRESHOLD_PX = 32;
function sourceText(result: SpotlightSearchResult): string {
  const source = result.sourceLabels.length ? result.sourceLabels.join(", ") : "library";
  const state = result.installState === "installed"
    ? "Installed"
    : result.installState === "not_installed"
      ? "Not installed"
      : "Unknown";
  const ownership = result.ownership === "family" ? " / Family shared" : "";
  return `${state}${ownership} / ${source}`;
}

export function SpotlightApp() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const resultsLengthRef = useRef(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpotlightSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [launchHandoff, setLaunchHandoff] = useState<SpotlightSearchResult | undefined>();
  const [showKey, setShowKey] = useState(0);
  const [panelReady, setPanelReady] = useState(true);
  const selected = results[selectedIndex];

  useEffect(() => {
    resultsLengthRef.current = results.length;
  }, [results.length]);

  const runSearch = useCallback((value: string, options: { append?: boolean; offset?: number } = {}) => {
    const offset = options.append ? (options.offset ?? resultsLengthRef.current) : 0;
    if (options.append) setLoadingMore(true);
    void window.hynite.spotlight.search(value, { limit: PAGE_SIZE, offset })
      .then((next) => {
        setHasMore(next.length === PAGE_SIZE);
        setResults((current) => options.append ? [...current, ...next] : next);
        if (!options.append) {
          setSelectedIndex(0);
        } else {
          setSelectedIndex((current) => Math.min(current, Math.max(0, offset + next.length - 1)));
        }
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Search failed.");
      })
      .finally(() => {
        if (options.append) setLoadingMore(false);
      });
  }, []);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return;
    runSearch(query, { append: true, offset: resultsLengthRef.current });
  }, [hasMore, loadingMore, query, runSearch]);

  useEffect(() => {
    void window.hynite.settings.get().then((settings) => {
      soundEngine.applySettings(settings);
    }).catch(() => undefined);
    runSearch("");

    const stopOnHide = window.hynite.spotlight.onHide(() => {
      setPanelReady(false);
    });

    const stopOnShow = window.hynite.spotlight.onShow(() => {
      setMessage(undefined);
      setLaunchHandoff(undefined);
      void window.hynite.spotlight.setLaunchHandoffActive(false).catch(() => undefined);
      setQuery("");
      setSelectedIndex(0);
      setShowKey((k) => k + 1);
      setPanelReady(true);
      runSearch("");
      requestAnimationFrame(() => inputRef.current?.focus());
    });

    return () => {
      stopOnHide();
      stopOnShow();
    };
  }, [runSearch]);

  useEffect(() => {
    return window.hynite.spotlight.onLaunchHandoffBlur(() => {
      setLaunchHandoff(undefined);
    });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => runSearch(query), 20);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => {
    const row = selected ? rowRefs.current.get(selected.id) : undefined;
    row?.scrollIntoView({ block: "nearest" });
    if (selectedIndex >= results.length - 3) {
      loadMore();
    }
  }, [loadMore, results.length, selected, selectedIndex]);

  const emptyText = useMemo(() => {
    if (results.length > 0) return undefined;
    return query.trim() ? "No games found" : "No library games";
  }, [query, results.length]);

  async function openDetails(gameId: string): Promise<void> {
    await window.hynite.spotlight.openDetails(gameId);
  }

  async function activate(result: SpotlightSearchResult | undefined): Promise<void> {
    if (!result || loading) return;
    setMessage(undefined);
    setLoading(true);
    try {
      if (!result.launchable) {
        await openDetails(result.id);
        return;
      }
      setLaunchHandoff(result);
      await window.hynite.spotlight.setLaunchHandoffActive(true);
      const outcome: LaunchOutcome = await window.hynite.spotlight.launch(result.id);
      if (outcome.kind === "no-account") {
        setLaunchHandoff(undefined);
        await window.hynite.spotlight.setLaunchHandoffActive(false);
        setMessage(outcome.reason);
      } else if (outcome.kind === "requires-switch") {
        setLaunchHandoff(undefined);
        await window.hynite.spotlight.setLaunchHandoffActive(false);
        await window.hynite.spotlight.hide();
      } else if (outcome.kind === "launched") {
        soundEngine.play("gameLaunch");
      }
    } catch (error) {
      setLaunchHandoff(undefined);
      await window.hynite.spotlight.setLaunchHandoffActive(false);
      setMessage(error instanceof Error ? error.message : "Launch failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className={launchHandoff ? "spotlight-root launching" : "spotlight-root"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void window.hynite.spotlight.hide();
        } else if (event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "n")) {
          event.preventDefault();
          setSelectedIndex((current) => Math.min(results.length - 1, current + 1));
        } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p")) {
          event.preventDefault();
          setSelectedIndex((current) => Math.max(0, current - 1));
        } else if (event.key === "Enter") {
          event.preventDefault();
          void activate(selected);
        }
      }}
    >
      {launchHandoff ? (
        <section className="spotlight-launch-handoff" aria-hidden="true">
          <div className="spotlight-launch-identity">
            {launchHandoff.logoUrl ? (
              <img className="spotlight-launch-logo" src={launchHandoff.logoUrl} alt="" draggable={false} />
            ) : (
              <h1>{launchHandoff.title}</h1>
            )}
            <span className="spotlight-launch-line">
              <span />
            </span>
          </div>
        </section>
      ) : panelReady ? (
        <section key={showKey} className="spotlight-panel">
          <label className="spotlight-search">
            <Search size={18} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setSelectedIndex(0);
                setMessage(undefined);
              }}
              placeholder="Search games"
              autoFocus
            />
          </label>

          <div
            className="spotlight-list"
            role="listbox"
            aria-label="Games"
            onScroll={(event) => {
              const target = event.currentTarget;
              if (target.scrollHeight - target.scrollTop - target.clientHeight <= LOAD_MORE_THRESHOLD_PX) {
                loadMore();
              }
            }}
          >
            {results.map((result, index) => (
              <button
                key={result.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(result.id, node);
                  else rowRefs.current.delete(result.id);
                }}
                type="button"
                className={index === selectedIndex ? "spotlight-row active" : "spotlight-row"}
                onPointerEnter={() => setSelectedIndex(index)}
                onClick={() => void activate(result)}
                role="option"
                aria-selected={index === selectedIndex}
              >
                <span className={result.iconUrl ? "spotlight-icon has-image" : "spotlight-icon"}>
                  {result.iconUrl ? <img src={result.iconUrl} alt="" draggable={false} /> : result.title.slice(0, 1)}
                </span>
                <span className="spotlight-copy">
                  <strong>{result.title}</strong>
                  <em>{sourceText(result)}</em>
                </span>
                <span className="spotlight-action">{result.launchable ? "Launch" : "Details"}</span>
              </button>
            ))}
            {emptyText ? <div className="spotlight-empty">{emptyText}</div> : null}
            {loadingMore ? <div className="spotlight-loading">Loading more...</div> : null}
          </div>

          <footer className="spotlight-footer">
            <span>{message ?? (loading ? "Working..." : "Enter to launch, Esc to close")}</span>
          </footer>
        </section>
      ) : null}
    </main>
  );
}
