import { describe, expect, it } from "vitest";
import { classifySourcePage, detectChallenge } from "../src/sourcePage";

const validSource = JSON.stringify({
  name: "Example Source",
  downloads: [
    { title: "Some Game", uris: ["magnet:?xt=urn:btih:abc"], fileSize: "1 GB", uploadDate: "2026-01-01" }
  ]
});

// A trimmed-down version of a real Cloudflare "Just a moment…" interstitial.
const cloudflareChallenge = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>
<body><div class="main-wrapper"><h1>Verifying you are human. This may take a few seconds.</h1>
<p>example.com needs to review the security of your connection before proceeding.</p>
<div id="challenge-platform"></div><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page"></script>
<div>Ray ID: 8a1b2c3d4e5f</div><div>Performance &amp; security by Cloudflare</div></div></body></html>`;

describe("detectChallenge", () => {
  it("flags a Cloudflare interstitial by title", () => {
    expect(detectChallenge(cloudflareChallenge, "Just a moment...")).toBeTruthy();
  });

  it("flags a Cloudflare interstitial by body markers", () => {
    expect(detectChallenge(cloudflareChallenge, "")).toBeTruthy();
  });

  it("does not flag plain source JSON even if it mentions a marker word", () => {
    const sneaky = JSON.stringify({ name: "Turnstile", downloads: [] });
    expect(detectChallenge(sneaky, "")).toBeUndefined();
  });
});

describe("classifySourcePage", () => {
  it("treats blank pages as loading", () => {
    expect(classifySourcePage("   ").kind).toBe("loading");
  });

  it("classifies a Cloudflare challenge as challenge", () => {
    const result = classifySourcePage(cloudflareChallenge, "Just a moment...");
    expect(result.kind).toBe("challenge");
  });

  it("classifies a valid Hydra source as json with parsed data", () => {
    const result = classifySourcePage(validSource);
    expect(result.kind).toBe("json");
    if (result.kind === "json") {
      expect(result.source.name).toBe("Example Source");
      expect(result.source.downloads).toHaveLength(1);
      expect(result.rawLength).toBe(validSource.length);
    }
  });

  it("tolerates leading/trailing whitespace around JSON", () => {
    expect(classifySourcePage(`\n\n${validSource}\n`).kind).toBe("json");
  });

  it("reports truncated JSON as still loading (so we keep polling)", () => {
    const result = classifySourcePage(validSource.slice(0, validSource.length - 10));
    expect(result.kind).toBe("loading");
  });

  it("reports well-formed JSON that is not a source as invalid", () => {
    const result = classifySourcePage(JSON.stringify({ hello: "world" }));
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toContain("not a Hydra source");
    }
  });

  it("classifies non-JSON, non-challenge HTML as loading", () => {
    expect(classifySourcePage("<html><body>Some other page</body></html>").kind).toBe("loading");
  });
});
