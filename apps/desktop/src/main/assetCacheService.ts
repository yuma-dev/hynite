import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Protocol } from "electron";
import type { GameMetadataPatch, GameScreenshot, ProfileSink } from "@hynite/core";

const CACHE_SCHEME = "hynite-asset";
const CACHE_HOST = "cache";
const CACHEABLE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico", ".avif"]);

function isRemoteUrl(value: string | undefined): value is string {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function isDataImageUrl(value: string | undefined): value is string {
  return Boolean(value && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value));
}

function extensionFromDataUrl(value: string): string {
  const match = /^data:image\/(?<type>png|jpe?g|webp);base64,/i.exec(value);
  const type = match?.groups?.type?.toLocaleLowerCase();
  if (type === "jpeg" || type === "jpg") return ".jpg";
  if (type === "png") return ".png";
  if (type === "webp") return ".webp";
  return ".bin";
}

function extensionFromUrl(value: string): string {
  try {
    const ext = extname(new URL(value).pathname).toLocaleLowerCase();
    return CACHEABLE_EXTENSIONS.has(ext) ? ext : ".bin";
  } catch {
    return ".bin";
  }
}

function contentTypeForFile(fileName: string): string {
  const ext = extname(fileName).toLocaleLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".avif") return "image/avif";
  return "application/octet-stream";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class AssetCacheService {
  constructor(
    private readonly cacheDir: string,
    private readonly profiler?: ProfileSink
  ) {}

  registerProtocol(protocol: Protocol): void {
    protocol.handle(CACHE_SCHEME, async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== CACHE_HOST) {
        return new Response("Unknown asset host", { status: 404 });
      }

      const fileName = basename(decodeURIComponent(url.pathname));
      if (!fileName) {
        return new Response("Missing asset", { status: 404 });
      }

      const span = this.profiler?.startSpan("asset-cache", "asset-cache:protocol-read", {
        asset: fileName.slice(0, 12),
        extension: extname(fileName).toLocaleLowerCase()
      });
      try {
        const data = await readFile(join(this.cacheDir, fileName));
        span?.end("ok", {
          status: "hit",
          asset: fileName.slice(0, 12),
          extension: extname(fileName).toLocaleLowerCase(),
          bytes: data.byteLength,
          contentType: contentTypeForFile(fileName)
        });
        return new Response(data, {
          headers: {
            "content-type": contentTypeForFile(fileName),
            "cache-control": "public, max-age=315360000, immutable"
          }
        });
      } catch (error) {
        span?.end("error", {
          status: "missing",
          asset: fileName.slice(0, 12),
          extension: extname(fileName).toLocaleLowerCase(),
          error: error instanceof Error ? error.message : String(error)
        });
        return new Response("Asset not found", { status: 404 });
      }
    });
  }

  async cacheMetadataPatch(patch: GameMetadataPatch, options: { refresh?: boolean } = {}): Promise<GameMetadataPatch> {
    const cached: GameMetadataPatch = { ...patch };
    const fields: Array<keyof Pick<GameMetadataPatch, "coverUrl" | "backgroundUrl" | "logoUrl" | "communityIconUrl" | "libraryCapsuleUrl" | "headerUrl" | "trailerPosterUrl">> = [
      "coverUrl",
      "backgroundUrl",
      "logoUrl",
      "communityIconUrl",
      "libraryCapsuleUrl",
      "headerUrl",
      "trailerPosterUrl"
    ];

    await Promise.all(fields.map(async (field) => {
      const value = cached[field];
      if (isRemoteUrl(value)) {
        cached[field] = await this.cacheUrl(value, options);
      } else if (isDataImageUrl(value)) {
        cached[field] = await this.cacheDataUrl(value);
      }
    }));

    if (cached.screenshots?.length) {
      cached.screenshots = await Promise.all(cached.screenshots.map((screenshot) => this.cacheScreenshot(screenshot, options)));
    }

    return cached;
  }

  private async cacheScreenshot(screenshot: GameScreenshot, options: { refresh?: boolean }): Promise<GameScreenshot> {
    const [thumbnailUrl, fullUrl] = await Promise.all([
      isRemoteUrl(screenshot.thumbnailUrl) ? this.cacheUrl(screenshot.thumbnailUrl, options) : screenshot.thumbnailUrl,
      isRemoteUrl(screenshot.fullUrl) ? this.cacheUrl(screenshot.fullUrl, options) : screenshot.fullUrl
    ]);
    return { thumbnailUrl, fullUrl };
  }

  private async cacheUrl(value: string, options: { refresh?: boolean }): Promise<string> {
    const extension = extensionFromUrl(value);
    if (extension === ".bin") {
      return value;
    }

    const hash = createHash("sha256").update(value).digest("hex");
    const fileName = `${hash}${extension}`;
    const targetPath = join(this.cacheDir, fileName);
    if (!options.refresh && await exists(targetPath)) {
      this.profiler?.startSpan("asset-cache", "asset-cache:cache-hit", {
        source: value,
        asset: fileName.slice(0, 12),
        extension
      }).end("ok", { cacheStatus: "hit" });
      return `${CACHE_SCHEME}://${CACHE_HOST}/${fileName}`;
    }

    const span = this.profiler?.startSpan("asset-cache", "asset-cache:remote-fetch", {
      source: value,
      asset: fileName.slice(0, 12),
      extension,
      refresh: Boolean(options.refresh)
    });
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const response = await fetch(value);
      if (!response.ok) {
        span?.end("error", {
          status: response.status,
          statusText: response.statusText,
          remoteFetch: true
        });
        return value;
      }
      const data = Buffer.from(await response.arrayBuffer());
      await writeFile(targetPath, data);
      span?.end("ok", {
        status: response.status,
        statusText: response.statusText,
        bytes: data.byteLength,
        remoteFetch: true,
        cacheStatus: "written"
      });
      return `${CACHE_SCHEME}://${CACHE_HOST}/${fileName}`;
    } catch (error) {
      span?.end("error", {
        error: error instanceof Error ? error.message : String(error),
        remoteFetch: true
      });
      return value;
    }
  }

  private async cacheDataUrl(value: string): Promise<string> {
    const extension = extensionFromDataUrl(value);
    if (extension === ".bin") {
      return value;
    }

    const comma = value.indexOf(",");
    if (comma < 0) {
      return value;
    }

    const data = Buffer.from(value.slice(comma + 1), "base64");
    const hash = createHash("sha256").update(data).digest("hex");
    const fileName = `${hash}${extension}`;
    const span = this.profiler?.startSpan("asset-cache", "asset-cache:data-url-write", {
      asset: fileName.slice(0, 12),
      extension,
      bytes: data.byteLength
    });
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(join(this.cacheDir, fileName), data);
      span?.end("ok", { bytes: data.byteLength, cacheStatus: "written" });
      return `${CACHE_SCHEME}://${CACHE_HOST}/${fileName}`;
    } catch (error) {
      span?.end("error", {
        error: error instanceof Error ? error.message : String(error)
      });
      return value;
    }
  }
}
