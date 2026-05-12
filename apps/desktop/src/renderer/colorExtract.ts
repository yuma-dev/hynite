// Dominant-color sampler for game covers.
//
// Returns a *weighted* palette: each entry is a hex color plus a 0..1 weight
// proportional to that color's prevalence on the cover. Consumers expand the
// weights across shader color slots so that dominant colors actually dominate
// the resulting blend (a mostly-red cover doesn't get equal red/blue mix).
//
// Approach: downsample image to 32x32, bucket pixels by coarse HSL, score each
// bucket by (count * saturation * mid-lightness), then take up to N buckets
// whose contribution exceeds a minimum-share threshold. Weights are
// normalized so they sum to 1.

export type WeightedColor = { hex: string; weight: number };

export type CoverPalette = {
  colors: WeightedColor[];
};

const PALETTE_CACHE = new Map<string, CoverPalette>();
const PALETTE_PENDING = new Map<string, Promise<CoverPalette | undefined>>();

// Minimum share (after normalization) for a color to make it into the palette.
const MIN_COLOR_SHARE = 0.1;
// Hard cap on palette size. Below 8 since ColorBends shader MAX_COLORS = 8.
const MAX_PALETTE_COLORS = 4;

export function getCachedPalette(url: string | undefined): CoverPalette | undefined {
  if (!url) return undefined;
  return PALETTE_CACHE.get(url);
}

export function fallbackPalette(): CoverPalette {
  return {
    colors: [
      { hex: "#3a2f6b", weight: 0.55 },
      { hex: "#6b2f5b", weight: 0.3 },
      { hex: "#1a3a6b", weight: 0.15 }
    ]
  };
}

/**
 * Stable palette derived from any string. Always returns 2 colors with a
 * dominant primary (~70%) so the background has a clear hero color even
 * before image extraction succeeds.
 */
export function paletteFromSeed(seed: string): CoverPalette {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  const hue1 = Math.abs(h) % 360;
  const hue2 = (hue1 + 140 + ((h >>> 4) & 0x3f)) % 360;
  return {
    colors: [
      { hex: hslToHex(hue1, 0.6, 0.45), weight: 0.7 },
      { hex: hslToHex(hue2, 0.55, 0.4), weight: 0.3 }
    ]
  };
}

/**
 * Expand a weighted palette into a fixed-length array of color slots, where
 * dominant colors occupy more slots. Used to feed ColorBends with effectively
 * proportional influence.
 */
export function expandPaletteToSlots(palette: CoverPalette, slotCount: number): string[] {
  if (palette.colors.length === 0) return new Array(slotCount).fill("#3a2f6b");
  const totalWeight = palette.colors.reduce((sum, c) => sum + c.weight, 0) || 1;
  const slots: string[] = [];
  // Pass 1: integer slot allocations by weight share.
  const allocations = palette.colors.map((c) => ({
    color: c,
    target: (c.weight / totalWeight) * slotCount,
    assigned: 0
  }));
  // Every color gets at least 1 slot (otherwise minor colors disappear entirely).
  let used = 0;
  for (const a of allocations) {
    a.assigned = Math.max(1, Math.floor(a.target));
    used += a.assigned;
  }
  // Distribute remaining slots to colors with the largest fractional remainders.
  let remaining = slotCount - used;
  if (remaining > 0) {
    const remainders = allocations
      .map((a, idx) => ({ idx, frac: a.target - a.assigned }))
      .sort((a, b) => b.frac - a.frac);
    for (const r of remainders) {
      if (remaining === 0) break;
      allocations[r.idx]!.assigned += 1;
      remaining -= 1;
    }
  }
  // If we over-allocated (too many colors, each gets 1, exceeds slotCount),
  // drop the lowest-weight colors so the total fits.
  while (used > slotCount && allocations.length > 1) {
    const min = allocations.reduce((acc, a, i) => (a.color.weight < allocations[acc]!.color.weight ? i : acc), 0);
    used -= allocations[min]!.assigned;
    allocations.splice(min, 1);
  }
  for (const a of allocations) {
    for (let i = 0; i < a.assigned; i++) {
      slots.push(a.color.hex);
      if (slots.length === slotCount) break;
    }
    if (slots.length === slotCount) break;
  }
  // Final safety: pad with primary if anything short.
  while (slots.length < slotCount) slots.push(allocations[0]!.color.hex);
  return slots;
}

export async function extractPalette(url: string | undefined): Promise<CoverPalette | undefined> {
  if (!url) return undefined;
  const cached = PALETTE_CACHE.get(url);
  if (cached) return cached;
  const pending = PALETTE_PENDING.get(url);
  if (pending) return pending;
  const promise = doExtract(url).then((palette) => {
    PALETTE_PENDING.delete(url);
    if (palette) PALETTE_CACHE.set(url, palette);
    return palette;
  });
  PALETTE_PENDING.set(url, promise);
  return promise;
}

async function doExtract(url: string): Promise<CoverPalette | undefined> {
  try {
    const image = await loadImage(url);
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    type Bucket = { r: number; g: number; b: number; count: number; score: number };
    const buckets = new Map<number, Bucket>();

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      if (a < 200) continue;

      const [h, s, l] = rgbToHsl(r, g, b);
      if (l < 0.05 || l > 0.96) continue;

      const hueBucket = Math.floor(h * 12);
      const satBucket = s < 0.2 ? 0 : s < 0.5 ? 1 : 2;
      const lightBucket = Math.floor(l * 4);
      const key = (hueBucket << 6) | (satBucket << 3) | lightBucket;

      // Per-pixel weight emphasises saturated and mid-light pixels but a near-
      // grey pixel still counts as "1" so it can't be over-weighted. This keeps
      // raw count meaningful for dominance.
      const midLightBoost = 1 - Math.abs(l - 0.5) * 1.4;
      const pixelScore = (0.4 + s * 1.6) * Math.max(0.1, midLightBoost);
      const entry = buckets.get(key);
      if (entry) {
        entry.r += r;
        entry.g += g;
        entry.b += b;
        entry.count += 1;
        entry.score += pixelScore;
      } else {
        buckets.set(key, { r, g, b, count: 1, score: pixelScore });
      }
    }

    if (!buckets.size) return undefined;

    const ranked = Array.from(buckets.values())
      .map((b) => ({
        r: Math.round(b.r / b.count),
        g: Math.round(b.g / b.count),
        b: Math.round(b.b / b.count),
        count: b.count,
        score: b.score
      }))
      .sort((a, b) => b.score - a.score);

    // Greedy distinct-color pick. Each pick carries its raw score so we can
    // normalize to weights afterwards.
    const picks: Array<{ r: number; g: number; b: number; score: number }> = [];
    for (const candidate of ranked) {
      if (picks.length >= MAX_PALETTE_COLORS) break;
      if (picks.every((p) => colorDistance(p, candidate) > 60)) {
        picks.push(candidate);
      }
    }
    if (!picks.length) return undefined;

    const total = picks.reduce((sum, p) => sum + p.score, 0) || 1;
    let weighted: WeightedColor[] = picks.map((p) => ({
      hex: rgbToHex(p),
      weight: p.score / total
    }));

    // Drop colors below the minimum share. Re-normalize.
    weighted = weighted.filter((c) => c.weight >= MIN_COLOR_SHARE);
    if (!weighted.length) {
      // The top color was just very dominant. Fall back to taking the very top.
      weighted = [{ hex: rgbToHex(picks[0]!), weight: 1 }];
    }
    const renorm = weighted.reduce((s, c) => s + c.weight, 0) || 1;
    weighted = weighted.map((c) => ({ hex: c.hex, weight: c.weight / renorm }));

    return { colors: weighted };
  } catch {
    return undefined;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = url;
  });
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}

function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const m = l - c / 2;
  return rgbToHex({
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255
  });
}
