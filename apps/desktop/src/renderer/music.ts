import type { AppSettings, MusicSettings, MusicTrack } from "@hynite/core";

const DEFAULT_MUSIC_SETTINGS: Required<Omit<MusicSettings, "tracks">> & { tracks: NonNullable<MusicSettings["tracks"]> } = {
  enabled: true,
  volume: 0.04,
  tracks: [],
  startupDelayEnabled: true,
  startupDelayMs: 5_000,
  startupWithSoundEnabled: false,
  startupWithSoundFadeInMs: 8_000,
  fadesEnabled: true,
  trackFadeInMs: 5_000,
  pauseFadeOutMs: 2_000,
  resumeFadeInMs: 1_500,
  gameLaunchFadeOutMs: 600,
  pauseOnGameLaunch: true,
  pauseOnFocusLoss: true,
  pauseOnSystemAudio: true,
  continuousPlay: false,
  gapMinMs: 30_000,
  gapMaxMs: 120_000
};

export type MusicStatus = {
  active: boolean;
  audible: boolean;
  playing: boolean;
  inGap: boolean;
  focused: boolean;
  systemAudioActive: boolean;
  settingsEnabled: boolean;
  hasTracks: boolean;
  pauseReason: string | null;
  queue: number[];
  queueIndex: number;
  prevQueueTail: number[];
  currentTrackIndex: number | null;
  currentTrackTitle: string | null;
  currentTrackArtist: string | null;
  currentTrackAlbum: string | null;
  currentTrackCopyright: string | null;
};

type TrackCache = { filePath: string; buffer: AudioBuffer };
type AudioWindow = Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext };

type PausedState =
  | { kind: "playing"; buffer: AudioBuffer; positionS: number }
  | { kind: "gap"; gapEndsAt: number }
  | { kind: "none" };

function clampVol(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function clampMs(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function normalizeMusicSettings(settings?: MusicSettings): MusicSettings {
  const gapMinMs = clampMs(settings?.gapMinMs, DEFAULT_MUSIC_SETTINGS.gapMinMs, 0, 600_000);
  const gapMaxMs = clampMs(settings?.gapMaxMs, DEFAULT_MUSIC_SETTINGS.gapMaxMs, 0, 600_000);
  return {
    enabled: settings?.enabled !== false,
    volume: clampVol(settings?.volume, DEFAULT_MUSIC_SETTINGS.volume),
    tracks: Array.isArray(settings?.tracks)
      ? settings.tracks.filter((t) => typeof t?.filePath === "string" && t.filePath.trim())
      : [],
    startupDelayEnabled: settings?.startupDelayEnabled !== false,
    startupDelayMs: clampMs(settings?.startupDelayMs, DEFAULT_MUSIC_SETTINGS.startupDelayMs, 0, 60_000),
    startupWithSoundEnabled: settings?.startupWithSoundEnabled === true,
    startupWithSoundFadeInMs: clampMs(settings?.startupWithSoundFadeInMs, DEFAULT_MUSIC_SETTINGS.startupWithSoundFadeInMs, 0, 60_000),
    fadesEnabled: settings?.fadesEnabled !== false,
    trackFadeInMs: clampMs(settings?.trackFadeInMs, DEFAULT_MUSIC_SETTINGS.trackFadeInMs, 0, 30_000),
    pauseFadeOutMs: clampMs(settings?.pauseFadeOutMs, DEFAULT_MUSIC_SETTINGS.pauseFadeOutMs, 0, 30_000),
    resumeFadeInMs: clampMs(settings?.resumeFadeInMs, DEFAULT_MUSIC_SETTINGS.resumeFadeInMs, 0, 30_000),
    gameLaunchFadeOutMs: clampMs(settings?.gameLaunchFadeOutMs, DEFAULT_MUSIC_SETTINGS.gameLaunchFadeOutMs, 0, 10_000),
    pauseOnGameLaunch: settings?.pauseOnGameLaunch !== false,
    pauseOnFocusLoss: settings?.pauseOnFocusLoss !== false,
    pauseOnSystemAudio: settings?.pauseOnSystemAudio !== false,
    continuousPlay: settings?.continuousPlay === true,
    gapMinMs: Math.min(gapMinMs, gapMaxMs),
    gapMaxMs: Math.max(gapMinMs, gapMaxMs)
  };
}

export { normalizeMusicSettings };

function isAppSettings(value: AppSettings | MusicSettings | undefined): value is AppSettings {
  return Boolean(value && ("sound" in value || "steamAccounts" in value));
}

function trackFileName(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function trackTitle(track?: MusicTrack): string | null {
  return track?.title ?? trackFileName(track?.filePath) ?? null;
}

export class MusicEngine {
  private userSettings: MusicSettings = normalizeMusicSettings();
  private settings: MusicSettings = normalizeMusicSettings();
  private forceEnabled = false;
  private forceContinuous = false;

  // Audio graph: source → trackGain → masterGain → destination
  // masterGain: overall volume + audibility fades
  // trackGain: per-track fade-in envelope for new tracks, 1 when resuming mid-track
  private context: AudioContext | undefined;
  private masterGain: GainNode | undefined;
  private trackGain: GainNode | undefined;
  private currentSource: AudioBufferSourceNode | undefined;
  private currentBuffer: AudioBuffer | undefined;
  private currentTrackIndex: number | null = null;
  private sourceStartedAtCtxTime = 0;
  private sourceStartOffset = 0;

  private cache = new Map<number, TrackCache>();
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  private gapEndsAt: number | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private systemAudioUnsubscribe: (() => void) | undefined;

  private focused = true;
  private systemAudioActive = false;
  private active = false;
  private audible = false; // whether we're currently outputting sound (not paused)
  private playing = false; // whether a source node is alive
  private inGap = false;
  private launchPauseActive = false;
  private launchPauseSawBlur = false;

  // Shuffle queue: every track plays exactly once per pass before any repeat.
  // When a queue ends, the next one is generated avoiding the previous queue's
  // last 2 indices in its first 2 slots.
  private queue: number[] = [];
  private queueIndex = 0;
  private prevQueueTail: number[] = [];

  // Virtual position state (populated when we pause mid-track or mid-gap)
  private pausedState: PausedState | undefined;
  private pausedAt: number | undefined;

  private unlockListenersInstalled = false;
  private subscribers = new Set<(status: MusicStatus) => void>();

  subscribe(cb: (status: MusicStatus) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  getStatus(): MusicStatus {
    const settingsEnabled = this.settings.enabled !== false;
    const hasTracks = (this.settings.tracks?.length ?? 0) > 0;
    const currentTrack = this.currentTrackIndex === null ? undefined : this.settings.tracks?.[this.currentTrackIndex];
    let pauseReason: string | null = null;
    if (this.active && settingsEnabled && hasTracks && !this.audible) {
      if (this.startupTimer) pauseReason = "waiting for startup";
      else if (this.launchPauseActive) pauseReason = "game launched";
      else if (this.settings.pauseOnFocusLoss !== false && !this.focused) pauseReason = "not focused";
      else if (this.settings.pauseOnSystemAudio !== false && this.systemAudioActive) pauseReason = "system audio detected";
      else pauseReason = "paused";
    }
    return {
      active: this.active,
      audible: this.audible,
      playing: this.playing,
      inGap: this.inGap,
      focused: this.focused,
      systemAudioActive: this.systemAudioActive,
      settingsEnabled,
      hasTracks,
      pauseReason,
      queue: [...this.queue],
      queueIndex: this.queueIndex,
      prevQueueTail: [...this.prevQueueTail],
      currentTrackIndex: this.currentTrackIndex,
      currentTrackTitle: trackTitle(currentTrack),
      currentTrackArtist: currentTrack?.artist ?? null,
      currentTrackAlbum: currentTrack?.album ?? null,
      currentTrackCopyright: currentTrack?.copyright ?? null
    };
  }

  private deriveEffectiveSettings(user: MusicSettings): MusicSettings {
    if (!this.forceEnabled && !this.forceContinuous) return user;
    return {
      ...user,
      enabled: this.forceEnabled ? true : user.enabled,
      continuousPlay: this.forceContinuous ? true : user.continuousPlay
    };
  }

  setForcedOverrides(next: { forceEnabled?: boolean; forceContinuous?: boolean }): void {
    const forceEnabled = next.forceEnabled ?? this.forceEnabled;
    const forceContinuous = next.forceContinuous ?? this.forceContinuous;
    if (forceEnabled === this.forceEnabled && forceContinuous === this.forceContinuous) return;
    this.forceEnabled = forceEnabled;
    this.forceContinuous = forceContinuous;
    this.applyDerivedSettings();
  }

  private applyDerivedSettings(): void {
    const derived = this.deriveEffectiveSettings(this.userSettings);
    this.reactToSettings(derived);
  }

  applySettings(settings: AppSettings | MusicSettings | undefined): void {
    const userNext = normalizeMusicSettings(isAppSettings(settings) ? settings.music : (settings as MusicSettings | undefined));
    this.userSettings = userNext;
    const next = this.deriveEffectiveSettings(userNext);

    const oldTracks = this.settings.tracks ?? [];
    const newTracks = next.tracks ?? [];
    let trackListChanged = oldTracks.length !== newTracks.length;
    for (let i = 0; i < Math.max(oldTracks.length, newTracks.length); i++) {
      if (oldTracks[i]?.filePath !== newTracks[i]?.filePath) {
        this.cache.delete(i);
        trackListChanged = true;
      }
    }
    if (trackListChanged) {
      // Indices in the queue refer to the old track list; drop it.
      console.log(
        `[MusicEngine] track list changed (${oldTracks.length} -> ${newTracks.length}); resetting queue`
      );
      this.queue = [];
      this.queueIndex = 0;
      this.prevQueueTail = [];
    }

    this.reactToSettings(next);
  }

  private reactToSettings(next: MusicSettings): void {
    const wasEnabled = this.settings.enabled !== false;
    const nowEnabled = next.enabled !== false;
    this.settings = next;

    this.applyMasterVolume();
    if (this.settings.pauseOnGameLaunch === false && this.launchPauseActive) {
      this.releaseLaunchPause();
    }

    if (!this.canPlay()) {
      this.launchPauseActive = false;
      this.launchPauseSawBlur = false;
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = undefined;
      }
      this.cancelGapTimer();
      if (this.playing || this.audible) {
        this.audible = false;
        const fadeMs = this.fadeMs("pauseFadeOutMs");
        this.fadeGainTo(0, fadeMs);
        this.killSource(fadeMs);
      }
    } else if (this.startupTimer && (!this.settings.startupDelayEnabled || !this.settings.startupDelayMs)) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
      if (this.shouldBeAudible()) {
        this.audible = true;
        this.doResume();
      }
    } else if (this.inGap && this.settings.continuousPlay === true && this.audible) {
      this.cancelGapTimer();
      this.beginPlayback();
    } else if (wasEnabled && !nowEnabled) {
      if (this.audible) {
        this.audible = false;
        this.doPause();
      }
    } else if (!wasEnabled && nowEnabled) {
      if (this.active && !this.startupTimer && this.shouldBeAudible()) {
        this.audible = true;
        this.doResume();
      }
    } else {
      this.onAudibilityChanged();
    }
    this.emit();
  }

  onStartupComplete(): void {
    if (this.active) return;
    this.active = true;
    this.startSystemPoll();
    if (!this.canPlay()) { this.emit(); return; }
    if (this.settings.startupWithSoundEnabled === true) {
      if (this.shouldBeAudible()) {
        this.audible = true;
        this.doResume(this.fadeMs("startupWithSoundFadeInMs"));
      }
      this.emit();
      return;
    }
    if (!this.settings.startupDelayEnabled || !this.settings.startupDelayMs) {
      if (this.shouldBeAudible()) {
        this.audible = true;
        this.doResume();
      }
      this.emit();
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      if (this.shouldBeAudible()) {
        this.audible = true;
        this.doResume();
      }
      this.emit();
    }, this.settings.startupDelayMs);
    this.emit();
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (this.launchPauseActive && !focused) {
      this.launchPauseSawBlur = true;
    }
    if (this.launchPauseActive && focused && this.launchPauseSawBlur) {
      this.releaseLaunchPause();
    }
    this.onAudibilityChanged();
  }

  setSystemAudioActive(active: boolean): void {
    if (this.systemAudioActive === active) return;
    this.systemAudioActive = active;
    this.onAudibilityChanged();
  }

  // Debug: skip current track and immediately start the next one in the queue.
  skipToNext(): void {
    if (!this.canPlay()) return;
    this.cancelGapTimer();
    if (this.playing) {
      this.killSource(0);
    }
    this.currentTrackIndex = null;
    if (this.audible) this.beginPlayback();
    this.emit();
  }

  onGameLaunch(): void {
    if (this.settings.pauseOnGameLaunch === false) {
      return;
    }
    this.launchPauseActive = true;
    this.launchPauseSawBlur = !this.focused;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.playing || this.audible) {
      this.audible = false;
      this.doPause(this.fadeMs("gameLaunchFadeOutMs"));
    }
    this.emit();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private emit(): void {
    if (!this.subscribers.size) return;
    const s = this.getStatus();
    for (const cb of this.subscribers) cb(s);
  }

  private canPlay(): boolean {
    return this.settings.enabled !== false && (this.settings.tracks?.length ?? 0) > 0;
  }

  private shouldBeAudible(): boolean {
    return this.canPlay()
      && !this.launchPauseActive
      && (this.settings.pauseOnFocusLoss === false || this.focused)
      && (this.settings.pauseOnSystemAudio === false || !this.systemAudioActive);
  }

  private releaseLaunchPause(): void {
    this.launchPauseActive = false;
    this.launchPauseSawBlur = false;
  }

  private onAudibilityChanged(): void {
    if (!this.active || this.startupTimer) { this.emit(); return; }
    const should = this.shouldBeAudible();
    if (should && !this.audible) {
      this.audible = true;
      this.doResume();
    } else if (!should && this.audible) {
      this.audible = false;
      this.doPause();
    }
    this.emit();
  }

  // Record virtual state, fade out, stop source.
  private doPause(fadeMs = this.fadeMs("pauseFadeOutMs")): void {
    if (this.playing && this.context && this.currentBuffer) {
      const ctx = this.context;
      const elapsed = ctx.currentTime - this.sourceStartedAtCtxTime;
      const positionS = Math.min(this.sourceStartOffset + elapsed, this.currentBuffer.duration - 0.01);
      this.pausedState = { kind: "playing", buffer: this.currentBuffer, positionS };
      this.fadeGainTo(0, fadeMs);
      this.killSource(fadeMs);
    } else if (this.inGap && this.gapEndsAt !== undefined) {
      this.pausedState = { kind: "gap", gapEndsAt: this.gapEndsAt };
      this.cancelGapTimer();
    } else {
      this.pausedState = { kind: "none" };
    }
    this.pausedAt = Date.now();
    this.emit();
  }

  // Restore playback from virtual state, fading gain back in.
  private doResume(trackFadeInMs?: number): void {
    const state = this.pausedState ?? { kind: "none" };
    const pausedAt = this.pausedAt;
    this.pausedState = undefined;
    this.pausedAt = undefined;

    if (state.kind === "playing" && pausedAt !== undefined) {
      const elapsedS = (Date.now() - pausedAt) / 1000;
      const virtualPosS = state.positionS + elapsedS;

      if (virtualPosS < state.buffer.duration) {
        // Still within the same track — resume from virtual position with a short fade-in.
        this.setMasterToVolume(this.fadeMs("resumeFadeInMs"));
        this.playBuffer(state.buffer, virtualPosS, /* newTrack */ false);
        return;
      }

      // Track finished while away. Calculate when, then decide on gap.
      const trackEndedMsAgo = (elapsedS - (state.buffer.duration - state.positionS)) * 1000;
      const gapMs = this.nextGapMs();
      if (trackEndedMsAgo >= gapMs) {
        // Gap also elapsed — start next track immediately.
        this.setMasterToVolume(this.fadeMs("resumeFadeInMs"));
        this.beginPlayback(trackFadeInMs);
      } else {
        // Still in the gap — wait for the remainder.
        const remainingMs = gapMs - trackEndedMsAgo;
        this.gapEndsAt = Date.now() + remainingMs;
        this.inGap = true;
        this.gapTimer = setTimeout(() => {
          this.gapTimer = undefined;
          this.gapEndsAt = undefined;
          this.inGap = false;
          if (this.audible) {
            this.setMasterToVolume(this.fadeMs("resumeFadeInMs"));
            this.beginPlayback();
          }
        }, remainingMs);
      }
      return;
    }

    if (state.kind === "gap" && state.gapEndsAt !== undefined) {
      const remainingMs = state.gapEndsAt - Date.now();
      if (remainingMs <= 0) {
        this.setMasterToVolume(this.fadeMs("resumeFadeInMs"));
        this.beginPlayback();
      } else {
        this.gapEndsAt = state.gapEndsAt;
        this.inGap = true;
        this.gapTimer = setTimeout(() => {
          this.gapTimer = undefined;
          this.gapEndsAt = undefined;
          this.inGap = false;
          if (this.audible) {
            this.setMasterToVolume(this.fadeMs("resumeFadeInMs"));
            this.beginPlayback();
          }
        }, remainingMs);
      }
      return;
    }

    // Idle — start fresh.
    if (!this.playing && !this.inGap) {
      this.getContext(); // create context+masterGain BEFORE setting volume, otherwise the set is a no-op and playback stays silent
      this.setMasterToVolume(0);
      this.beginPlayback(trackFadeInMs);
    }
  }

  private beginPlayback(trackFadeInMs?: number): void {
    if (this.playing) return;
    const tracks = this.settings.tracks ?? [];
    if (!tracks.length) return;

    const next = this.dequeueNextTrack(tracks.length);
    if (next < 0) return;
    this.currentTrackIndex = next;
    const trackName = tracks[next]?.filePath?.split(/[\\/]/).pop() ?? `#${next}`;
    console.log(
      `[MusicEngine] starting track #${next} (${trackName}). queue=[${this.queue.join(",")}] pos=${this.queueIndex}/${this.queue.length}`
    );

    void this.loadAndPlay(next, trackFadeInMs).catch((err: unknown) => {
      console.warn("[MusicEngine] load failed", next, err);
    });
  }

  private dequeueNextTrack(trackCount: number): number {
    if (trackCount <= 0) return -1;
    if (trackCount === 1) return 0;
    if (this.queueIndex >= this.queue.length) {
      this.prevQueueTail = this.queue.slice(-2);
      this.queue = this.buildShuffledQueue(trackCount, this.prevQueueTail);
      this.queueIndex = 0;
    }
    return this.queue[this.queueIndex++] ?? -1;
  }

  private buildShuffledQueue(trackCount: number, avoidAtFront: number[]): number[] {
    const indices = Array.from({ length: trackCount }, (_, i) => i);
    // Fisher-Yates shuffle
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    // Ensure neither of the first 2 slots holds an index from the previous tail.
    // Only meaningful when trackCount > 2; otherwise an unavoidable overlap.
    if (avoidAtFront.length && trackCount > 2) {
      for (let slot = 0; slot < 2 && slot < indices.length; slot++) {
        if (avoidAtFront.includes(indices[slot]!)) {
          for (let scan = 2; scan < indices.length; scan++) {
            if (!avoidAtFront.includes(indices[scan]!)) {
              const tmp = indices[slot]!;
              indices[slot] = indices[scan]!;
              indices[scan] = tmp;
              break;
            }
          }
        }
      }
    }
    return indices;
  }

  private async loadAndPlay(index: number, trackFadeInMs?: number): Promise<void> {
    const track = (this.settings.tracks ?? [])[index];
    if (!track) return;
    const buffer = await this.loadTrack(index, track.filePath);
    if (!buffer || !this.audible) return;
    this.playBuffer(buffer, 0, /* newTrack */ true, trackFadeInMs);
  }

  // newTrack=true fades trackGain up using settings; resumed tracks use masterGain fade only.
  private playBuffer(buffer: AudioBuffer, offsetS: number, newTrack: boolean, trackFadeInMs?: number): void {
    const ctx = this.getContext();
    const master = this.masterGain;
    if (!ctx || !master) return;

    void ctx.resume().catch(() => undefined);

    if (!this.trackGain) {
      this.trackGain = ctx.createGain();
      this.trackGain.connect(master);
    }

    this.killSource(0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const tg = this.trackGain;
    tg.gain.cancelScheduledValues(ctx.currentTime);
    if (newTrack) {
      const fadeMs = Math.max(0, trackFadeInMs ?? this.fadeMs("trackFadeInMs"));
      if (fadeMs > 0) {
        tg.gain.setValueAtTime(0, ctx.currentTime);
        tg.gain.linearRampToValueAtTime(1, ctx.currentTime + fadeMs / 1000);
      } else {
        tg.gain.setValueAtTime(1, ctx.currentTime);
      }
    } else {
      tg.gain.setValueAtTime(1, ctx.currentTime);
    }

    source.connect(tg);
    this.currentSource = source;
    this.currentBuffer = buffer;
    this.sourceStartedAtCtxTime = ctx.currentTime;
    this.sourceStartOffset = offsetS;
    this.playing = true;
    this.emit();

    source.onended = () => {
      if (this.currentSource === source) {
        this.currentSource = undefined;
        this.currentBuffer = undefined;
        this.playing = false;
        this.onTrackEnded();
        this.emit();
      }
    };

    source.start(ctx.currentTime, offsetS);
  }

  private onTrackEnded(): void {
    this.currentTrackIndex = null;
    if (!this.audible) return;
    if (this.settings.continuousPlay === true) {
      this.beginPlayback();
      return;
    }
    const gapMs = this.nextGapMs();
    console.log(`[MusicEngine] track ended; gap=${Math.round(gapMs / 1000)}s before next`);
    this.gapEndsAt = Date.now() + gapMs;
    this.inGap = true;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = undefined;
      this.gapEndsAt = undefined;
      this.inGap = false;
      if (this.audible) this.beginPlayback();
    }, gapMs);
  }

  private cancelGapTimer(): void {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
    }
    this.gapEndsAt = undefined;
    this.inGap = false;
  }

  private fadeMs(key: "startupWithSoundFadeInMs" | "trackFadeInMs" | "pauseFadeOutMs" | "resumeFadeInMs" | "gameLaunchFadeOutMs"): number {
    return this.settings.fadesEnabled === false ? 0 : Math.max(0, this.settings[key] ?? DEFAULT_MUSIC_SETTINGS[key]);
  }

  private nextGapMs(): number {
    if (this.settings.continuousPlay === true) return 0;
    const min = Math.max(0, this.settings.gapMinMs ?? DEFAULT_MUSIC_SETTINGS.gapMinMs);
    const max = Math.max(min, this.settings.gapMaxMs ?? DEFAULT_MUSIC_SETTINGS.gapMaxMs);
    return min + Math.random() * (max - min);
  }

  private killSource(fadeMs: number): void {
    const source = this.currentSource;
    const ctx = this.context;
    if (!source || !ctx) return;
    this.currentSource = undefined;
    this.currentBuffer = undefined;
    this.playing = false;
    try {
      if (fadeMs > 0) {
        source.stop(ctx.currentTime + fadeMs / 1000 + 0.05);
      } else {
        source.stop();
      }
    } catch { /* already stopped */ }
  }

  private fadeGainTo(target: number, fadeMs: number): void {
    const ctx = this.context;
    const gain = this.masterGain;
    if (!ctx || !gain) return;
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(target, ctx.currentTime + fadeMs / 1000);
  }

  private setMasterToVolume(fadeMs: number): void {
    const vol = clampVol(this.settings.volume, DEFAULT_MUSIC_SETTINGS.volume);
    if (fadeMs > 0) {
      this.fadeGainTo(vol, fadeMs);
    } else {
      const ctx = this.context;
      const gain = this.masterGain;
      if (ctx && gain) {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(vol, ctx.currentTime);
      }
    }
  }

  private applyMasterVolume(): void {
    const ctx = this.context;
    const gain = this.masterGain;
    if (!ctx || !gain) return;
    if (this.audible) {
      gain.gain.setTargetAtTime(clampVol(this.settings.volume, DEFAULT_MUSIC_SETTINGS.volume), ctx.currentTime, 0.015);
    }
  }

  private getContext(): AudioContext | undefined {
    if (this.context) return this.context;
    const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!Ctor) return undefined;
    this.context = new Ctor({ latencyHint: "playback" });
    this.masterGain = this.context.createGain();
    this.masterGain.gain.setValueAtTime(0, 0);
    this.masterGain.connect(this.context.destination);
    this.installUnlockListeners();
    return this.context;
  }

  private installUnlockListeners(): void {
    if (this.unlockListenersInstalled) return;
    this.unlockListenersInstalled = true;
    const unlock = () => {
      const ctx = this.context;
      if (!ctx || ctx.state === "running") return;
      void ctx.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
  }

  private async loadTrack(index: number, filePath: string): Promise<AudioBuffer | undefined> {
    const cached = this.cache.get(index);
    if (cached?.filePath === filePath) return cached.buffer;

    const ctx = this.getContext();
    if (!ctx) return undefined;

    try {
      const res = await fetch(window.hynite.music.url(index), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      if ((this.settings.tracks ?? [])[index]?.filePath === filePath) {
        this.cache.set(index, { filePath, buffer });
      }
      return buffer;
    } catch (err) {
      console.warn("[MusicEngine] fetch failed", index, err);
      return undefined;
    }
  }

  private startSystemPoll(): void {
    if (this.systemAudioUnsubscribe) return;
    // Push-based: main process pings us whenever SMTC playback state changes.
    this.systemAudioUnsubscribe = window.hynite.music.onSystemAudioChanged((active) => {
      this.setSystemAudioActive(active);
    });
    // Pull current value once so we don't wait for the next change to seed state.
    void window.hynite.music.isSystemAudioActive().then((active) => {
      this.setSystemAudioActive(active);
    }).catch(() => undefined);
  }
}

export const musicEngine = new MusicEngine();
