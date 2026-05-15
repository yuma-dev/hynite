import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Folder as FolderIcon,
  FolderPlus,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, Game, LocalRoot } from "@hynite/core";

type IdentifyCandidateLite = {
  provider: "steam" | "igdb";
  externalId: string;
  title: string;
  coverUrl?: string;
  releaseDate?: string;
};

type IdentificationResult =
  | { kind: "match"; match: { provider: "steam" | "igdb"; externalId: string; title: string; confidence: number; reason: string } }
  | { kind: "ambiguous"; candidates: IdentifyCandidateLite[]; topConfidence: number }
  | { kind: "unmatched"; reason: string };

type ProbeResult = {
  folderPath: string;
  folderName: string;
  candidateId: string;
  exeOptions: Array<{
    path: string;
    size: number;
    productName?: string;
    fileDescription?: string;
    companyName?: string;
    score: number;
    reasons: string[];
    chosen: boolean;
  }>;
  chosenExe: string;
  identification: IdentificationResult;
};

type LocalScanIssue = {
  candidateId: string;
  gameId?: string;
  gameTitle?: string;
  folderPath: string;
  folderName: string;
  reason: "no_exes" | "ambiguous_exe" | "ambiguous_match" | "unmatched" | "missing_install";
  detail?: unknown;
};

type Props = {
  settings: AppSettings;
  setSettings: (next: AppSettings) => void;
  localGames: Game[];
  onGameSelected: (game: Game) => void;
  onLibraryRefresh: () => void;
  onIssueCountChange?: (count: number) => void;
};

type Toast = { id: number; level: "info" | "success" | "warning" | "error"; message: string };

const DEFAULT_EXCLUDE_PATTERNS = [
  "^_redist$",
  "^redist$",
  "^_Commonredist$",
  "^Tools$",
  "^Saves$",
  "^Backups?$",
  "^Emulators$",
  "^DLC$",
  "^_CommonRedist$"
];

export function LocalGamesScreen({ settings, setSettings, localGames, onGameSelected, onLibraryRefresh, onIssueCountChange }: Props) {
  const roots = settings.localRoots ?? [];
  const excludePatterns = settings.localExcludePatterns ?? DEFAULT_EXCLUDE_PATTERNS;
  const hasIgdb = Boolean(settings.igdb);

  const [scanning, setScanning] = useState(false);
  const [issues, setIssues] = useState<LocalScanIssue[]>([]);
  const [issuesLoaded, setIssuesLoaded] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [excludeOpen, setExcludeOpen] = useState(false);
  const [igdbOpen, setIgdbOpen] = useState(false);
  const [addModal, setAddModal] = useState<{ initialFolderPath?: string; initialExePath?: string } | undefined>();
  const [contextMenu, setContextMenu] = useState<{ game: Game; x: number; y: number } | undefined>();
  const [removeRootPrompt, setRemoveRootPrompt] = useState<{ root: LocalRoot; gameCount: number } | undefined>();

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const entry: Toast = { ...toast, id: Date.now() + Math.random() };
    setToasts((prev) => [...prev, entry]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== entry.id)), 4500);
  }, []);

  useEffect(() => {
    void refreshIssues();
  }, []);

  useEffect(() => {
    if (!issuesLoaded) return;
    onIssueCountChange?.(issues.length);
  }, [issues.length, issuesLoaded, onIssueCountChange]);

  // Close context menu on any click outside.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  const stats = useMemo(() => {
    const matched = localGames.filter((g) => g.sourceIds.some((s) => s.provider === "steam" || s.provider === "igdb")).length;
    return {
      tracked: roots.length,
      games: localGames.length,
      matched,
      pending: issues.length
    };
  }, [roots.length, localGames, issues]);

  async function refreshIssues() {
    try {
      const nextIssues = (await window.hynite.local.getIssues()) as LocalScanIssue[];
      setIssues(nextIssues);
      setIssuesLoaded(true);
    } catch {
      setIssuesLoaded(true);
    }
  }

  async function runScan() {
    if (roots.length === 0) {
      pushToast({ level: "warning", message: "Add at least one folder before scanning." });
      return;
    }
    setScanning(true);
    try {
      const result = await window.hynite.local.scan();
      setIssues(result.issues as LocalScanIssue[]);
      setIssuesLoaded(true);
      pushToast({
        level: result.matched > 0 ? "success" : "info",
        message: `Scanned ${result.scanned} folder(s) — ${result.matched} matched, ${result.ambiguous} need review.`
      });
      onLibraryRefresh();
      void refreshIssues();
    } catch (error) {
      pushToast({ level: "error", message: error instanceof Error ? error.message : "Scan failed." });
    } finally {
      setScanning(false);
    }
  }

  async function addRootFolder() {
    const path = await window.hynite.dialog.pickFolder({ title: "Pick a folder to track for local games" });
    if (!path) return;
    if (roots.some((r) => r.path.toLowerCase() === path.toLowerCase())) {
      pushToast({ level: "warning", message: "That folder is already tracked." });
      return;
    }
    const next = [...roots, { path, depth: 3 } satisfies LocalRoot];
    setSettings(await window.hynite.localExt.setRoots(next));
    pushToast({ level: "success", message: `Tracking ${path}.` });
  }

  async function requestRemoveRoot(root: LocalRoot) {
    let count = 0;
    try {
      count = await window.hynite.local.countUnder(root.path);
    } catch {
      count = 0;
    }
    if (count === 0) {
      setSettings(await window.hynite.localExt.setRoots(roots.filter((r) => r.path !== root.path)));
      pushToast({ level: "info", message: `Stopped tracking ${root.path}.` });
      return;
    }
    setRemoveRootPrompt({ root, gameCount: count });
  }

  async function commitRemoveRoot(removeGames: boolean) {
    if (!removeRootPrompt) return;
    const { root } = removeRootPrompt;
    try {
      if (removeGames) {
        const result = await window.hynite.local.removeUnder(root.path);
        pushToast({ level: "success", message: `Stopped tracking ${root.path} and removed ${result.removed} game(s).` });
      } else {
        pushToast({ level: "info", message: `Stopped tracking ${root.path}. Games kept in library.` });
      }
      setSettings(await window.hynite.localExt.setRoots(roots.filter((r) => r.path !== root.path)));
      onLibraryRefresh();
    } catch (error) {
      pushToast({ level: "error", message: error instanceof Error ? error.message : "Failed to remove." });
    } finally {
      setRemoveRootPrompt(undefined);
    }
  }

  async function repairLibrary() {
    if (!window.confirm("Repair the library?\n\nThis removes phantom Steam/IGDB games created by an older bug in the local importer. Your real Steam-synced games and your local games stay intact.")) return;
    try {
      const result = await window.hynite.local.repairLibrary();
      pushToast({
        level: result.deleted > 0 ? "success" : "info",
        message: result.deleted > 0 ? `Removed ${result.deleted} phantom game(s).` : "Library is already clean."
      });
      onLibraryRefresh();
    } catch (error) {
      pushToast({ level: "error", message: error instanceof Error ? error.message : "Repair failed." });
    }
  }

  async function ignoreLocalGame(game: Game) {
    try {
      await window.hynite.local.removeAndIgnore(game.id, game.installDirectory);
      pushToast({ level: "info", message: `Ignored "${game.title}". It won't be re-imported on the next scan.` });
      onLibraryRefresh();
    } catch (error) {
      pushToast({ level: "error", message: error instanceof Error ? error.message : "Failed to ignore game." });
    }
  }

  async function updateMissingGameLocation(issue: LocalScanIssue) {
    if (!issue.gameId) return;
    const path = await window.hynite.dialog.pickFolder({
      title: `Pick the new folder for ${issue.gameTitle ?? issue.folderName}`
    });
    if (!path) return;
    try {
      await window.hynite.local.updateLocation(issue.gameId, path);
      await refreshIssues();
      pushToast({ level: "success", message: `Updated "${issue.gameTitle ?? issue.folderName}" to its new folder.` });
      onLibraryRefresh();
    } catch (error) {
      pushToast({ level: "error", message: error instanceof Error ? error.message : "Failed to update game folder." });
    }
  }

  async function deleteMissingGame(issue: LocalScanIssue) {
    if (!issue.gameId) return;
    try {
      await window.hynite.local.removeGame(issue.gameId);
      await refreshIssues();
      pushToast({ level: "info", message: `Removed "${issue.gameTitle ?? issue.folderName}" from your library.` });
      onLibraryRefresh();
    } catch (error) {
      pushToast({ level: "error", message: error instanceof Error ? error.message : "Failed to remove game." });
    }
  }

  async function dismissIssue(folderPath: string) {
    try {
      setSettings(await window.hynite.local.ignoreFolder(folderPath));
      await refreshIssues();
      pushToast({ level: "info", message: "Folder ignored." });
    } catch (error) {
      pushToast({ level: "error", message: error instanceof Error ? error.message : "Failed to ignore." });
    }
  }

  return (
    <div className="page add-games-page">
      <header className="screen-title">
        <div>
          <h1>Add games</h1>
          <p>Bring non-Steam games into your library. Track folders for automatic scanning, or add a single game by folder or executable.</p>
        </div>
        <div className="add-games-actions">
          <button className="primary-action" onClick={() => setAddModal({})}>
            <Plus size={16} /> Add a game
          </button>
          <button className="secondary-action" onClick={() => void runScan()} disabled={scanning || roots.length === 0}>
            {scanning ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <button className="secondary-action" onClick={() => void repairLibrary()} title="Remove phantom Steam/IGDB games created by an older bug">
            Repair
          </button>
        </div>
      </header>

      <div className="add-games-stats">
        <span><strong>{stats.games}</strong> local games</span>
        <span className="add-stats-sep">·</span>
        <span><strong>{stats.matched}</strong> with metadata</span>
        <span className="add-stats-sep">·</span>
        <span><strong>{stats.tracked}</strong> tracked folders</span>
        {stats.pending > 0 ? (
          <>
            <span className="add-stats-sep">·</span>
            <span className="add-stats-warning"><strong>{stats.pending}</strong> need review</span>
          </>
        ) : null}
      </div>

      {/* Tracked folders */}
      <section className="add-games-section">
        <header className="section-head">
          <h2>Tracked folders</h2>
          <p>Each subfolder of a tracked folder is treated as a candidate game. Hynite descends up to 3 levels to find the launch executable.</p>
        </header>
        {roots.length === 0 ? (
          <button className="add-folder-empty" onClick={() => void addRootFolder()}>
            <FolderPlus size={20} />
            <span>
              <strong>Track a folder</strong>
              <em>e.g. F:\Games or your DRM-free downloads</em>
            </span>
          </button>
        ) : (
          <div className="add-roots-list">
            {roots.map((root) => (
              <div key={root.path} className="add-root-row">
                <button
                  type="button"
                  className="add-root-icon"
                  onClick={() => void window.hynite.native.openFolder(root.path)}
                  title="Open in file explorer"
                >
                  <FolderIcon size={16} />
                </button>
                <div className="add-root-text">
                  <strong>{shortFolderName(root.path)}</strong>
                  <span className="muted-text" title={root.path}>{root.path}</span>
                </div>
                <button className="row-icon-btn" onClick={() => void requestRemoveRoot(root)} title="Stop tracking this folder">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button className="add-root-row add-root-add" onClick={() => void addRootFolder()}>
              <FolderPlus size={16} />
              <span>Add another folder</span>
            </button>
          </div>
        )}
      </section>

      {/* Issues — only when present */}
      {issues.length > 0 ? (
        <section className="add-games-section">
          <header className="section-head">
            <h2>Need your input <span className="count-pill">{issues.length}</span></h2>
            <p>The scanner couldn't auto-resolve these. Pick a match, point at the right exe, or tell Hynite when a game was moved or deleted.</p>
          </header>
          <div className="add-issues-list">
            {issues.map((issue) => (
              <IssueRow
                key={issue.candidateId}
                issue={issue}
                onResolveMatch={(candidates) => {
                  // Open Add modal in "manual search" mode using the issue's folder + first candidate from issue if any
                  setAddModal({ initialFolderPath: issue.folderPath });
                  void candidates;
                }}
                onPickExe={() => setAddModal({ initialFolderPath: issue.folderPath })}
                onSearchManually={() => setAddModal({ initialFolderPath: issue.folderPath })}
                onMoved={() => void updateMissingGameLocation(issue)}
                onDeleted={() => void deleteMissingGame(issue)}
                onDismiss={() => void dismissIssue(issue.folderPath)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Recently added local games */}
      {localGames.length > 0 ? (
        <section className="add-games-section">
          <header className="section-head">
            <h2>Recently added</h2>
            <p>Right-click a game to ignore it (removes from library and skips on the next scan).</p>
          </header>
          <div className="add-game-grid">
            {[...localGames]
              .sort((a, b) => Date.parse(b.addedAt ?? "") - Date.parse(a.addedAt ?? ""))
              .slice(0, 24)
              .map((game) => (
                <button
                  key={game.id}
                  className="add-game-card"
                  onClick={() => onGameSelected(game)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ game, x: event.clientX, y: event.clientY });
                  }}
                >
                  <div className="add-game-cover">
                    {game.coverUrl ? (
                      <img src={game.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="add-game-fallback">{game.title.slice(0, 2)}</span>
                    )}
                  </div>
                  <div className="add-game-meta">
                    <strong>{game.title}</strong>
                  </div>
                </button>
              ))}
          </div>
        </section>
      ) : null}

      {/* Settings collapsibles */}
      <section className="add-games-section">
        <details className="add-collapsible" open={excludeOpen} onToggle={(event) => setExcludeOpen(event.currentTarget.open)}>
          <summary>
            {excludeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Exclude patterns</span>
            <em className="muted-text">{excludePatterns.length} pattern{excludePatterns.length === 1 ? "" : "s"}</em>
          </summary>
          <ExcludePatternsEditor
            initial={excludePatterns}
            onSave={async (patterns) => {
              setSettings(await window.hynite.localExt.setExcludePatterns(patterns));
              pushToast({ level: "success", message: "Exclude patterns saved." });
            }}
            onReset={async () => {
              setSettings(await window.hynite.localExt.setExcludePatterns(DEFAULT_EXCLUDE_PATTERNS));
              pushToast({ level: "info", message: "Reset to defaults." });
            }}
          />
        </details>

        <details className="add-collapsible" open={igdbOpen} onToggle={(event) => setIgdbOpen(event.currentTarget.open)}>
          <summary>
            {igdbOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>IGDB credentials</span>
            <em className="muted-text">{hasIgdb ? "connected" : "not connected"}</em>
          </summary>
          <IgdbCredentialsEditor
            connected={hasIgdb}
            onSave={async (clientId, clientSecret) => {
              setSettings(await window.hynite.metadata.saveIgdbCredentials(clientId, clientSecret));
              pushToast({ level: "success", message: "IGDB credentials saved." });
            }}
            onClear={async () => {
              setSettings(await window.hynite.metadata.clearIgdbCredentials());
              pushToast({ level: "info", message: "IGDB credentials cleared." });
            }}
          />
        </details>
      </section>

      {/* Add Game modal */}
      <AnimatePresence>
        {addModal ? (
          <AddGameModal
            initialFolderPath={addModal.initialFolderPath}
            initialExePath={addModal.initialExePath}
            hasIgdb={hasIgdb}
            onClose={() => setAddModal(undefined)}
            onAdded={(title) => {
              setAddModal(undefined);
              pushToast({ level: "success", message: `Added ${title}.` });
              onLibraryRefresh();
              void refreshIssues();
            }}
            onError={(message) => pushToast({ level: "error", message })}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {removeRootPrompt ? (
          <ModalShell title="Stop tracking folder" onClose={() => setRemoveRootPrompt(undefined)}>
            <p>
              <strong>{shortFolderName(removeRootPrompt.root.path)}</strong> currently has{" "}
              <strong>{removeRootPrompt.gameCount}</strong> game{removeRootPrompt.gameCount === 1 ? "" : "s"} in your library.
            </p>
            <p className="muted-text">
              You can stop tracking this folder and remove those games from your library, or keep the games and just stop scanning the folder.
            </p>
            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setRemoveRootPrompt(undefined)}>Cancel</button>
              <div className="modal-actions-right">
                <button className="secondary-action" onClick={() => void commitRemoveRoot(false)}>Keep games</button>
                <button className="primary-action danger-primary" onClick={() => void commitRemoveRoot(true)}>
                  <Trash2 size={14} /> Remove {removeRootPrompt.gameCount} game{removeRootPrompt.gameCount === 1 ? "" : "s"}
                </button>
              </div>
            </div>
          </ModalShell>
        ) : null}
      </AnimatePresence>

      {/* Right-click context menu */}
      {contextMenu ? (
        <div
          className="add-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => { setContextMenu(undefined); onGameSelected(contextMenu.game); }}>
            <Search size={13} /> View details
          </button>
          <button onClick={() => { setContextMenu(undefined); void window.hynite.native.openFolder(contextMenu.game.installDirectory ?? ""); }}>
            <FolderIcon size={13} /> Open folder
          </button>
          <button className="danger" onClick={() => { setContextMenu(undefined); void ignoreLocalGame(contextMenu.game); }}>
            <EyeOff size={13} /> Ignore (remove from library)
          </button>
        </div>
      ) : null}

      {/* Toasts */}
      <div className="local-toasts" aria-live="polite">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              className={`local-toast level-${toast.level}`}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
            >
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Issue row with action buttons
// -----------------------------------------------------------------------

function IssueRow({
  issue,
  onResolveMatch,
  onPickExe,
  onSearchManually,
  onMoved,
  onDeleted,
  onDismiss
}: {
  issue: LocalScanIssue;
  onResolveMatch: (candidates: IdentifyCandidateLite[]) => void;
  onPickExe: () => void;
  onSearchManually: () => void;
  onMoved: () => void;
  onDeleted: () => void;
  onDismiss: () => void;
}) {
  const candidates = (issue.detail as IdentifyCandidateLite[] | undefined) ?? [];
  const labels: Record<LocalScanIssue["reason"], string> = {
    no_exes: "No executables found",
    ambiguous_exe: "Multiple executables — pick the launcher",
    ambiguous_match: "Multiple metadata matches — pick the right game",
    unmatched: "No metadata match found",
    missing_install: "Install folder is missing"
  };
  return (
    <div className="add-issue-row">
      <div className="add-issue-icon"><AlertCircle size={16} /></div>
      <div className="add-issue-text">
        <strong>{issue.gameTitle ?? issue.folderName}</strong>
        <span className="muted-text">{labels[issue.reason]} · {issue.folderPath}</span>
      </div>
      <div className="add-issue-actions">
        {issue.reason === "missing_install" ? (
          <>
            <button className="secondary-action small" onClick={onMoved}>
              <FolderIcon size={13} /> Moved
            </button>
            <button className="secondary-action small danger" onClick={onDeleted}>
              <Trash2 size={13} /> Deleted
            </button>
          </>
        ) : null}
        {issue.reason === "ambiguous_match" ? (
          <button className="secondary-action small" onClick={() => onResolveMatch(candidates)}>
            <Wand2 size={13} /> Pick a match
          </button>
        ) : null}
        {issue.reason === "ambiguous_exe" ? (
          <button className="secondary-action small" onClick={onPickExe}>
            <FolderIcon size={13} /> Pick exe
          </button>
        ) : null}
        {issue.reason === "unmatched" ? (
          <button className="secondary-action small" onClick={onSearchManually}>
            <Search size={13} /> Search manually
          </button>
        ) : null}
        {issue.reason !== "missing_install" ? (
          <button className="row-icon-btn" onClick={onDismiss} title="Ignore this folder">
            <EyeOff size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Settings editors
// -----------------------------------------------------------------------

function ExcludePatternsEditor({
  initial,
  onSave,
  onReset
}: {
  initial: string[];
  onSave: (patterns: string[]) => void;
  onReset: () => void;
}) {
  const [text, setText] = useState(initial.join("\n"));
  useEffect(() => setText(initial.join("\n")), [initial]);
  const dirty = text !== initial.join("\n");
  return (
    <div className="add-settings-body">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        rows={8}
        placeholder="One regex per line, e.g. ^_redist$"
      />
      <div className="add-settings-actions">
        <button className="primary-action" disabled={!dirty} onClick={() => onSave(text.split("\n").map((line) => line.trim()).filter(Boolean))}>
          Save
        </button>
        <button className="secondary-action" onClick={onReset}>Reset to defaults</button>
      </div>
    </div>
  );
}

function IgdbCredentialsEditor({
  connected,
  onSave,
  onClear
}: {
  connected: boolean;
  onSave: (clientId: string, clientSecret: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0;
  return (
    <div className="add-settings-body">
      <p className="muted-text">
        Create a Twitch app at{" "}
        <a href="#" onClick={(event) => { event.preventDefault(); void window.hynite.native.openExternal("https://dev.twitch.tv/console/apps"); }}>
          dev.twitch.tv/console/apps
        </a>{" "}
        and paste the Client ID + Client Secret. IGDB uses Twitch's OAuth, and improves matching for games that aren't on Steam.
      </p>
      <label className="add-field"><span>Client ID</span>
        <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={connected ? "•••••••• (saved)" : ""} />
      </label>
      <label className="add-field"><span>Client Secret</span>
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={connected ? "•••••••• (saved)" : ""} />
      </label>
      <div className="add-settings-actions">
        <button
          className="primary-action"
          disabled={!canSave || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(clientId.trim(), clientSecret.trim());
              setClientId("");
              setClientSecret("");
            } finally { setSaving(false); }
          }}
        >
          <KeyRound size={14} /> {saving ? "Saving…" : "Save credentials"}
        </button>
        {connected ? <button className="secondary-action danger" onClick={() => void onClear()}>Disconnect</button> : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Multi-step Add Game modal
// -----------------------------------------------------------------------

type ModalStep = "pick" | "review" | "search";

function AddGameModal({
  initialFolderPath,
  initialExePath,
  hasIgdb,
  onClose,
  onAdded,
  onError
}: {
  initialFolderPath?: string;
  initialExePath?: string;
  hasIgdb: boolean;
  onClose: () => void;
  onAdded: (title: string) => void;
  onError: (message: string) => void;
}) {
  const [step, setStep] = useState<ModalStep>(initialFolderPath || initialExePath ? "review" : "pick");
  const [folderPath, setFolderPath] = useState<string | undefined>(initialFolderPath);
  const [exePath, setExePath] = useState<string | undefined>(initialExePath);
  const [titleOverride, setTitleOverride] = useState("");
  const [probe, setProbe] = useState<ProbeResult | undefined>();
  const [probing, setProbing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [searchProvider, setSearchProvider] = useState<"steam" | "igdb">("steam");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ steam: IdentifyCandidateLite[]; igdb: IdentifyCandidateLite[] }>({ steam: [], igdb: [] });
  const [searching, setSearching] = useState(false);

  const probeRunRef = useRef(0);
  const lastProbeKeyRef = useRef<string>("");
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (step !== "review") return;
    if (!folderPath && !exePath) return;
    const key = `${folderPath ?? ""} ${exePath ?? ""}`;
    if (key === lastProbeKeyRef.current) return;
    lastProbeKeyRef.current = key;
    const run = ++probeRunRef.current;
    setProbing(true);
    setProbe(undefined);
    void window.hynite.local
      .probe({ folderPath, executablePath: exePath })
      .then((result) => {
        if (probeRunRef.current === run) setProbe(result);
      })
      .catch((error) => {
        if (probeRunRef.current === run) {
          onErrorRef.current(error instanceof Error ? error.message : "Probe failed.");
        }
      })
      .finally(() => {
        if (probeRunRef.current === run) setProbing(false);
      });
  }, [step, folderPath, exePath]);

  // Pre-fill search query when entering search step.
  useEffect(() => {
    if (step !== "search") return;
    if (searchQuery) return;
    const initial = probe?.folderName ?? titleOverride;
    if (initial) setSearchQuery(initial);
  }, [step, probe?.folderName, titleOverride, searchQuery]);

  // Run search on query change (debounced).
  useEffect(() => {
    if (step !== "search") return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      setSearchResults({ steam: [], igdb: [] });
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      void window.hynite.local
        .searchMetadata(trimmed)
        .then((results) => setSearchResults(results))
        .catch(() => setSearchResults({ steam: [], igdb: [] }))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [step, searchQuery]);

  async function pickFolder() {
    const path = await window.hynite.dialog.pickFolder({ title: "Pick the game's install folder" });
    if (path) {
      setFolderPath(path);
      setExePath(undefined);
      setStep("review");
    }
  }
  async function pickExe() {
    const path = await window.hynite.dialog.pickFile({ title: "Pick the game executable", filters: [
        { name: "Game launchers", extensions: ["exe", "bat", "cmd", "lnk", "url", "com"] },
        { name: "All files", extensions: ["*"] }
      ] });
    if (path) {
      setExePath(path);
      setFolderPath(undefined);
      setStep("review");
    }
  }
  async function chooseDifferentExe() {
    const path = await window.hynite.dialog.pickFile({
      title: "Pick the launch executable",
      defaultPath: probe?.folderPath,
      filters: [
        { name: "Game launchers", extensions: ["exe", "bat", "cmd", "lnk", "url", "com"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (path) setExePath(path);
  }

  async function commit(match?: { provider: "steam" | "igdb"; externalId: string; title: string }) {
    if (!folderPath && !exePath) return;
    setSubmitting(true);
    try {
      const result = await window.hynite.local.addSingle({
        folderPath,
        executablePath: exePath,
        titleOverride: titleOverride.trim() || undefined,
        match
      });
      onAdded(result.title);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to add game.");
    } finally {
      setSubmitting(false);
    }
  }

  const autoMatch = probe?.identification.kind === "match" ? probe.identification.match : undefined;
  const ambiguousCandidates =
    probe?.identification.kind === "ambiguous"
      ? probe.identification.candidates
      : autoMatch
        ? [{ provider: autoMatch.provider, externalId: autoMatch.externalId, title: autoMatch.title } as IdentifyCandidateLite]
        : [];
  const showSearchSuggestion = probe?.identification.kind === "unmatched" || probe?.identification.kind === "ambiguous";

  return (
    <ModalShell onClose={onClose} title={step === "search" ? "Search for the game" : step === "review" ? "Review and confirm" : "Add a single game"}>
      {step === "pick" ? (
        <div className="add-step-pick">
          <p className="muted-text">Pick a folder to auto-detect the launch exe, or pick a specific .exe directly. Hynite will identify the game and pull cover art and metadata.</p>
          <div className="add-pick-grid">
            <button className="add-pick-pane" onClick={() => void pickFolder()}>
              <FolderIcon size={28} />
              <strong>Pick a folder</strong>
              <span className="muted-text">We'll auto-pick the launch exe inside.</span>
            </button>
            <button className="add-pick-pane" onClick={() => void pickExe()}>
              <FolderIcon size={28} />
              <strong>Pick a specific .exe</strong>
              <span className="muted-text">Override auto-pick when the launcher is unusual.</span>
            </button>
          </div>
        </div>
      ) : step === "review" ? (
        <div className="add-step-review">
          {probing ? (
            <div className="add-probe-loading">
              <Loader2 size={18} className="spin" /> Inspecting folder…
            </div>
          ) : !probe ? null : (
            <>
              <div className="add-review-row">
                <div className="add-review-label">Folder</div>
                <div className="add-review-value">
                  <code title={probe.folderPath}>{truncatePath(probe.folderPath)}</code>
                </div>
              </div>
              <div className="add-review-row">
                <div className="add-review-label">Launch exe</div>
                <div className="add-review-value">
                  <code title={probe.chosenExe}>{truncatePath(probe.chosenExe.replace(probe.folderPath, ""))}</code>
                  <button className="row-link" onClick={() => void chooseDifferentExe()}>Change</button>
                </div>
              </div>
              {probe.exeOptions.length > 1 ? (
                <details className="add-exe-options">
                  <summary>Other detected executables ({probe.exeOptions.length})</summary>
                  <ul>
                    {probe.exeOptions.slice(0, 8).map((option) => (
                      <li key={option.path} className={option.chosen ? "chosen" : ""}>
                        <button onClick={() => setExePath(option.path)}>
                          <code>{truncatePath(option.path.replace(probe.folderPath, ""))}</code>
                          {option.productName ? <em>· {option.productName}</em> : null}
                          {option.chosen ? <span className="add-exe-chosen-badge">chosen</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div className="add-review-divider" />

              <div className="add-review-match">
                <h3>Identified game</h3>
                {autoMatch ? (
                  <div className="add-review-match-card">
                    <CheckCircle2 size={18} className="add-match-ok" />
                    <div>
                      <strong>{autoMatch.title}</strong>
                      <span className="muted-text">{autoMatch.provider.toUpperCase()} · {autoMatch.externalId} · confidence {(autoMatch.confidence * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                ) : (
                  <div className="add-review-match-card warning">
                    <AlertCircle size={18} />
                    <div>
                      <strong>{probe.identification.kind === "ambiguous" ? "Multiple matches" : "No automatic match"}</strong>
                      <span className="muted-text">Pick from suggestions below or search manually.</span>
                    </div>
                  </div>
                )}
              </div>

              {ambiguousCandidates.length > 0 && probe.identification.kind === "ambiguous" ? (
                <>
                  <h4 className="add-suggestion-heading">Top suggestions</h4>
                  <div className="add-candidate-grid">
                    {ambiguousCandidates.slice(0, 6).map((candidate) => (
                      <CandidateCard
                        key={`${candidate.provider}:${candidate.externalId}`}
                        candidate={candidate}
                        onPick={() => void commit({ provider: candidate.provider, externalId: candidate.externalId, title: candidate.title })}
                      />
                    ))}
                  </div>
                </>
              ) : null}

              {showSearchSuggestion ? (
                <button className="add-search-link" onClick={() => setStep("search")}>
                  <Search size={14} /> Search manually instead
                </button>
              ) : null}

              <label className="add-field title-field">
                <span>Title override <em className="muted-text">(optional)</em></span>
                <input type="text" value={titleOverride} onChange={(event) => setTitleOverride(event.target.value)} placeholder={autoMatch?.title ?? probe.folderName} />
              </label>
            </>
          )}

          <div className="modal-actions">
            <button className="secondary-action" onClick={() => setStep("pick")}>
              <ArrowLeft size={13} /> Back
            </button>
            <div className="modal-actions-right">
              <button className="secondary-action" onClick={() => setStep("search")}>
                <Search size={13} /> Search manually
              </button>
              <button
                className="primary-action"
                disabled={!probe || submitting}
                onClick={() =>
                  void commit(autoMatch ? { provider: autoMatch.provider, externalId: autoMatch.externalId, title: autoMatch.title } : undefined)
                }
              >
                {submitting ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                {submitting ? "Adding…" : autoMatch ? "Confirm & add" : "Add without metadata"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="add-step-search">
          <div className="add-search-header">
            <div className="add-search-providers">
              <button className={searchProvider === "steam" ? "active" : ""} onClick={() => setSearchProvider("steam")}>Steam</button>
              <button
                className={searchProvider === "igdb" ? "active" : ""}
                onClick={() => setSearchProvider("igdb")}
                disabled={!hasIgdb}
                title={hasIgdb ? "" : "Add IGDB credentials in the page settings to search IGDB"}
              >
                IGDB {!hasIgdb ? "(not connected)" : ""}
              </button>
            </div>
            <div className="add-search-input-wrap">
              <Search size={14} />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search for a game…"
                autoFocus
              />
              {searching ? <Loader2 size={14} className="spin" /> : null}
            </div>
          </div>

          <div className="add-candidate-grid">
            {(searchProvider === "steam" ? searchResults.steam : searchResults.igdb).map((candidate) => (
              <CandidateCard
                key={`${candidate.provider}:${candidate.externalId}`}
                candidate={candidate}
                onPick={() => void commit({ provider: candidate.provider, externalId: candidate.externalId, title: candidate.title })}
                onOpenInfo={() => {
                  const url =
                    candidate.provider === "steam"
                      ? `https://store.steampowered.com/app/${candidate.externalId}/`
                      : `https://www.igdb.com/games/${candidate.externalId}`;
                  void window.hynite.native.openExternal(url);
                }}
              />
            ))}
            {!searching && (searchProvider === "steam" ? searchResults.steam : searchResults.igdb).length === 0 && searchQuery.length >= 2 ? (
              <div className="add-search-empty">No results.</div>
            ) : null}
          </div>

          <div className="modal-actions">
            <button className="secondary-action" onClick={() => setStep("review")}>
              <ArrowLeft size={13} /> Back to review
            </button>
            <button
              className="primary-action"
              disabled={submitting}
              onClick={() => void commit()}
            >
              {submitting ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
              Add without match
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function CandidateCard({
  candidate,
  onPick,
  onOpenInfo
}: {
  candidate: IdentifyCandidateLite;
  onPick: () => void;
  onOpenInfo?: () => void;
}) {
  return (
    <div className="add-candidate-card" title={candidate.title}>
      <button className="add-candidate-pick" onClick={onPick}>
        <div className="add-candidate-cover">
          {candidate.coverUrl ? <img src={candidate.coverUrl} alt="" /> : <span>{candidate.title.slice(0, 2)}</span>}
        </div>
        <div className="add-candidate-text">
          <strong>{candidate.title}</strong>
          <span className="muted-text">
            {candidate.provider.toUpperCase()}{candidate.releaseDate ? ` · ${candidate.releaseDate.slice(0, 4)}` : ""}
          </span>
        </div>
      </button>
      {onOpenInfo ? (
        <button className="add-candidate-info" onClick={onOpenInfo} title="Open store page">
          <ChevronRight size={14} />
        </button>
      ) : null}
    </div>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <motion.div className="local-modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="local-modal"
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 360, damping: 28 }}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="local-modal-header">
          <h3>{title}</h3>
          <button className="local-modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="local-modal-body">{children}</div>
      </motion.div>
    </motion.div>
  );
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function truncatePath(path: string): string {
  if (path.length <= 64) return path;
  return `…${path.slice(path.length - 63)}`;
}

function shortFolderName(path: string): string {
  const parts = path.replace(/[\/\\]+$/, "").split(/[\/\\]/);
  return parts[parts.length - 1] || path;
}
