// Shared crash-reporting config. No Node APIs here so both the main and renderer
// bundles can import it. DSNs are write-only ingestion keys (not secrets), so
// embedding the self-hosted GlitchTip DSN in the client is standard and safe.

export const SENTRY_DSN =
  "https://8c1c1dcc7edf43f7919ba20ca3d136e9@glitchtip.yuma-homeserver.online/1";

/** Build a Sentry release identifier matching the source-map upload in release.mjs. */
export function sentryRelease(version: string): string {
  return `hynite@${version}`;
}

export function sentryEnvironment(isPackaged: boolean): string {
  return isPackaged ? "production" : "development";
}

// Keys whose values may carry Steam tokens / cookies / secrets. Matched
// case-insensitively as a substring of the key name.
const SENSITIVE_KEY_PARTS = [
  "token",
  "cookie",
  "password",
  "secret",
  "authorization",
  "refresh",
  "access_token",
  "session"
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

/**
 * Returns a Sentry `beforeSend` that strips the OS user's home directory and
 * username out of every string in the event, and redacts values under
 * sensitive-looking keys. Generic over the event shape (no @sentry type import
 * needed in this Node-free shared module). Pure string ops — `homeDir`/
 * `username` are supplied by the main process (the renderer routes its events
 * through main, so this one hook scrubs both processes' events).
 */
export function createScrubber(
  homeDir: string,
  username: string
): <E>(event: E) => E {
  const replacements: Array<[RegExp, string]> = [];
  if (homeDir) {
    replacements.push([escapeRegExp(homeDir), "<HOME>"]);
  }
  if (username && username.length >= 3) {
    // After the homeDir pass, catch bare username occurrences in other paths.
    replacements.push([escapeRegExp(username), "<USER>"]);
  }

  const scrubString = (value: string): string => {
    let out = value;
    for (const [pattern, token] of replacements) {
      out = out.replace(pattern, token);
    }
    return out;
  };

  const scrub = (value: unknown, depth: number): unknown => {
    if (depth > 8 || value == null) return value;
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = isSensitiveKey(key) ? "[redacted]" : scrub(val, depth + 1);
      }
      return result;
    }
    return value;
  };

  return <E>(event: E): E => scrub(event, 0) as E;
}

function escapeRegExp(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}
