import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { net } from "electron";
import { dirname, join } from "node:path";
import type { YoutubeSearchResult, YtdlpStatus } from "@hynite/core";

const YTDLP_RELEASE_URL = process.platform === "win32"
  ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

const YTDLP_EXE_NAME = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

export type YtdlpDownloadProgress = {
  phase: "downloading" | "ready" | "error";
  percent?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  message?: string;
};

type SearchEntry = {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  view_count?: number;
};

function parseSearchLine(line: string): YoutubeSearchResult | undefined {
  try {
    const entry = JSON.parse(line) as SearchEntry;
    if (!entry.id) return undefined;
    return {
      videoId: entry.id,
      url: entry.webpage_url ?? entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`,
      title: entry.title ?? entry.id,
      channel: entry.channel ?? entry.uploader,
      durationSeconds: typeof entry.duration === "number" ? Math.round(entry.duration) : undefined,
      viewCount: typeof entry.view_count === "number" ? entry.view_count : undefined
    };
  } catch {
    return undefined;
  }
}

export class YtdlpService {
  private installing: Promise<string> | undefined;
  private cachedVersion: string | undefined;

  private overridePath: string | null = null;

  constructor(private readonly binDir: string) {}

  setOverridePath(path: string | null | undefined): void {
    this.overridePath = path && path.trim() ? path.trim() : null;
    this.cachedVersion = undefined;
  }

  defaultPath(): string {
    return join(this.binDir, YTDLP_EXE_NAME);
  }

  resolvedPath(): string {
    return this.overridePath ?? this.defaultPath();
  }

  async status(): Promise<YtdlpStatus> {
    const path = this.resolvedPath();
    const installed = existsSync(path);
    if (!installed) {
      return { installed: false, path, installing: Boolean(this.installing) };
    }
    let version = this.cachedVersion;
    if (!version) {
      try {
        version = await this.queryVersion(path);
        this.cachedVersion = version;
      } catch {
        version = undefined;
      }
    }
    return { installed: true, path, version, installing: Boolean(this.installing) };
  }

  private queryVersion(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(path, ["--version"], { windowsHide: true });
      let out = "";
      proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`yt-dlp --version exited ${code}`));
      });
    });
  }

  async install(onProgress?: (progress: YtdlpDownloadProgress) => void): Promise<string> {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const targetPath = this.defaultPath();
      await mkdir(dirname(targetPath), { recursive: true });
      const tempPath = `${targetPath}.download`;
      try {
        await this.downloadTo(YTDLP_RELEASE_URL, tempPath, onProgress);
        if (existsSync(targetPath)) {
          await unlink(targetPath).catch(() => undefined);
        }
        // rename: tempPath -> targetPath
        const { rename } = await import("node:fs/promises");
        await rename(tempPath, targetPath);
        if (process.platform !== "win32") {
          await chmod(targetPath, 0o755).catch(() => undefined);
        }
        this.cachedVersion = undefined;
        onProgress?.({ phase: "ready" });
        return targetPath;
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        onProgress?.({ phase: "error", message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })();
    try {
      return await this.installing;
    } finally {
      this.installing = undefined;
    }
  }

  private downloadTo(url: string, destPath: string, onProgress?: (progress: YtdlpDownloadProgress) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = net.request({ url, redirect: "follow" });
      request.on("response", (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`yt-dlp download HTTP ${response.statusCode}`));
          return;
        }
        const total = Number(response.headers["content-length"] ?? 0);
        let downloaded = 0;
        const file = createWriteStream(destPath);
        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.byteLength;
          file.write(chunk);
          onProgress?.({
            phase: "downloading",
            bytesDownloaded: downloaded,
            totalBytes: total > 0 ? total : undefined,
            percent: total > 0 ? (downloaded / total) * 100 : undefined
          });
        });
        response.on("end", () => {
          file.end(() => resolve());
        });
        response.on("error", (err) => {
          file.destroy();
          reject(err);
        });
      });
      request.on("error", reject);
      request.end();
    });
  }

  async ensureInstalled(onProgress?: (progress: YtdlpDownloadProgress) => void): Promise<string> {
    const path = this.resolvedPath();
    if (existsSync(path)) return path;
    return this.install(onProgress);
  }

  async search(query: string, limit = 10, options: { thorough?: boolean } = {}): Promise<YoutubeSearchResult[]> {
    const ytdlp = await this.ensureInstalled();
    const startedAt = Date.now();
    return new Promise<YoutubeSearchResult[]>((resolve, reject) => {
      const args = [
        `ytsearch${limit}:${query}`,
        "--dump-json",
        "--no-warnings",
        "--no-playlist",
        "--skip-download",
        "--ignore-errors",
        "--no-write-thumbnail",
        "--default-search", "ytsearch"
      ];
      // Fast path: flat-playlist returns search metadata without an extra HTTP
      // request per video. Loses view_count but keeps title/duration/channel.
      if (!options.thorough) {
        args.push("--flat-playlist");
      }
      console.log(`[ytdlp] search "${query.slice(0, 80)}" thorough=${options.thorough ? "yes" : "no"} limit=${limit}`);
      const proc = spawn(ytdlp, args, { windowsHide: true });
      const results: YoutubeSearchResult[] = [];
      let buf = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            const parsed = parseSearchLine(line);
            if (parsed) results.push(parsed);
          }
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (buf.trim()) {
          const parsed = parseSearchLine(buf.trim());
          if (parsed) results.push(parsed);
        }
        const ms = Date.now() - startedAt;
        console.log(`[ytdlp] search done in ${ms}ms — ${results.length} results, exit=${code}`);
        if (code === 0 || results.length > 0) {
          resolve(results);
        } else {
          reject(new Error(`yt-dlp search exited ${code}: ${stderr.slice(0, 500)}`));
        }
      });
    });
  }

  async downloadAudio(
    videoUrl: string,
    destPath: string,
    onProgress?: (progress: YtdlpDownloadProgress) => void,
    options: { quality?: "best" | "standard" | "compact" | "low" } = {}
  ): Promise<{ filePath: string; fileSizeBytes: number }> {
    const ytdlp = await this.ensureInstalled();
    await mkdir(dirname(destPath), { recursive: true });
    const quality = options.quality ?? "compact";
    // YouTube format ids: 140 = m4a 128k, 139 = m4a 48k, 251 = opus ~160k.
    // Quality presets, sized for cache budget:
    //   best     ~115 MB/h — bestaudio, untouched
    //   standard  ~57 MB/h — m4a 128k (format 140)
    //   compact   ~28 MB/h — opus ~64k (format 250) or m4a if no opus
    //   low       ~22 MB/h — m4a 48k (format 139)
    const formatSpec =
      quality === "best"     ? "bestaudio[ext=m4a]/bestaudio" :
      quality === "standard" ? "140/bestaudio[ext=m4a][abr<=128]/bestaudio[abr<=160]/bestaudio" :
      quality === "low"      ? "139/bestaudio[abr<=64]/bestaudio" :
                               "250/249/bestaudio[abr<=80]/139/bestaudio";
    const startedAt = Date.now();
    console.log(`[ytdlp] download "${videoUrl}" quality=${quality} format=${formatSpec}`);

    return new Promise((resolve, reject) => {
      const proc = spawn(ytdlp, [
        videoUrl,
        "-f", formatSpec,
        "-o", destPath,
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--no-part",
        "--concurrent-fragments", "5",
        "--progress-template", "download:%(progress.downloaded_bytes)s/%(progress.total_bytes)s/%(progress.total_bytes_estimate)s/%(progress.speed)s/%(progress.eta)s"
      ], { windowsHide: true });

      let stderr = "";
      let lastReportedAt = 0;
      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("download:")) continue;
          const parts = trimmed.slice("download:".length).split("/");
          const downloaded = Number(parts[0]);
          const total = Number(parts[1] && parts[1] !== "NA" ? parts[1] : parts[2]);
          const speed = Number(parts[3]);
          const eta = Number(parts[4]);
          if (Number.isFinite(downloaded)) {
            // Throttle progress events to 4/sec to avoid flooding the renderer.
            const now = Date.now();
            if (now - lastReportedAt < 250 && downloaded < (Number.isFinite(total) ? total : Infinity)) continue;
            lastReportedAt = now;
            const percent = Number.isFinite(total) && total > 0 ? (downloaded / total) * 100 : undefined;
            onProgress?.({
              phase: "downloading",
              bytesDownloaded: downloaded,
              totalBytes: Number.isFinite(total) && total > 0 ? total : undefined,
              percent,
              bytesPerSecond: Number.isFinite(speed) && speed > 0 ? speed : undefined,
              etaSeconds: Number.isFinite(eta) && eta > 0 ? eta : undefined
            });
          }
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      proc.on("error", reject);
      proc.on("close", async (code) => {
        if (code !== 0) {
          console.log(`[ytdlp] download FAILED exit=${code} stderr=${stderr.slice(0, 200)}`);
          reject(new Error(`yt-dlp download exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          const fileStat = await stat(destPath);
          const ms = Date.now() - startedAt;
          const mbps = fileStat.size / 1024 / 1024 / (ms / 1000);
          console.log(`[ytdlp] download done in ${ms}ms — ${(fileStat.size / 1024 / 1024).toFixed(1)}MB, ${mbps.toFixed(2)}MB/s`);
          onProgress?.({ phase: "ready", bytesDownloaded: fileStat.size, totalBytes: fileStat.size, percent: 100 });
          resolve({ filePath: destPath, fileSizeBytes: fileStat.size });
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Spawn yt-dlp with `-o -` so audio bytes flow to stdout. Caller is
   * responsible for consuming the readable + canceling on abort. Uses
   * `--concurrent-fragments` to bypass YouTube's per-connection throttling
   * so the cache fills at full bandwidth rather than playback rate.
   */
  async streamAudio(
    videoUrl: string,
    quality: "best" | "standard" | "compact" | "low" = "compact"
  ): Promise<StreamHandle> {
    const ytdlp = await this.ensureInstalled();
    const formatSpec =
      quality === "best"     ? "bestaudio[ext=m4a]/bestaudio" :
      quality === "standard" ? "140/bestaudio[ext=m4a][abr<=128]/bestaudio[abr<=160]/bestaudio" :
      quality === "low"      ? "139/bestaudio[abr<=64]/bestaudio" :
                               "250/249/bestaudio[abr<=80]/139/bestaudio";
    console.log(`[ytdlp] stream "${videoUrl}" quality=${quality} format=${formatSpec}`);
    const proc = spawn(ytdlp, [
      videoUrl,
      "-f", formatSpec,
      "-o", "-",
      "--no-playlist",
      "--no-warnings",
      "--no-part",
      "--concurrent-fragments", "5"
    ], { windowsHide: true });

    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    const done = new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp stream exit ${code}: ${stderrTail.slice(0, 500)}`));
      });
      proc.on("error", reject);
    });

    return {
      stream: proc.stdout,
      done,
      cancel: () => { try { proc.kill(); } catch { /* ignore */ } }
    };
  }
}

export type { YtdlpDownloadProgress as YtdlpDownloadProgressInternal };

export type StreamHandle = {
  stream: NodeJS.ReadableStream;
  done: Promise<void>;
  cancel: () => void;
};
