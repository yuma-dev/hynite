import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { StartupProfileService } from "./startupProfileService";

const originalProfile = process.env.HYNITE_STARTUP_PROFILE;
const tempDirs: string[] = [];

async function tempUserData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hynite-profile-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  process.env.HYNITE_STARTUP_PROFILE = originalProfile;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("StartupProfileService", () => {
  it("stays silent when profile mode is disabled", async () => {
    delete process.env.HYNITE_STARTUP_PROFILE;
    const userData = await tempUserData();
    const service = new StartupProfileService(userData, "0.0.0-test");

    service.point("startup", "test");
    await service.finish();

    expect(service.enabled).toBe(false);
    expect(existsSync(join(userData, "profile-runs"))).toBe(false);
  });

  it("writes async events and aggregates spans into report JSON", async () => {
    process.env.HYNITE_STARTUP_PROFILE = "1";
    const userData = await tempUserData();
    const service = new StartupProfileService(userData, "0.0.0-test");

    const span = service.startSpan("ipc", "ipc:call", { channel: "library:list" });
    span.end("ok", { result: { type: "array", length: 2 } });
    await service.finish();

    const events = await readFile(service.eventsPath, "utf8");
    const report = JSON.parse(await readFile(service.reportPath, "utf8"));

    expect(events).toContain("\"kind\":\"span-start\"");
    expect(events).toContain("\"kind\":\"span-end\"");
    expect(report.ipc.stats.count).toBe(1);
    expect(report.summary.slowestSpans[0].name).toBe("ipc:call");
    expect(existsSync(service.latestReportPath)).toBe(true);
  });

  it("records freezes with overlapping spans", async () => {
    process.env.HYNITE_STARTUP_PROFILE = "1";
    const userData = await tempUserData();
    const service = new StartupProfileService(userData, "0.0.0-test");

    const span = service.startSpan("steam-sync", "steam-sync:metadata-refresh-total");
    service.recordFreeze("main", 300, "heartbeat");
    span.end("ok");
    await service.finish();

    const report = JSON.parse(await readFile(service.reportPath, "utf8"));
    expect(report.freezes[0].durationMs).toBe(300);
    expect(report.freezes[0].overlappingSpans[0].name).toBe("steam-sync:metadata-refresh-total");
    expect(report.freezes[0].likelyCause.category).toBe("steam-sync");
  });

  it("groups cancelled renderer images without letting them dominate slowest spans", async () => {
    process.env.HYNITE_STARTUP_PROFILE = "1";
    const userData = await tempUserData();
    const service = new StartupProfileService(userData, "0.0.0-test");

    const ipcSpan = service.startSpan("ipc", "ipc:call", { channel: "home:get" });
    ipcSpan.end("ok");
    service.recordRendererEvent({
      kind: "span-start",
      id: "image-1",
      ts: new Date().toISOString(),
      elapsedMs: 10,
      process: "renderer",
      category: "renderer-assets",
      name: "renderer-assets:image-load",
      details: { sourceKind: "hynite-asset", role: "cover", asset: "abc123" }
    } as any);
    service.recordRendererEvent({
      kind: "span-end",
      id: "image-1",
      ts: new Date().toISOString(),
      elapsedMs: 5010,
      durationMs: 5000,
      process: "renderer",
      category: "renderer-assets",
      name: "renderer-assets:image-load",
      status: "cancelled",
      details: { role: "cover" }
    } as any);
    await service.finish();

    const events = await readFile(service.eventsPath, "utf8");
    const report = JSON.parse(await readFile(service.reportPath, "utf8"));
    expect(events).toContain("\"sourceKind\":\"hynite-asset\"");
    expect(report.assets.rendererImagesByStatus.cancelled.count).toBe(1);
    expect(report.assets.rendererImagesByStatus.cancelled.slowest[0].details.sourceKind).toBe("hynite-asset");
    expect(report.summary.slowestSpans.some((span: { status: string }) => span.status === "cancelled")).toBe(false);
  });

  it("redacts secrets and full local paths", async () => {
    process.env.HYNITE_STARTUP_PROFILE = "1";
    const userData = await tempUserData();
    const service = new StartupProfileService(userData, "0.0.0-test");

    service.point("startup", "redaction", {
      steamWebApiKey: "secret",
      path: "C:\\Users\\Example\\asset.png"
    });
    await service.finish();

    const events = await readFile(service.eventsPath, "utf8");
    expect(events).toContain("[redacted]");
    expect(events).not.toContain("C:\\\\Users\\\\Example");
    expect(events).toContain("asset.png");
  });
});
