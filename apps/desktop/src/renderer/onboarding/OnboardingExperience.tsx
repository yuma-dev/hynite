import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderPlus,
  KeyRound,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Users,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { AppSettings, LocalRoot, MusicSettings, OnboardingState, SteamAccountSettings, SteamLocalAccount, SyncStatus } from "@hynite/core";
import { musicEngine, normalizeMusicSettings } from "../music";
import { onboardingMedia, type OnboardingMediaAsset } from "./onboardingMedia";

type StepId =
  | "steam-web-api"
  | "steamgriddb"
  | "pair-steam"
  | "local-steam-user"
  | "local-games"
  | "sources"
  | "music"
  | "zoom"
  | "preparing";

type StepDefinition = {
  id: StepId;
  title: string;
};

type OnboardingTask = {
  id: "steam" | "local";
  label: string;
  status: "idle" | "running" | "success" | "warning";
  message: string;
};

const HYDRA_SOURCES_URL = "https://library.hydra.wiki/sources";
const STEAM_WEB_API_URL = "https://steamcommunity.com/dev/apikey";
const STEAMGRIDDB_API_URL = "https://www.steamgriddb.com/profile/preferences/api";
const MIN_CARDS_PER_ROW = 4;
const MAX_CARDS_PER_ROW = 12;
const ONBOARDING_MUSIC_START_DELAY_MS = 10_000;

const STEPS: StepDefinition[] = [
  {
    id: "steam-web-api",
    title: "Steam Web API Key"
  },
  {
    id: "steamgriddb",
    title: "SteamGridDB API Key"
  },
  {
    id: "pair-steam",
    title: "Pair Steam Account"
  },
  {
    id: "local-steam-user",
    title: "Local Steam User"
  },
  {
    id: "local-games",
    title: "Local Games"
  },
  {
    id: "sources",
    title: "Sources"
  },
  {
    id: "music",
    title: "Music Playback"
  },
  {
    id: "zoom",
    title: "Zoom Preference"
  },
  {
    id: "preparing",
    title: "Preparing Library"
  }
];

const INITIAL_TASKS: Record<OnboardingTask["id"], OnboardingTask> = {
  steam: { id: "steam", label: "Steam first pass", status: "idle", message: "Waiting for Steam setup" },
  local: { id: "local", label: "Local scan", status: "idle", message: "Waiting for tracked folders" }
};

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

function normalizeCardsPerRow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_CARDS_PER_ROW, Math.max(MIN_CARDS_PER_ROW, Math.round(value)))
    : 6;
}

function previewSecret() {
  return { cipherText: "preview", scope: "current-user" as const };
}

function makePreviewAccount(index: number): SteamAccountSettings {
  const suffix = String(index + 1).padStart(2, "0");
  return {
    steamId: `765611980000000${suffix}`,
    personaName: `Preview account ${index + 1}`,
    pairedAt: new Date().toISOString()
  };
}

function shortPath(path: string): string {
  if (path.length <= 54) return path;
  return `...${path.slice(path.length - 51)}`;
}

function mediaSources(media: OnboardingMediaAsset, reduced: boolean) {
  if (media.kind === "image") {
    return <img className="onboarding-media-asset" src={media.src} alt={media.alt ?? ""} />;
  }

  return (
    <video
      className="onboarding-media-asset"
      poster={media.poster ?? undefined}
      muted
      playsInline
      loop={!reduced}
      autoPlay={!reduced}
      controls={reduced}
    >
      {media.webm ? <source src={media.webm} type="video/webm" /> : null}
      <source src={media.mp4} type="video/mp4" />
      {media.poster ? <img src={media.poster} alt="" /> : null}
    </video>
  );
}

function zoomFill(value: number): string {
  const pct = ((value - MIN_CARDS_PER_ROW) / (MAX_CARDS_PER_ROW - MIN_CARDS_PER_ROW)) * 100;
  return `${Math.round(pct)}%`;
}

function Bubble({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "warm" }) {
  return <aside className={`onboarding-bubble ${tone}`}>{children}</aside>;
}

function ToggleRow({
  checked,
  label,
  hint,
  onChange
}: {
  checked: boolean;
  label: string;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="onboarding-toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className="settings-toggle-control" aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        {hint ? <em>{hint}</em> : null}
      </span>
    </label>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const fill = `${Math.round(((value - min) / (max - min)) * 100)}%`;
  const displayValue = unit === "%" ? `${Math.round(value * 100)}%` : unit ? `${value}${unit}` : value;
  return (
    <label className="onboarding-slider-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--zoom-fill": fill } as CSSProperties}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <strong>{displayValue}</strong>
    </label>
  );
}

function OnboardingTitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.hynite.window.isMaximized().then(setMaximized);
    return window.hynite.window.onMaximizeChanged(setMaximized);
  }, []);

  return (
    <header className="onboarding-titlebar">
      <span className="titlebar-drag" />
      <div className="titlebar-controls">
        <button className="titlebar-btn" tabIndex={-1} type="button" onClick={() => void window.hynite.window.minimize()} aria-label="Minimize" title="Minimize">
          <Minus size={11} />
        </button>
        <button className="titlebar-btn" tabIndex={-1} type="button" onClick={() => void window.hynite.window.maximize()} aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"}>
          <Maximize2 size={13} />
        </button>
        <button className="titlebar-btn close" tabIndex={-1} type="button" onClick={() => void window.hynite.window.close()} aria-label="Close" title="Close">
          <X size={14} />
        </button>
      </div>
    </header>
  );
}

export function OnboardingExperience({
  state,
  onFinished
}: {
  state: OnboardingState;
  onFinished: (settings: AppSettings | undefined, skipped: boolean) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex] ?? STEPS[0]!;
  const [settings, setSettings] = useState<AppSettings | undefined>();
  const [steamKeyDraft, setSteamKeyDraft] = useState("");
  const [steamGridDbDraft, setSteamGridDbDraft] = useState("");
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [localAccounts, setLocalAccounts] = useState<SteamLocalAccount[]>([]);
  const [sourceUrlDraft, setSourceUrlDraft] = useState("");
  const [sourceJson, setSourceJson] = useState("");
  const [sourcePhase, setSourcePhase] = useState<"idle" | "open">("idle");
  const [sourceImport, setSourceImport] = useState<{ name: string; importedEntries: number; skippedEntries: number } | undefined>();
  const [musicDraft, setMusicDraft] = useState<MusicSettings>(() => normalizeMusicSettings());
  const [musicStatus, setMusicStatus] = useState(() => musicEngine.getStatus());
  const [syncStatus, setSyncStatus] = useState<SyncStatus | undefined>();
  const [tasks, setTasks] = useState<Record<OnboardingTask["id"], OnboardingTask>>(INITIAL_TASKS);
  const tasksRef = useRef(tasks);
  const steamTaskStartedRef = useRef(false);
  const localTaskStartedRef = useRef(false);
  const musicStartTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>();

  const accounts = settings?.steamAccounts ?? [];
  const localRoots = settings?.localRoots ?? [];
  const cardsPerRow = normalizeCardsPerRow(settings?.cardsPerRow);
  const musicSettings = musicDraft;
  const preview = state.preview;
  const canContinueFromPreparing = !Object.values(tasks).some((task) => task.status === "running");
  const musicPlaying = musicStatus.playing || musicStatus.audible;

  const updateTask = useCallback((id: OnboardingTask["id"], patch: Partial<OnboardingTask>) => {
    tasksRef.current = {
      ...tasksRef.current,
      [id]: { ...tasksRef.current[id], ...patch }
    };
    setTasks(tasksRef.current);
  }, []);

  const setLocalSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({
      ...(current as AppSettings),
      ...patch
    }));
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<AppSettings | undefined> => {
    if (preview) {
      const next = {
        ...(settings as AppSettings),
        ...patch
      };
      setSettings(next);
      return next;
    }
    const next = await window.hynite.settings.update(patch);
    setSettings(next);
    return next;
  }, [preview, settings]);

  useEffect(() => {
    let disposed = false;
    window.hynite.startup.signalReady({ mode: "onboarding" });
    const stopSyncStatus = window.hynite.sync.onStatusChanged(setSyncStatus);
    const stopMusicStatus = musicEngine.subscribe(setMusicStatus);
    musicStartTimerRef.current = setTimeout(() => {
      musicStartTimerRef.current = undefined;
      musicEngine.onStartupComplete({ skipStartupDelay: true });
    }, ONBOARDING_MUSIC_START_DELAY_MS);
    void window.hynite.settings.get().then((next) => {
      if (disposed) return;
      const nextMusic = normalizeMusicSettings(next.music);
      setSettings(next);
      setMusicDraft(nextMusic);
      musicEngine.applySettings({ ...next, music: nextMusic });
    }).catch((error: unknown) => {
      if (disposed) return;
      setMessage(error instanceof Error ? error.message : "Failed to load settings.");
    });
    void window.hynite.sync.status().then((next) => {
      if (!disposed) setSyncStatus(next);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      stopSyncStatus();
      stopMusicStatus();
      if (musicStartTimerRef.current) {
        clearTimeout(musicStartTimerRef.current);
        musicStartTimerRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (preview) {
      setLocalAccounts([
        { steamId: "76561198000000001", accountName: "preview_one", personaName: "Preview account 1", mostRecent: true },
        { steamId: "76561198000000002", accountName: "preview_two", personaName: "Preview account 2", mostRecent: false }
      ]);
      return;
    }
    void window.hynite.steam.listLocalAccounts().then(setLocalAccounts).catch(() => setLocalAccounts([]));
  }, [preview, accounts.length]);

  function hasRunningTasks(): boolean {
    return Object.values(tasksRef.current).some((task) => task.status === "running");
  }

  async function complete(skipped: boolean): Promise<void> {
    if (busy) return;
    setBusy("complete");
    try {
      if (preview) {
        onFinished(settings, skipped);
        return;
      }
      const next = await window.hynite.onboarding.complete({ skipped });
      onFinished(next, skipped);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not finish onboarding.");
    } finally {
      setBusy(undefined);
    }
  }

  function startSteamFirstPass(): void {
    if (preview || steamTaskStartedRef.current || !settings?.steamWebApiKey || accounts.length === 0) {
      return;
    }
    steamTaskStartedRef.current = true;
    updateTask("steam", { status: "running", message: "Importing owned Steam games" });
    void window.hynite.library.sync("steam")
      .then((result) => {
        updateTask("steam", {
          status: "success",
          message: `Imported ${result.upserted} Steam game${result.upserted === 1 ? "" : "s"}`
        });
      })
      .catch((error: unknown) => {
        updateTask("steam", {
          status: "warning",
          message: error instanceof Error ? error.message : "Steam sync did not finish."
        });
      });
  }

  function startLocalFirstPass(): void {
    if (preview || localTaskStartedRef.current || localRoots.length === 0) {
      return;
    }
    localTaskStartedRef.current = true;
    updateTask("local", { status: "running", message: "Scanning tracked folders" });
    void window.hynite.local.scan()
      .then((result) => {
        updateTask("local", {
          status: "success",
          message: `Scanned ${result.scanned} folder${result.scanned === 1 ? "" : "s"}`
        });
      })
      .catch((error: unknown) => {
        updateTask("local", {
          status: "warning",
          message: error instanceof Error ? error.message : "Local scan did not finish."
        });
      });
  }

  function nextStep(): void {
    setMessage(undefined);
    if (step.id === "local-steam-user") {
      startSteamFirstPass();
    }
    if (step.id === "local-games") {
      startLocalFirstPass();
    }
    if (step.id === "zoom") {
      if (hasRunningTasks()) {
        setStepIndex(STEPS.findIndex((item) => item.id === "preparing"));
      } else {
        void complete(false);
      }
      return;
    }
    if (step.id === "preparing") {
      void complete(false);
      return;
    }
    setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
  }

  function previousStep(): void {
    setMessage(undefined);
    setStepIndex((current) => Math.max(0, current - 1));
  }

  async function saveSteamKey(): Promise<void> {
    const trimmed = steamKeyDraft.trim();
    if (!trimmed) return;
    setBusy("steam-key");
    setMessage(undefined);
    try {
      if (preview) {
        setLocalSettings({ steamWebApiKey: previewSecret() });
      } else {
        setSettings(await window.hynite.steam.saveApiKey(trimmed));
      }
      setSteamKeyDraft("");
      setMessage("Steam Web API key saved.");
      setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save Steam Web API key.");
    } finally {
      setBusy(undefined);
    }
  }

  async function saveSteamGridDbKey(): Promise<void> {
    const trimmed = steamGridDbDraft.trim();
    if (!trimmed) return;
    setBusy("steamgriddb-key");
    setMessage(undefined);
    try {
      if (preview) {
        setLocalSettings({ steamGridDbApiKey: previewSecret() });
      } else {
        setSettings(await window.hynite.metadata.saveSteamGridDbKey(trimmed));
      }
      setSteamGridDbDraft("");
      setMessage("SteamGridDB fallback saved.");
      setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save SteamGridDB key.");
    } finally {
      setBusy(undefined);
    }
  }

  async function pairAccount(): Promise<void> {
    setBusy("pair");
    setMessage(undefined);
    try {
      if (preview) {
        const nextIndex = (settings?.steamAccounts ?? []).length;
        const nextAccount = makePreviewAccount(nextIndex);
        setSettings((current) => {
          const existing = current?.steamAccounts ?? [];
          return {
            ...(current as AppSettings),
            steamAccounts: [
              ...existing,
              {
                ...nextAccount,
                familySession: {
                  accessToken: previewSecret(),
                  steamId: nextAccount.steamId,
                  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                  connectedAt: new Date().toISOString()
                }
              }
            ]
          };
        });
      } else {
        const paired = await window.hynite.steam.pair();
        setSettings(await window.hynite.settings.get());
        void connectFamily(paired.steamId);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Steam pairing was not completed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function setLocalUsername(steamId: string, localUsername: string): Promise<void> {
    if (preview) {
      setSettings((current) => ({
        ...(current as AppSettings),
        steamAccounts: (current?.steamAccounts ?? []).map((account) =>
          account.steamId === steamId ? { ...account, localUsername: localUsername || undefined } : account
        )
      }));
      return;
    }
    setSettings(await window.hynite.steam.setAccountLocalUsername(steamId, localUsername || undefined));
  }

  async function connectFamily(steamId: string): Promise<void> {
    setBusy(`family-${steamId}`);
    setMessage(undefined);
    try {
      if (preview) {
        setSettings((current) => ({
          ...(current as AppSettings),
          steamAccounts: (current?.steamAccounts ?? []).map((account) =>
            account.steamId === steamId
              ? {
                  ...account,
                  familySession: {
                    accessToken: previewSecret(),
                    steamId,
                    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                    connectedAt: new Date().toISOString()
                  }
                }
              : account
          )
        }));
      } else {
        setSettings(await window.hynite.steam.connectFamily(steamId));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Steam Family connection failed.");
    } finally {
      setBusy(undefined);
    }
  }

  async function addLocalRoot(): Promise<void> {
    const path = await window.hynite.dialog.pickFolder({ title: "Pick a folder to track for local games" });
    if (!path) return;
    if (localRoots.some((root) => root.path.toLowerCase() === path.toLowerCase())) {
      setMessage("That folder is already tracked.");
      return;
    }
    const nextRoots = [...localRoots, { path, depth: 3 } satisfies LocalRoot];
    await updateSettings({ localRoots: nextRoots });
  }

  async function importSource(): Promise<void> {
    const trimmed = sourceJson.trim();
    const url = sourceUrlDraft.trim();
    if (!trimmed) return;
    setBusy("source");
    setMessage(undefined);
    try {
      const result = preview
        ? { sourceId: "preview-source", name: "Preview source", importedEntries: 24, skippedEntries: 0 }
        : await window.hynite.sources.import({ kind: "json", value: trimmed, url: url || undefined });
      setSourceImport(result);
      setSourceJson("");
      setSourceUrlDraft("");
      setSourcePhase("idle");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Source import failed.");
    } finally {
      setBusy(undefined);
    }
  }

  function openSourceUrl(): void {
    const trimmed = sourceUrlDraft.trim();
    if (!trimmed) return;
    void window.hynite.native.openExternal(trimmed);
    setSourcePhase("open");
    setMessage(undefined);
    setSourceImport(undefined);
  }

  function cancelSourceImport(): void {
    setSourcePhase("idle");
    setSourceJson("");
    setMessage(undefined);
  }

  async function updateMusic(patch: Partial<MusicSettings>): Promise<void> {
    const next = normalizeMusicSettings({ ...musicDraft, ...patch });
    setMusicDraft(next);
    musicEngine.applySettings(next);
    if (preview) {
      setLocalSettings({ music: next });
      return;
    }
    try {
      setSettings(await window.hynite.settings.update({ music: next }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Music settings could not be saved.");
    }
  }

  async function updateZoom(value: number): Promise<void> {
    const cardsPerRow = normalizeCardsPerRow(value);
    await updateSettings({ cardsPerRow });
  }

  const accountByLocalUsername = useMemo(() => {
    return new Map(localAccounts.map((account) => [account.accountName, account]));
  }, [localAccounts]);

  const page = (() => {
    if (step.id === "steam-web-api") {
      return (
        <StepMediaLayout
          media={onboardingMedia.steamWebApiKey}
          reduced={reduced}
          bubbles={[
            <Bubble key="api">Create the key here.</Bubble>
          ]}
        >
          <div className="onboarding-form-stack">
            <p className="onboarding-warning-text">Steam Guard mobile authenticator is required for this key.</p>
            <div className="onboarding-link-row">
              <button type="button" className="secondary-action" onClick={() => void window.hynite.native.openExternal(STEAM_WEB_API_URL)}>
                <ExternalLink size={14} />
                Open Steam key page
              </button>
              <span className={settings?.steamWebApiKey ? "onboarding-pill ready" : "onboarding-pill"}>{settings?.steamWebApiKey ? "Saved" : "Optional"}</span>
            </div>
            <label className="onboarding-field">
              <span>Steam Web API Key</span>
              <input
                className="plain-input"
                type="password"
                value={steamKeyDraft}
                onChange={(event) => setSteamKeyDraft(event.currentTarget.value)}
                placeholder={settings?.steamWebApiKey ? "Replace saved key" : "Paste Steam Web API key"}
              />
            </label>
            <button type="button" className="primary-action" disabled={!steamKeyDraft.trim() || busy === "steam-key"} onClick={() => void saveSteamKey()}>
              {busy === "steam-key" ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
              Save key
            </button>
          </div>
        </StepMediaLayout>
      );
    }

    if (step.id === "steamgriddb") {
      return (
        <StepMediaLayout
          media={onboardingMedia.steamGridDbApiKey}
          reduced={reduced}
          bubbles={[
            <Bubble key="grid">Optional cover fallback.</Bubble>
          ]}
        >
          <div className="onboarding-form-stack">
            <div className="onboarding-link-row">
              <button type="button" className="secondary-action" onClick={() => void window.hynite.native.openExternal(STEAMGRIDDB_API_URL)}>
                <ExternalLink size={14} />
                Open SteamGridDB key page
              </button>
              <span className={settings?.steamGridDbApiKey ? "onboarding-pill ready" : "onboarding-pill"}>{settings?.steamGridDbApiKey ? "Saved" : "Fallback"}</span>
            </div>
            <label className="onboarding-field">
              <span>SteamGridDB API Key</span>
              <input
                className="plain-input"
                type="password"
                value={steamGridDbDraft}
                onChange={(event) => setSteamGridDbDraft(event.currentTarget.value)}
                placeholder={settings?.steamGridDbApiKey ? "Replace saved key" : "Paste SteamGridDB API key"}
              />
            </label>
            <button type="button" className="primary-action" disabled={!steamGridDbDraft.trim() || busy === "steamgriddb-key"} onClick={() => void saveSteamGridDbKey()}>
              {busy === "steamgriddb-key" ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
              Save fallback
            </button>
          </div>
        </StepMediaLayout>
      );
    }

    if (step.id === "pair-steam") {
      return (
        <StepSplitLayout
          visual={<AccountStack accounts={accounts} />}
          bubbles={[
            <Bubble key="password" tone="warm">No Steam password is stored.</Bubble>
          ]}
        >
          <div className="onboarding-form-stack">
            <button type="button" className="primary-action" disabled={busy === "pair"} onClick={() => void pairAccount()}>
              {busy === "pair" ? <Loader2 size={15} className="spin" /> : <Link2 size={15} />}
              {accounts.length ? "Add another account" : "Pair Steam account"}
            </button>
            <div className="onboarding-list">
              {accounts.length === 0 ? (
                <div className="onboarding-empty-row">No accounts paired yet.</div>
              ) : accounts.map((account) => (
                <div className="onboarding-row" key={account.steamId}>
                  <Users size={15} />
                  <span>
                    <strong>{account.personaName ?? "Steam account"}</strong>
                    <em>{account.steamId}</em>
                  </span>
                  <Check size={15} />
                </div>
              ))}
            </div>
          </div>
        </StepSplitLayout>
      );
    }

    if (step.id === "local-steam-user") {
      return (
        <StepSplitLayout
          visual={<LocalUserMap accounts={accounts} localAccounts={localAccounts} />}
          bubbles={[]}
        >
          <div className="onboarding-form-stack">
            {accounts.length === 0 ? (
              <div className="onboarding-empty-row">Pair a Steam account first, or skip this step.</div>
            ) : accounts.map((account) => (
              <label key={account.steamId} className="onboarding-field">
                <span>{account.personaName ?? account.steamId}</span>
                <select
                  className="plain-input"
                  value={account.localUsername ?? ""}
                  onChange={(event) => void setLocalUsername(account.steamId, event.currentTarget.value)}
                >
                  <option value="">Not mapped</option>
                  {localAccounts.map((local) => (
                    <option key={local.accountName} value={local.accountName}>
                      {local.personaName ?? local.accountName}{local.mostRecent ? " (recent)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {localAccounts.length === 0 ? <div className="onboarding-empty-row">No local Steam users detected.</div> : null}
            {accounts.some((account) => account.localUsername && accountByLocalUsername.has(account.localUsername)) ? (
              <span className="onboarding-pill ready">Mapping saved</span>
            ) : null}
          </div>
        </StepSplitLayout>
      );
    }

    if (step.id === "local-games") {
      return (
        <StepSplitLayout
          visual={<LocalGamesVisual roots={localRoots} />}
          bubbles={[
            <Bubble key="scan">Pick the folder that contains your games.</Bubble>
          ]}
        >
          <div className="onboarding-form-stack">
            <button type="button" className="primary-action" onClick={() => void addLocalRoot()}>
              <FolderPlus size={15} />
              Add tracked root
            </button>
            <div className="onboarding-list">
              {localRoots.length === 0 ? (
                <div className="onboarding-empty-row">No local roots yet.</div>
              ) : localRoots.map((root) => (
                <div className="onboarding-row" key={root.path}>
                  <FolderPlus size={15} />
                  <span>
                    <strong>{shortPath(root.path)}</strong>
                    <em>Tracked</em>
                  </span>
                  <Check size={15} />
                </div>
              ))}
            </div>
          </div>
        </StepSplitLayout>
      );
    }

    if (step.id === "sources") {
      return (
        <StepPlainLayout>
          <div className="onboarding-form-stack sources-step">
            <div className="onboarding-source-helper">
              <span>
                <strong>Source URL</strong>
                <em>Use a Hydra-compatible source link, then paste the raw JSON from that page.</em>
              </span>
              <button type="button" className="secondary-action" onClick={() => void window.hynite.native.openExternal(HYDRA_SOURCES_URL)}>
                <ExternalLink size={14} />
                Browse sources
              </button>
            </div>
            <div className="onboarding-source-url-row">
              <input
                className="plain-input"
                value={sourceUrlDraft}
                onChange={(event) => setSourceUrlDraft(event.currentTarget.value)}
                placeholder="https://example.com/source.json"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && sourceUrlDraft.trim() && sourcePhase === "idle") {
                    openSourceUrl();
                  }
                }}
              />
              {sourcePhase === "idle" ? (
                <button type="button" className="secondary-action" disabled={!sourceUrlDraft.trim()} onClick={openSourceUrl}>
                  <ExternalLink size={14} />
                  Open
                </button>
              ) : (
                <button type="button" className="secondary-action" onClick={cancelSourceImport}>
                  <X size={14} />
                  Cancel
                </button>
              )}
            </div>
            {sourcePhase === "open" ? (
              <>
                <textarea
                  className="onboarding-source-textarea"
                  value={sourceJson}
                  onChange={(event) => setSourceJson(event.currentTarget.value)}
                  placeholder="Paste the JSON from the page here"
                  spellCheck={false}
                  autoFocus
                />
                <button type="button" className="primary-action" disabled={!sourceJson.trim() || busy === "source"} onClick={() => void importSource()}>
                  {busy === "source" ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
                  Save source
                </button>
              </>
            ) : null}
            {sourceImport ? (
              <span className="onboarding-pill ready">{sourceImport.name}: {sourceImport.importedEntries} entries</span>
            ) : null}
          </div>
        </StepPlainLayout>
      );
    }

    if (step.id === "music") {
      return (
        <StepSplitLayout
          visual={<MusicVisual enabled={musicSettings.enabled !== false} volume={musicSettings.volume ?? 0.04} />}
          bubbles={[]}
        >
          <div className="onboarding-audio-controls">
            <ToggleRow checked={musicSettings.enabled !== false} label="Music enabled" onChange={(checked) => void updateMusic({ enabled: checked })} />
            <SliderRow label="Volume" min={0} max={1} step={0.01} value={musicSettings.volume ?? 0.04} unit="%" onChange={(value) => void updateMusic({ volume: value })} />
            <ToggleRow checked={musicSettings.startupWithSoundEnabled === true} label="Start with startup sound" onChange={(checked) => void updateMusic({ startupWithSoundEnabled: checked })} />
            <ToggleRow checked={musicSettings.startupDelayEnabled !== false} label="Startup delay" onChange={(checked) => void updateMusic({ startupDelayEnabled: checked })} />
            <ToggleRow checked={musicSettings.fadesEnabled !== false} label="Fades" onChange={(checked) => void updateMusic({ fadesEnabled: checked })} />
            <ToggleRow checked={musicSettings.pauseOnGameLaunch !== false} label="Pause after launch" onChange={(checked) => void updateMusic({ pauseOnGameLaunch: checked })} />
            <ToggleRow checked={musicSettings.pauseOnFocusLoss !== false} label="Pause without focus" onChange={(checked) => void updateMusic({ pauseOnFocusLoss: checked })} />
            <ToggleRow checked={musicSettings.pauseOnSystemAudio !== false} label="Pause on media" onChange={(checked) => void updateMusic({ pauseOnSystemAudio: checked })} />
            <ToggleRow checked={musicSettings.continuousPlay === true} label="Continuous play" onChange={(checked) => void updateMusic({ continuousPlay: checked })} />
          </div>
        </StepSplitLayout>
      );
    }

    if (step.id === "zoom") {
      return (
        <StepSplitLayout
          visual={<ZoomPreview cardsPerRow={cardsPerRow} />}
          bubbles={[]}
        >
          <div className="onboarding-form-stack">
            <label className="onboarding-zoom-control">
              <span>Cards per row</span>
              <input
                type="range"
                min={MIN_CARDS_PER_ROW}
                max={MAX_CARDS_PER_ROW}
                step={1}
                value={cardsPerRow}
                style={{ "--zoom-fill": zoomFill(cardsPerRow) } as CSSProperties}
                onChange={(event) => void updateZoom(Number(event.currentTarget.value))}
              />
              <strong>{cardsPerRow}</strong>
            </label>
          </div>
        </StepSplitLayout>
      );
    }

    return (
      <StepVisualOnlyLayout>
        <PreparingVisual tasks={Object.values(tasks)} syncStatus={syncStatus} />
      </StepVisualOnlyLayout>
    );
  })();

  return (
    <div className="onboarding-shell">
      <OnboardingTitleBar />
      <main className="onboarding-stage">
        {musicPlaying ? (
          <button
            type="button"
            className="onboarding-mute-hint"
            onClick={() => void updateMusic({ enabled: false })}
          >
            click me to mute music
          </button>
        ) : null}
        <section className="onboarding-panel">
          {message ? <div className="onboarding-message">{message}</div> : null}
          <AnimatePresence mode="wait">
            <motion.div
              key={step.id}
              className="onboarding-step-body"
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, x: -14 }}
              transition={{ duration: reduced ? 0.08 : 0.22, ease: "easeOut" }}
            >
              {page}
            </motion.div>
          </AnimatePresence>
          <footer className="onboarding-footer">
            <button type="button" className="secondary-action" disabled={stepIndex === 0 || step.id === "preparing"} onClick={previousStep}>
              <ChevronLeft size={14} />
              Back
            </button>
            <div className="onboarding-footer-progress">
              <div className="onboarding-steps" aria-label={`Onboarding progress: ${step.title}`}>
                {STEPS.map((item, index) => (
                  <span key={item.id} className={index === stepIndex ? "active" : index < stepIndex ? "complete" : undefined} />
                ))}
              </div>
            </div>
            <div className="onboarding-footer-right">
              <button type="button" className="secondary-action" disabled={busy === "complete"} onClick={() => void complete(true)}>
                Skip onboarding
              </button>
              <button type="button" className="primary-action" disabled={step.id === "preparing" && !canContinueFromPreparing} onClick={nextStep}>
                {step.id === "preparing" && !canContinueFromPreparing ? <Loader2 size={15} className="spin" /> : step.id === "zoom" || step.id === "preparing" ? <Check size={15} /> : <ChevronRight size={15} />}
                {step.id === "preparing" ? "Enter Hynite" : step.id === "zoom" ? "Finish" : "Continue"}
              </button>
            </div>
          </footer>
        </section>
      </main>
    </div>
  );
}

function StepMediaLayout({
  media,
  reduced,
  bubbles,
  children
}: {
  media: OnboardingMediaAsset;
  reduced: boolean;
  bubbles: ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="onboarding-media-layout">
      <div className="onboarding-media-frame">
        {mediaSources(media, reduced)}
        {bubbles.length ? <div className="onboarding-bubble-stack">{bubbles}</div> : null}
      </div>
      <div className="onboarding-side">{children}</div>
    </div>
  );
}

function StepSplitLayout({
  visual,
  bubbles,
  children
}: {
  visual: ReactNode;
  bubbles: ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="onboarding-split-layout">
      <div className="onboarding-visual">
        {visual}
        {bubbles.length ? <div className="onboarding-bubble-stack">{bubbles}</div> : null}
      </div>
      <div className="onboarding-side">{children}</div>
    </div>
  );
}

function StepVisualOnlyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="onboarding-visual-only-layout">
      <div className="onboarding-visual">{children}</div>
    </div>
  );
}

function StepPlainLayout({ children }: { children: ReactNode }) {
  return (
    <div className="onboarding-plain-layout">
      <div className="onboarding-side">{children}</div>
    </div>
  );
}

function AccountStack({ accounts }: { accounts: SteamAccountSettings[] }) {
  return (
    <div className="account-stack-visual">
      {(accounts.length ? accounts : [makePreviewAccount(0), makePreviewAccount(1)]).slice(0, 3).map((account, index) => (
        <div key={account.steamId} className="account-stack-card" style={{ "--offset": index } as CSSProperties}>
          <Users size={18} />
          <span>
            <strong>{account.personaName ?? "Steam account"}</strong>
            <em>{account.steamId}</em>
          </span>
        </div>
      ))}
    </div>
  );
}

function LocalUserMap({ accounts, localAccounts }: { accounts: SteamAccountSettings[]; localAccounts: SteamLocalAccount[] }) {
  return (
    <div className="local-map-visual">
      {(accounts.length ? accounts : [makePreviewAccount(0)]).slice(0, 2).map((account, index) => (
        <div className="local-map-line" key={account.steamId}>
          <span>{account.personaName ?? "SteamID"}</span>
          <strong>{account.localUsername ?? localAccounts[index]?.accountName ?? "local user"}</strong>
        </div>
      ))}
    </div>
  );
}

function LocalGamesVisual({ roots }: { roots: LocalRoot[] }) {
  return (
    <div className="local-games-visual">
      <div className="folder-tree">
        <strong>{roots[0] ? shortPath(roots[0].path) : "G:\\Games"}</strong>
        <span>Game Folder</span>
        <span>Launcher.exe</span>
      </div>
      <RefreshCw size={28} />
    </div>
  );
}

function MusicVisual({ enabled, volume }: { enabled: boolean; volume: number }) {
  const bars = [0.44, 0.72, 0.35, 0.9, 0.56, 0.68];
  return (
    <div className={enabled ? "music-visual playing" : "music-visual"}>
      {enabled ? <Volume2 size={30} /> : <VolumeX size={30} />}
      <div className="music-bars" style={{ "--music-volume": volume } as CSSProperties}>
        {bars.map((bar, index) => <span key={index} style={{ "--bar": bar } as CSSProperties} />)}
      </div>
      <strong>{Math.round(volume * 100)}%</strong>
    </div>
  );
}

function ZoomPreview({ cardsPerRow }: { cardsPerRow: number }) {
  const items = Array.from({ length: MAX_CARDS_PER_ROW * 6 }, (_, index) => index);
  return (
    <div className="zoom-preview-frame">
      <div className="zoom-preview-rail" />
      <div className="zoom-preview-grid" style={{ "--zoom-preview-columns": cardsPerRow } as CSSProperties}>
        {items.map((item) => <span key={item} />)}
      </div>
    </div>
  );
}

function shortProgressText(value: string, limit = 44): string {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

function taskTooltip(task: OnboardingTask, syncStatus?: SyncStatus): string {
  if (task.id === "steam" && syncStatus?.active) {
    const total = syncStatus.total;
    const current = syncStatus.current ?? 0;
    return typeof total === "number" && total > 0
      ? `${syncStatus.message} (${Math.min(current, total)}/${total})`
      : syncStatus.message;
  }
  return task.message;
}

function taskTitle(task: OnboardingTask): string {
  return task.id === "steam" ? "Steam sync" : "Local scan";
}

function PreparingVisual({ tasks, syncStatus }: { tasks: OnboardingTask[]; syncStatus?: SyncStatus }) {
  const activeTask = tasks.find((task) => task.status === "running")
    ?? tasks.find((task) => task.status === "warning")
    ?? tasks.find((task) => task.status === "success")
    ?? tasks[0];
  const running = activeTask?.status === "running";
  const title = activeTask ? taskTitle(activeTask) : "Ready";
  const tooltip = activeTask ? taskTooltip(activeTask, syncStatus) : "Setup complete";
  return (
    <div className="preparing-visual">
      {running ? <Loader2 size={34} className="spin" /> : <Check size={34} />}
      <span className="preparing-title-wrap">
        <strong>{running ? title : "Ready"}</strong>
        <span className="preparing-tooltip">{shortProgressText(tooltip, 96)}</span>
      </span>
    </div>
  );
}
