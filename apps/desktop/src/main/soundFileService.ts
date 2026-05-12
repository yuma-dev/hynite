import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Protocol } from "electron";
import { soundEffectIds, type AppSettings, type SoundEffectId } from "@hynite/core";
import { readAudioArtwork } from "./audioMetadata";

const MAX_SOUND_FILE_BYTES = 20 * 1024 * 1024;
const MAX_MUSIC_FILE_BYTES = 50 * 1024 * 1024;
const SOUND_EFFECT_ID_SET = new Set<string>(soundEffectIds);
const AUDIO_MIME_BY_EXTENSION = new Map<string, string>([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"]
]);
const LOWERCASE_EFFECT_ID = new Map<string, SoundEffectId>(
  soundEffectIds.map((id) => [id.toLowerCase(), id])
);

function soundHeaders(contentType?: string): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    ...(contentType ? { "content-type": contentType } : {})
  };
}

function response(status: number, body = ""): Response {
  return new Response(body, {
    status,
    headers: soundHeaders()
  });
}

function responseWithHeaders(status: number, body: BodyInit, contentType: string): Response {
  return new Response(body, {
    status,
    headers: soundHeaders(contentType)
  });
}

function bufferToArrayBuffer(bytes: Buffer): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function soundEffectIdFromUrl(rawUrl: string): SoundEffectId | undefined {
  const url = new URL(rawUrl);
  const pathCandidate = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (SOUND_EFFECT_ID_SET.has(pathCandidate)) {
    return pathCandidate as SoundEffectId;
  }

  const hostCandidate = decodeURIComponent(url.hostname);
  if (SOUND_EFFECT_ID_SET.has(hostCandidate)) {
    return hostCandidate as SoundEffectId;
  }

  return LOWERCASE_EFFECT_ID.get(hostCandidate.toLowerCase());
}

export class SoundFileService {
  constructor(private readonly getSettings: () => Promise<AppSettings>) {}

  registerMusicProtocol(protocol: Protocol): void {
    protocol.handle("hynite-music", async (request) => {
      // URL shapes: hynite-music://track/<index> and
      // hynite-music://cover/<index>. The literal host prevents Electron's
      // standard-scheme parser from interpreting a bare
      // numeric path as an IPv4 address (e.g. ".../8" → host "0.0.0.8").
      const url = new URL(request.url);
      const route = url.hostname.toLowerCase();
      const pathStr = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const index = parseInt(pathStr, 10);
      if ((route !== "track" && route !== "cover") || !Number.isFinite(index) || index < 0) {
        return response(400);
      }

      const settings = await this.getSettings();
      // Filter to match the renderer's normalizeMusicSettings — otherwise
      // blank/invalid entries shift indices and the wrong file plays.
      const tracks = (settings.music?.tracks ?? []).filter(
        (t) => typeof t?.filePath === "string" && t.filePath.trim()
      );
      if (index >= tracks.length) {
        return response(404);
      }

      const track = tracks[index];
      if (!track?.filePath) {
        return response(404);
      }

      const extension = extname(track.filePath).toLowerCase();
      const contentType = AUDIO_MIME_BY_EXTENSION.get(extension);
      if (!contentType) {
        return response(415, "Unsupported music file type.");
      }

      try {
        const fileStat = await stat(track.filePath);
        if (!fileStat.isFile()) {
          return response(404);
        }
        if (fileStat.size > MAX_MUSIC_FILE_BYTES) {
          return response(413, "Music file is too large (max 50 MB).");
        }
        if (route === "cover") {
          const artwork = readAudioArtwork(track.filePath);
          return artwork
            ? responseWithHeaders(200, bufferToArrayBuffer(artwork.bytes), artwork.mimeType)
            : response(404);
        }
        const bytes = await readFile(track.filePath);
        return new Response(bytes, { headers: soundHeaders(contentType) });
      } catch {
        return response(404);
      }
    });
  }

  registerProtocol(protocol: Protocol): void {
    protocol.handle("hynite-sound", async (request) => {
      const effectId = soundEffectIdFromUrl(request.url);
      if (!effectId) {
        return response(404);
      }

      const settings = await this.getSettings();
      const effect = settings.sound?.effects?.[effectId];
      if (!effect?.filePath || effect.enabled === false) {
        return response(404);
      }

      const extension = extname(effect.filePath).toLowerCase();
      const contentType = AUDIO_MIME_BY_EXTENSION.get(extension);
      if (!contentType) {
        return response(415, "Unsupported sound file type.");
      }

      try {
        const fileStat = await stat(effect.filePath);
        if (!fileStat.isFile()) {
          return response(404);
        }
        if (fileStat.size > MAX_SOUND_FILE_BYTES) {
          return response(413, "Sound file is too large.");
        }

        const bytes = await readFile(effect.filePath);
        return new Response(bytes, {
          headers: soundHeaders(contentType)
        });
      } catch {
        return response(404);
      }
    });
  }
}
