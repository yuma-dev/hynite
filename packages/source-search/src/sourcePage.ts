import { downloadSourceFileSchema, type DownloadSourceFile } from "./schema";

/**
 * Classification of what an in-app browser is currently showing when we point
 * it at a download-source URL. The fetch flow polls a page and feeds whatever
 * it can scrape / fetch into here to decide whether to keep waiting for the
 * human to clear Cloudflare, succeed, or fail with a precise reason.
 *
 * Kept deliberately pure (no Electron, no DOM) so the brittle detection logic
 * is unit-testable without a human or a real browser.
 */
export type SourcePageClass =
  | { kind: "loading"; reason: string }
  | { kind: "challenge"; reason: string }
  | { kind: "json"; source: DownloadSourceFile; rawLength: number }
  | { kind: "invalid"; reason: string };

const CHALLENGE_MARKERS: ReadonlyArray<{ needle: string; reason: string }> = [
  { needle: "just a moment", reason: "Cloudflare interstitial (\"Just a moment…\")" },
  { needle: "verifying you are human", reason: "Cloudflare human-verification prompt" },
  { needle: "verify you are human", reason: "Cloudflare human-verification prompt" },
  { needle: "checking your browser", reason: "Cloudflare browser check" },
  { needle: "needs to review the security", reason: "Cloudflare security review" },
  { needle: "enable javascript and cookies to continue", reason: "Cloudflare JS/cookies gate" },
  { needle: "cf-browser-verification", reason: "Cloudflare browser-verification marker" },
  { needle: "challenge-platform", reason: "Cloudflare challenge-platform script" },
  { needle: "__cf_chl", reason: "Cloudflare challenge token" },
  { needle: "cf_chl_opt", reason: "Cloudflare challenge options" },
  { needle: "turnstile", reason: "Cloudflare Turnstile widget" },
  { needle: "ray id", reason: "Cloudflare error/Ray-ID page" },
  { needle: "ddos protection by", reason: "DDoS-protection interstitial" },
  { needle: "attention required", reason: "Cloudflare \"Attention Required\" block" }
];

/**
 * Does this text look like a Cloudflare (or similar) bot-check / block page
 * rather than the actual source content? Returns a human-readable reason when
 * it does, otherwise undefined.
 *
 * Only meaningful for non-JSON text — JSON content can legitimately contain
 * these substrings (e.g. a game titled "Turnstile"), so callers must rule out
 * valid JSON first. Guarded here too via the length heuristic: challenge pages
 * are HTML documents, so we require an HTML-ish shape before matching markers.
 */
export function detectChallenge(text: string, title = ""): string | undefined {
  const haystack = `${title}\n${text}`.toLocaleLowerCase();
  const looksLikeHtml = haystack.includes("<html") || haystack.includes("<!doctype") || haystack.includes("<body") || haystack.includes("<script");
  for (const marker of CHALLENGE_MARKERS) {
    if (!haystack.includes(marker.needle)) {
      continue;
    }
    // Bare title markers (e.g. "Just a moment…") fire even without HTML body;
    // body markers require an HTML shape so we don't misread JSON payloads.
    const inTitle = title.toLocaleLowerCase().includes(marker.needle);
    if (inTitle || looksLikeHtml) {
      return marker.reason;
    }
  }
  return undefined;
}

/**
 * Try to read a candidate page payload as a download-source file.
 *
 * `raw` is the best available text — ideally the exact bytes from an in-page
 * `fetch()` of the source URL, falling back to the rendered document text.
 * `title` is the document title, used only to sharpen challenge detection.
 */
export function classifySourcePage(raw: string | null | undefined, title = ""): SourcePageClass {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    return { kind: "loading", reason: "Blank page (still loading)" };
  }

  // A raw JSON document starts with { or [. If it doesn't, it's either the
  // challenge HTML or some other non-source page — classify without paying for
  // a JSON.parse on a huge HTML blob.
  const firstChar = text[0];
  if (firstChar !== "{" && firstChar !== "[") {
    const challenge = detectChallenge(text, title);
    if (challenge) {
      return { kind: "challenge", reason: challenge };
    }
    return { kind: "loading", reason: "Page is not JSON yet" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Looks like JSON (leading brace) but didn't parse — most likely a
    // truncated/streaming render. Treat as still-loading so we poll again.
    return { kind: "loading", reason: `JSON not complete yet (${(error as Error).message})` };
  }

  const result = downloadSourceFileSchema.safeParse(parsed);
  if (result.success) {
    return { kind: "json", source: result.data, rawLength: text.length };
  }

  const issue = result.error.issues[0];
  const path = issue?.path.join(".") || "(root)";
  return {
    kind: "invalid",
    reason: `Valid JSON but not a Hydra source: ${issue?.message ?? "schema mismatch"} at ${path}`
  };
}
