import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetCacheService } from "./assetCacheService";
import type { ProfileSink, ProfileSpanHandle, ProfileSpanStatus } from "@hynite/core";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hynite-assets-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllGlobals();
});

function fakeProfiler() {
  type SpanEntry = { category: string; name: string; status?: ProfileSpanStatus; details?: Record<string, unknown> };
  const spans: SpanEntry[] = [];
  const profiler: ProfileSink = {
    point: vi.fn(),
    metric: vi.fn(),
    startSpan(category, name, details): ProfileSpanHandle {
      const entry: SpanEntry = { category, name, details };
      spans.push(entry);
      return {
        id: `${spans.length}`,
        end(status = "ok", endDetails) {
          entry.status = status;
          entry.details = { ...entry.details, ...endDetails };
        }
      };
    }
  };
  return { profiler, spans };
}

describe("AssetCacheService profiling", () => {
  it("records protocol cache hits and misses", async () => {
    const cacheDir = await tempDir();
    await writeFile(join(cacheDir, "abc123.png"), Buffer.from("png"));
    const { profiler, spans } = fakeProfiler();
    const service = new AssetCacheService(cacheDir, profiler);
    const protocol = { handle: vi.fn() };

    service.registerProtocol(protocol as any);
    const handler = protocol.handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;

    const hit = await handler(new Request("hynite-asset://cache/abc123.png"));
    const miss = await handler(new Request("hynite-asset://cache/missing.png"));

    expect(hit.status).toBe(200);
    expect(miss.status).toBe(404);
    expect(spans.find((span) => span.details?.status === "hit")?.name).toBe("asset-cache:protocol-read");
    expect(spans.find((span) => span.details?.status === "missing")?.status).toBe("error");
  });

  it("records local cache hits without fetching", async () => {
    const cacheDir = await tempDir();
    const url = "https://cdn.example.test/game/header.png";
    const hash = createHash("sha256").update(url).digest("hex");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${hash}.png`), Buffer.from("cached"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { profiler, spans } = fakeProfiler();
    const service = new AssetCacheService(cacheDir, profiler);

    const patch = await service.cacheMetadataPatch({ headerUrl: url });

    expect(patch.headerUrl).toBe(`hynite-asset://cache/${hash}.png`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spans.find((span) => span.name === "asset-cache:cache-hit")?.details?.cacheStatus).toBe("hit");
  });
});
