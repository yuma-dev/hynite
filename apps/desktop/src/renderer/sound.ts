import {
  soundEffectIds,
  type AppSettings,
  type SoundEffectId,
  type SoundEffectPlayback,
  type SoundEffectSettings,
  type SoundSettings
} from "@hynite/core";

export type SoundEffectDefinition = {
  id: SoundEffectId;
  label: string;
  description: string;
  defaultPlayback: SoundEffectPlayback;
};

export const SOUND_EFFECT_DEFINITIONS: SoundEffectDefinition[] = [
  {
    id: "startup",
    label: "Startup",
    description: "Played once after startup settings are loaded.",
    defaultPlayback: "restart"
  },
  {
    id: "gameSelect",
    label: "Game selection",
    description: "Played when a game opens into detail.",
    defaultPlayback: "overlap"
  },
  {
    id: "gameLaunch",
    label: "Game launch",
    description: "Played after Hynite successfully hands off a launch.",
    defaultPlayback: "fade"
  },
  {
    id: "navigation",
    label: "Navigation",
    description: "Played when switching primary sections.",
    defaultPlayback: "overlap"
  }
];

const DEFAULT_PLAYBACK = new Map<SoundEffectId, SoundEffectPlayback>(
  SOUND_EFFECT_DEFINITIONS.map((definition) => [definition.id, definition.defaultPlayback])
);
const MAX_ACTIVE_VOICES_PER_EFFECT = 12;
const DEFAULT_FADE_MS = 90;
const DEFAULT_ATTACK_MS = 8;
const RESTART_RELEASE_MS = 12;

type ActiveVoice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
};

type LoadedBuffer = {
  filePath: string;
  buffer: AudioBuffer;
};

type PendingBuffer = {
  filePath: string;
  promise: Promise<AudioBuffer | undefined>;
};

type AudioWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function clampVolume(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

export function normalizeSoundSettings(settings?: SoundSettings): SoundSettings {
  const effects: SoundSettings["effects"] = {};
  for (const id of soundEffectIds) {
    const raw = settings?.effects?.[id];
    if (!raw) continue;
    effects[id] = {
      filePath: typeof raw.filePath === "string" && raw.filePath.trim() ? raw.filePath.trim() : undefined,
      volume: clampVolume(raw.volume, 1),
      enabled: raw.enabled !== false,
      playback: raw.playback ?? DEFAULT_PLAYBACK.get(id)
    };
  }

  return {
    masterVolume: clampVolume(settings?.masterVolume, 0.8),
    muted: settings?.muted === true,
    effects
  };
}

function effectiveVolume(effect: SoundEffectSettings | undefined): number {
  return clampVolume(effect?.volume, 1);
}

function isAppSettings(value: AppSettings | SoundSettings | undefined): value is AppSettings {
  return Boolean(value && "sound" in value);
}

export class SoundEngine {
  private settings: SoundSettings = normalizeSoundSettings();
  private context: AudioContext | undefined;
  private masterGain: GainNode | undefined;
  private loaded = new Map<SoundEffectId, LoadedBuffer>();
  private pending = new Map<SoundEffectId, PendingBuffer>();
  private voices = new Map<SoundEffectId, ActiveVoice[]>();
  private unlockListenersInstalled = false;

  applySettings(settings: AppSettings | SoundSettings | undefined): void {
    const next = normalizeSoundSettings(isAppSettings(settings) ? settings.sound : settings);

    for (const id of soundEffectIds) {
      const previousPath = this.settings.effects?.[id]?.filePath;
      const nextPath = next.effects?.[id]?.filePath;
      if (previousPath !== nextPath) {
        this.loaded.delete(id);
        this.pending.delete(id);
      }
    }

    this.settings = next;
    this.applyMasterVolume();
    void this.preloadConfigured().catch((error: unknown) => {
      console.warn("Sound preload failed", error);
    });
  }

  async preloadConfigured(): Promise<void> {
    await Promise.all(soundEffectIds.map(async (id) => {
      try {
        await this.ensureLoaded(id);
      } catch (error) {
        console.warn("Sound preload failed", id, error);
      }
    }));
  }

  play(effectId: SoundEffectId, options: { mode?: SoundEffectPlayback; fadeMs?: number } = {}): void {
    const effect = this.settings.effects?.[effectId];
    if (!effect?.filePath || effect.enabled === false || this.settings.muted || this.settings.masterVolume <= 0) {
      return;
    }

    void this.ensureLoaded(effectId).then((buffer) => {
      if (!buffer) return;
      const current = this.settings.effects?.[effectId];
      if (!current?.filePath || current.enabled === false || this.settings.muted) return;
      this.start(effectId, buffer, options);
    }).catch((error: unknown) => {
      console.warn("Sound effect failed", effectId, error);
    });
  }

  stop(effectId: SoundEffectId, fadeMs = DEFAULT_FADE_MS): void {
    this.fadeOutVoices(effectId, fadeMs);
  }

  private audioContext(): AudioContext | undefined {
    if (this.context) {
      return this.context;
    }

    const AudioContextConstructor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
    if (!AudioContextConstructor) {
      return undefined;
    }

    this.context = new AudioContextConstructor({ latencyHint: "interactive" });
    this.masterGain = this.context.createGain();
    this.masterGain.connect(this.context.destination);
    this.applyMasterVolume();
    this.installUnlockListeners();
    return this.context;
  }

  private applyMasterVolume(): void {
    const context = this.context;
    const gain = this.masterGain;
    if (!context || !gain) {
      return;
    }
    const value = this.settings.muted ? 0 : this.settings.masterVolume;
    gain.gain.setTargetAtTime(value, context.currentTime, 0.015);
  }

  private installUnlockListeners(): void {
    if (this.unlockListenersInstalled) {
      return;
    }
    this.unlockListenersInstalled = true;
    const unlock = () => {
      const context = this.context;
      if (!context || context.state === "running") {
        return;
      }
      void context.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
  }

  private async ensureLoaded(effectId: SoundEffectId): Promise<AudioBuffer | undefined> {
    const effect = this.settings.effects?.[effectId];
    if (!effect?.filePath || effect.enabled === false) {
      return undefined;
    }

    const cached = this.loaded.get(effectId);
    if (cached?.filePath === effect.filePath) {
      return cached.buffer;
    }

    const pending = this.pending.get(effectId);
    if (pending?.filePath === effect.filePath) {
      return pending.promise;
    }

    const promise = this.loadBuffer(effectId, effect.filePath);
    this.pending.set(effectId, { filePath: effect.filePath, promise });
    return promise;
  }

  private async loadBuffer(effectId: SoundEffectId, filePath: string): Promise<AudioBuffer | undefined> {
    try {
      const context = this.audioContext();
      if (!context) {
        return undefined;
      }
      const response = await fetch(window.hynite.sound.url(effectId), { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Sound fetch failed with HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(bytes.slice(0));
      if (this.settings.effects?.[effectId]?.filePath === filePath) {
        this.loaded.set(effectId, { filePath, buffer });
      }
      return buffer;
    } finally {
      const pending = this.pending.get(effectId);
      if (pending?.filePath === filePath) {
        this.pending.delete(effectId);
      }
    }
  }

  private start(effectId: SoundEffectId, buffer: AudioBuffer, options: { mode?: SoundEffectPlayback; fadeMs?: number }): void {
    const context = this.audioContext();
    const masterGain = this.masterGain;
    const effect = this.settings.effects?.[effectId];
    if (!context || !masterGain || !effect) {
      return;
    }

    const mode = options.mode ?? effect.playback ?? DEFAULT_PLAYBACK.get(effectId) ?? "overlap";
    const fadeMs = options.fadeMs ?? DEFAULT_FADE_MS;
    if (mode === "restart") {
      this.fadeOutVoices(effectId, RESTART_RELEASE_MS);
    } else if (mode === "fade") {
      this.fadeOutVoices(effectId, fadeMs);
    }

    void context.resume().catch(() => undefined);
    const source = context.createBufferSource();
    const gain = context.createGain();
    const targetVolume = effectiveVolume(effect);
    const startsAt = context.currentTime;
    source.buffer = buffer;
    gain.gain.setValueAtTime(0, startsAt);
    gain.gain.linearRampToValueAtTime(targetVolume, startsAt + DEFAULT_ATTACK_MS / 1000);
    source.connect(gain);
    gain.connect(masterGain);

    const voice: ActiveVoice = { source, gain, startedAt: performance.now() };
    const voices = this.voices.get(effectId) ?? [];
    voices.push(voice);
    this.voices.set(effectId, voices);
    this.trimVoices(effectId);
    source.onended = () => this.removeVoice(effectId, voice);
    source.start();
  }

  private trimVoices(effectId: SoundEffectId): void {
    const voices = this.voices.get(effectId) ?? [];
    if (voices.length <= MAX_ACTIVE_VOICES_PER_EFFECT) {
      return;
    }
    const overflow = [...voices]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, voices.length - MAX_ACTIVE_VOICES_PER_EFFECT);
    for (const voice of overflow) {
      this.stopVoice(voice, 0);
    }
  }

  private fadeOutVoices(effectId: SoundEffectId, fadeMs: number): void {
    for (const voice of this.voices.get(effectId) ?? []) {
      this.stopVoice(voice, fadeMs);
    }
  }

  private stopVoice(voice: ActiveVoice, fadeMs: number): void {
    const context = this.context;
    if (!context) {
      return;
    }
    try {
      voice.gain.gain.cancelScheduledValues(context.currentTime);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, context.currentTime);
      voice.gain.gain.linearRampToValueAtTime(0, context.currentTime + Math.max(0, fadeMs) / 1000);
      voice.source.stop(context.currentTime + Math.max(0, fadeMs) / 1000 + 0.01);
    } catch {
      // Already stopped.
    }
  }

  private removeVoice(effectId: SoundEffectId, voice: ActiveVoice): void {
    const remaining = (this.voices.get(effectId) ?? []).filter((candidate) => candidate !== voice);
    if (remaining.length > 0) {
      this.voices.set(effectId, remaining);
    } else {
      this.voices.delete(effectId);
    }
    try {
      voice.source.disconnect();
      voice.gain.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

export const soundEngine = new SoundEngine();
