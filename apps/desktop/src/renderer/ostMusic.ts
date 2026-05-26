import type { AppSettings, MusicSettings, OstResolveResult, OstSettings } from "@hynite/core";

export type OstStatus = {
  active: boolean;
  audible: boolean;
  playing: boolean;
  enabled: boolean;
  userMuted: boolean;
  focused: boolean;
  pauseReason: string | null;
  loading: boolean;
  loadingMessage: string | null;
  currentGameId: string | null;
  currentGameTitle: string | null;
  currentVideoId: string | null;
  currentVideoTitle: string | null;
  currentChannel: string | null;
  lastError: string | null;
};

const DEFAULT_VOLUME = 0.04;
const MAX_RESOLVE_ATTEMPTS = 4;

type FadeKey = "startupWithSoundFadeInMs" | "trackFadeInMs" | "pauseFadeOutMs" | "resumeFadeInMs" | "gameLaunchFadeOutMs";
const FADE_DEFAULTS: Record<FadeKey, number> = {
  startupWithSoundFadeInMs: 8_000,
  trackFadeInMs: 5_000,
  pauseFadeOutMs: 2_000,
  resumeFadeInMs: 1_500,
  gameLaunchFadeOutMs: 600
};

function clampVol(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function clampMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

/**
 * OST playback engine. Mirrors MusicEngine's lifecycle (startup delay, fades,
 * focus/launch pauses, user mute) but plays HTMLAudioElement-backed streams
 * from cached YouTube downloads.
 *
 * Notes on system audio: HTMLAudioElement registers as a Windows SMTC media
 * session. That means our own playback triggers the global "pauseOnSystemAudio"
 * detector. We deliberately ignore that signal here — the setting still applies
 * to the local MusicEngine, but not to us, because the "external" media is us.
 */
export class OstMusicEngine {
  private settings: MusicSettings = {};
  private osts: OstSettings = {};
  private active = false;
  private audible = false;
  private focused = true;
  private userMuted = false;
  private localMediaActive = false;
  private launchPauseActive = false;
  private launchPauseSawBlur = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingPauseTimer: ReturnType<typeof setTimeout> | undefined;
  private nextResumeMode: "resume" | "startupWithSound" = "resume";

  private audio: HTMLAudioElement | undefined;
  private context: AudioContext | undefined;
  private masterGain: GainNode | undefined;
  private mediaSource: MediaElementAudioSourceNode | undefined;

  private currentGameId: string | null = null;
  private currentGameTitle: string | null = null;
  private currentVideoId: string | null = null;
  private currentVideoTitle: string | null = null;
  private currentChannel: string | null = null;
  private lastError: string | null = null;
  private loading = false;
  private loadingMessage: string | null = null;
  private recentGameIds: string[] = [];

  // Monotonic token: every state-changing request bumps this. Async work checks
  // its captured token before mutating state, so stale callbacks become no-ops.
  private opToken = 0;

  // Big Picture follow-mode: when set, the engine plays this game and loops
  // its OST instead of rotating through the source-mode queue.
  private followedGameId: string | null = null;
  private followDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  private subscribers = new Set<(status: OstStatus) => void>();
  private progressUnsubscribe: (() => void) | undefined;

  subscribe(callback: (status: OstStatus) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getStatus(): OstStatus {
    let pauseReason: string | null = null;
    if (this.active && this.osts.enabled && !this.audible) {
      if (this.startupTimer) pauseReason = "waiting for startup";
      else if (this.launchPauseActive) pauseReason = "game launched";
      else if (this.userMuted) pauseReason = "muted";
      else if (this.localMediaActive) pauseReason = "trailer playing";
      else if (this.settings.pauseOnFocusLoss !== false && !this.focused) pauseReason = "not focused";
      else pauseReason = "paused";
    }
    return {
      active: this.active,
      audible: this.audible,
      playing: Boolean(this.audio && !this.audio.paused),
      enabled: this.osts.enabled === true,
      userMuted: this.userMuted,
      focused: this.focused,
      pauseReason,
      loading: this.loading,
      loadingMessage: this.loadingMessage,
      currentGameId: this.currentGameId,
      currentGameTitle: this.currentGameTitle,
      currentVideoId: this.currentVideoId,
      currentVideoTitle: this.currentVideoTitle,
      currentChannel: this.currentChannel,
      lastError: this.lastError
    };
  }

  applySettings(settings: AppSettings | MusicSettings | undefined): void {
    const music = settings && "sound" in (settings as AppSettings)
      ? (settings as AppSettings).music ?? {}
      : (settings as MusicSettings | undefined) ?? {};
    this.settings = music;
    const osts = music.osts ?? {};
    const wasEnabled = this.osts.enabled === true;
    const nowEnabled = osts.enabled === true;
    this.osts = osts;
    this.applyVolume();
    if (wasEnabled && !nowEnabled) {
      this.stop();
    } else if (!wasEnabled && nowEnabled && this.active) {
      this.maybeStart();
    }
    this.emit();
  }

  onStartupComplete(options: { skipStartupDelay?: boolean } = {}): void {
    if (this.active) return;
    this.active = true;
    this.startListeners();
    if (!this.osts.enabled) { this.emit(); return; }
    if (options.skipStartupDelay) { this.maybeStart(); return; }
    if (this.settings.startupWithSoundEnabled === true) {
      this.nextResumeMode = "startupWithSound";
      this.maybeStart();
      return;
    }
    if (!this.settings.startupDelayEnabled || !this.settings.startupDelayMs) {
      this.maybeStart();
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      this.maybeStart();
    }, clampMs(this.settings.startupDelayMs, 5_000));
    this.emit();
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (this.launchPauseActive && !focused) this.launchPauseSawBlur = true;
    if (this.launchPauseActive && focused && this.launchPauseSawBlur) {
      this.launchPauseActive = false;
      this.launchPauseSawBlur = false;
    }
    this.onAudibilityChanged();
  }

  /** No-op — see class comment. We never pause on system audio. */
  setSystemAudioActive(_active: boolean): void { /* intentional */ }

  /**
   * In-app HTMLMediaElement playback (e.g. a trailer). Unlike SMTC — which we
   * trigger ourselves and therefore ignore — a trailer is genuinely separate
   * audio the user wants to hear, so we pause OST while it plays. Our own
   * playback uses a detached `new Audio()` and won't reach a document-level
   * capture listener, so this signal won't false-trigger on us.
   */
  setLocalMediaActive(active: boolean): void {
    if (this.localMediaActive === active) return;
    this.localMediaActive = active;
    this.onAudibilityChanged();
  }

  setUserMuted(muted: boolean): void {
    if (this.userMuted === muted) return;
    this.userMuted = muted;
    this.onAudibilityChanged();
  }

  onGameLaunch(): void {
    if (this.settings.pauseOnGameLaunch === false) return;
    this.launchPauseActive = true;
    this.launchPauseSawBlur = !this.focused;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.audible) {
      this.audible = false;
      this.fadeOut(this.fadeMs("gameLaunchFadeOutMs"));
    }
    this.emit();
  }

  private fadeMs(key: FadeKey): number {
    if (this.settings.fadesEnabled === false) return 0;
    return Math.max(0, this.settings[key] ?? FADE_DEFAULTS[key]);
  }

  skipToNext(): void {
    if (!this.osts.enabled) return;
    void this.startNextTrack(this.fadeMs("trackFadeInMs"));
  }

  /** Hard stop: pause audio and clear current-track info. Engine remains active
   *  and will resume on next play action. */
  stopPlayback(): void {
    this.stop();
  }

  /**
   * Big Picture reactive: lock the engine to a specific game. When set, the
   * engine plays that game's OST and replays it on end (looping). Pass null
   * to release the lock and resume normal source-mode rotation.
   *
   * Debounced ~600 ms so rapidly scrolling the carousel doesn't fire searches
   * for every focused tile.
   */
  followGame(gameId: string | null): void {
    if (this.followDebounceTimer) {
      clearTimeout(this.followDebounceTimer);
      this.followDebounceTimer = undefined;
    }
    if (gameId === null) {
      this.followedGameId = null;
      return;
    }
    if (this.followedGameId === gameId && this.currentGameId === gameId) {
      // Already on this game — no-op.
      return;
    }
    this.followDebounceTimer = setTimeout(() => {
      this.followDebounceTimer = undefined;
      this.followedGameId = gameId;
      if (this.osts.enabled) void this.playForGame(gameId);
    }, 500);
  }

  async playForGame(gameId: string): Promise<boolean> {
    if (!this.osts.enabled) return false;
    if (!this.audible) {
      // Allow Play-now to override paused state (e.g. user is testing while
      // window is blurred). Setting active+audible lets the new track play.
      this.active = true;
      this.startListeners();
      this.audible = true;
    }
    const token = ++this.opToken;

    // Fade the currently playing OST out and detach it immediately, before
    // the new game's metadata resolves. Without this, the old track keeps
    // playing at full volume for the entire resolve+stream-start window
    // (often 3-5 s) which makes BP carousel switches feel sluggish. The
    // detach is critical so the subsequent playUrl doesn't hard-pause our
    // mid-ramp audio.
    this.fadeOutAndDetach(this.fadeMs("pauseFadeOutMs"));
    this.currentGameId = null;
    this.currentVideoId = null;
    this.currentVideoTitle = null;
    this.currentChannel = null;

    this.beginLoading("Loading soundtrack…");
    const result = await window.hynite.ost.resolveForGame(gameId);
    if (token !== this.opToken) return false;
    if (result.kind !== "ready") {
      this.finishLoadingWithError(this.errorReason(result));
      return false;
    }
    this.applyResolved(result, token);
    await this.playUrl(window.hynite.ost.trackUrl(result.soundtrack.videoId), this.fadeMs("trackFadeInMs"), token);
    void window.hynite.ost.markPlayed(result.gameId).catch(() => undefined);
    return true;
  }

  /**
   * Fade current audio's gain to zero, then disconnect/pause it. Differs from
   * fadeOut() (used for focus/system pause) in that this detaches the audio
   * element entirely — useful when switching to a new track since we won't
   * need to resume the old one. Safe to call when no audio is playing.
   */
  private fadeOutAndDetach(fadeMs: number): void {
    const audio = this.audio;
    if (!audio) return;
    const mediaSource = this.mediaSource;
    const ctx = this.context;
    const gain = this.masterGain;
    if (ctx && gain) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      if (fadeMs > 0) {
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeMs / 1000);
      } else {
        gain.gain.setValueAtTime(0, ctx.currentTime);
      }
    }
    if (this.pendingPauseTimer) clearTimeout(this.pendingPauseTimer);
    const delay = Math.max(0, fadeMs + 100);
    setTimeout(() => {
      try { audio.pause(); } catch { /* ignore */ }
      try { mediaSource?.disconnect(); } catch { /* ignore */ }
    }, delay);
    // Detach immediately so subsequent calls operate on the new track.
    this.audio = undefined;
    this.mediaSource = undefined;
  }

  // ────────────────────────────────────────────────────────────────────────

  private startListeners(): void {
    if (this.progressUnsubscribe) return;
    // We intentionally do NOT subscribe to system-audio. See class comment.
    this.progressUnsubscribe = window.hynite.ost.onProgress((progress) => {
      if (progress.phase === "diagnostic") {
        console.log(`[OST] ${progress.message ?? ""} (game=${progress.gameId})`);
        return;
      }
      // We only update messaging while we're showing the loading chip.
      if (!this.loading) return;
      if (this.currentGameId && progress.gameId && progress.gameId !== this.currentGameId) return;
      if (progress.phase === "searching") {
        this.loadingMessage = "Searching YouTube…";
      } else if (progress.phase === "error") {
        this.lastError = progress.message ?? "Soundtrack search failed.";
      }
      // "downloading" and "ready" are not user-visible: playback begins as soon
      // as the audio element gets enough bytes, and the cache fills behind it.
      this.emit();
    });
  }

  private shouldBeAudible(): boolean {
    if (!this.osts.enabled || !this.active) return false;
    if (this.launchPauseActive || this.userMuted) return false;
    if (this.localMediaActive) return false;
    if (this.settings.pauseOnFocusLoss !== false && !this.focused) return false;
    return true;
  }

  private onAudibilityChanged(): void {
    if (!this.active || this.startupTimer) { this.emit(); return; }
    const should = this.shouldBeAudible();
    if (should && !this.audible) {
      this.audible = true;
      const mode = this.nextResumeMode;
      this.nextResumeMode = "resume";
      const fadeMs = this.fadeMs(mode === "startupWithSound" ? "startupWithSoundFadeInMs" : "resumeFadeInMs");
      if (!this.audio) {
        void this.startNextTrack(fadeMs);
      } else {
        this.fadeIn(fadeMs);
        void this.audio.play().catch(() => undefined);
      }
    } else if (!should && this.audible) {
      this.audible = false;
      this.fadeOut(this.fadeMs("pauseFadeOutMs"));
    }
    this.emit();
  }

  private maybeStart(): void {
    if (!this.osts.enabled) { this.emit(); return; }
    if (!this.shouldBeAudible()) { this.emit(); return; }
    this.audible = true;
    const mode = this.nextResumeMode;
    this.nextResumeMode = "resume";
    const fadeMs = this.fadeMs(mode === "startupWithSound" ? "startupWithSoundFadeInMs" : "trackFadeInMs");
    void this.startNextTrack(fadeMs);
    this.emit();
  }

  private ensureContext(): { context: AudioContext; gain: GainNode } | undefined {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return undefined;
      this.context = new Ctor({ latencyHint: "playback" });
      this.masterGain = this.context.createGain();
      // GainNode defaults to 1.0; setValueAtTime(0, 0) alone doesn't reliably
      // update the readable .value on a suspended context, so subsequent reads
      // of gain.value return 1.0 and fadeIn ramps DOWN from 1.0 instead of UP
      // from 0 — audible as a loud start that "adapts" to the target volume.
      this.masterGain.gain.value = 0;
      this.masterGain.gain.setValueAtTime(0, 0);
      this.masterGain.connect(this.context.destination);
      const unlock = () => {
        if (this.context && this.context.state !== "running") void this.context.resume().catch(() => undefined);
      };
      window.addEventListener("pointerdown", unlock, { passive: true });
      window.addEventListener("keydown", unlock);
    }
    return this.context && this.masterGain ? { context: this.context, gain: this.masterGain } : undefined;
  }

  private applyVolume(): void {
    if (!this.audible) return;
    const ctx = this.context;
    const gain = this.masterGain;
    if (!ctx || !gain) return;
    gain.gain.setTargetAtTime(clampVol(this.settings.volume, DEFAULT_VOLUME), ctx.currentTime, 0.015);
  }

  private fadeIn(fadeMs: number): void {
    const setup = this.ensureContext();
    if (!setup) return;
    if (this.pendingPauseTimer) {
      clearTimeout(this.pendingPauseTimer);
      this.pendingPauseTimer = undefined;
    }
    const target = clampVol(this.settings.volume, DEFAULT_VOLUME);
    setup.gain.gain.cancelScheduledValues(setup.context.currentTime);
    setup.gain.gain.setValueAtTime(setup.gain.gain.value, setup.context.currentTime);
    if (fadeMs > 0) {
      setup.gain.gain.linearRampToValueAtTime(target, setup.context.currentTime + fadeMs / 1000);
    } else {
      setup.gain.gain.setValueAtTime(target, setup.context.currentTime);
    }
  }

  private fadeOut(fadeMs: number): void {
    const ctx = this.context;
    const gain = this.masterGain;
    if (!ctx || !gain || !this.audio) return;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    if (fadeMs > 0) {
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeMs / 1000);
      const audio = this.audio;
      if (this.pendingPauseTimer) clearTimeout(this.pendingPauseTimer);
      this.pendingPauseTimer = setTimeout(() => {
        this.pendingPauseTimer = undefined;
        try { audio.pause(); } catch { /* ignore */ }
      }, fadeMs + 100);
    } else {
      gain.gain.setValueAtTime(0, ctx.currentTime);
      try { this.audio.pause(); } catch { /* ignore */ }
    }
  }

  private stop(): void {
    this.opToken += 1; // invalidate any in-flight resolves
    if (this.audio) {
      try { this.audio.pause(); } catch { /* ignore */ }
      this.audio.src = "";
      this.audio = undefined;
    }
    if (this.mediaSource) {
      try { this.mediaSource.disconnect(); } catch { /* ignore */ }
      this.mediaSource = undefined;
    }
    this.audible = false;
    this.currentGameId = null;
    this.currentGameTitle = null;
    this.currentVideoId = null;
    this.currentVideoTitle = null;
    this.currentChannel = null;
    this.loading = false;
    this.loadingMessage = null;
    this.emit();
  }

  private beginLoading(message: string): void {
    this.loading = true;
    this.loadingMessage = message;
    this.lastError = null;
    this.emit();
  }

  private finishLoadingWithError(reason: string): void {
    this.lastError = reason;
    this.loading = false;
    this.loadingMessage = null;
    this.emit();
  }

  private errorReason(result: OstResolveResult): string {
    return "reason" in result && result.reason ? result.reason : "Could not resolve soundtrack.";
  }

  private applyResolved(result: Extract<OstResolveResult, { kind: "ready" }>, token: number): void {
    if (token !== this.opToken) return;
    this.currentGameId = result.gameId;
    this.currentGameTitle = result.gameTitle;
    this.currentVideoId = result.soundtrack.videoId;
    this.currentVideoTitle = result.soundtrack.videoTitle ?? null;
    this.currentChannel = result.soundtrack.channel ?? null;
    this.recentGameIds = [result.gameId, ...this.recentGameIds.filter((id) => id !== result.gameId)].slice(0, 5);
    this.loading = false;
    this.loadingMessage = null;
    this.emit();
  }

  private async startNextTrack(fadeMs: number = this.fadeMs("trackFadeInMs")): Promise<void> {
    if (!this.osts.enabled) return;
    const token = ++this.opToken;

    // Clear current-track state so the now-playing chip doesn't display stale
    // info while we resolve. The loading chip takes its place.
    this.currentGameId = null;
    this.currentVideoId = null;
    this.currentVideoTitle = null;
    this.currentChannel = null;
    this.beginLoading("Loading soundtrack…");

    let result: OstResolveResult | undefined;
    const exclude = [...this.recentGameIds];
    for (let attempt = 0; attempt < MAX_RESOLVE_ATTEMPTS; attempt += 1) {
      result = await window.hynite.ost.resolveNext(exclude);
      if (token !== this.opToken) return;
      if (result.kind === "ready") break;
      if (result.kind === "no-game") {
        this.finishLoadingWithError(result.reason);
        return;
      }
      if (result.kind === "no-pick" || result.kind === "error") {
        if ("gameId" in result && result.gameId) exclude.push(result.gameId);
        this.lastError = result.reason;
        continue;
      }
    }
    if (!result || result.kind !== "ready") {
      this.finishLoadingWithError(this.lastError ?? "No soundtrack found.");
      return;
    }
    this.applyResolved(result, token);
    await this.playUrl(window.hynite.ost.trackUrl(result.soundtrack.videoId), fadeMs, token);
    void window.hynite.ost.markPlayed(result.gameId).catch(() => undefined);
  }

  private async playUrl(url: string, fadeMs: number, token: number): Promise<void> {
    if (token !== this.opToken) return;
    const setup = this.ensureContext();
    if (!setup) return;
    if (this.audio) {
      try { this.audio.pause(); } catch { /* ignore */ }
    }
    if (this.mediaSource) {
      try { this.mediaSource.disconnect(); } catch { /* ignore */ }
      this.mediaSource = undefined;
    }

    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.src = url;
    this.audio = audio;
    try {
      this.mediaSource = setup.context.createMediaElementSource(audio);
      this.mediaSource.connect(setup.gain);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit();
      return;
    }

    audio.addEventListener("ended", () => {
      if (this.audio !== audio) return;
      this.audio = undefined;
      // Follow-mode (BP reactive): replay the locked game's OST. Cache hit, so
      // it's instant.
      if (this.followedGameId && this.audible) {
        void this.playForGame(this.followedGameId);
        return;
      }
      if (this.osts.rotateOnEachTrack) this.recentGameIds = [];
      if (this.audible) void this.startNextTrack(this.fadeMs("trackFadeInMs"));
    });
    audio.addEventListener("error", () => {
      if (this.audio !== audio) return;
      this.lastError = "Playback error";
      this.audio = undefined;
      if (this.audible) void this.startNextTrack(this.fadeMs("trackFadeInMs"));
    });

    // Clear the loading chip the moment the audio element starts actually
    // playing — with streaming, that's typically 1-3 s after src is set,
    // not after a full download.
    audio.addEventListener("playing", () => {
      if (this.audio !== audio) return;
      if (this.loading) {
        this.loading = false;
        this.loadingMessage = null;
        this.emit();
      }
    }, { once: true });

    this.fadeIn(fadeMs);
    try {
      await audio.play();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emit();
    }
  }

  private emit(): void {
    if (!this.subscribers.size) return;
    const status = this.getStatus();
    for (const callback of this.subscribers) callback(status);
  }
}

export const ostMusicEngine = new OstMusicEngine();
