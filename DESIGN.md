# Hynite — Design Specification

A dark, monochrome desktop game library. The brief: clean and minimal, let the game covers (3:4, rounded corners, GOG-style) speak for themselves; cover-color blurs as the only "color" in the UI; sidebar/modal info panel; native desktop window feel.

This document is a complete recreation guide. Following it should reproduce the design 1:1.

---

## 1. File structure

```
Hynite.html          ← root document. Window chrome, routing, Tweaks panel wiring, status bar.
Hynite-print.html    ← print-ready clone for PDF export (pages stacked, no JS interactivity)
data.jsx             ← procedural game data: title generator, gradient palette, SVG cover generator
components.jsx       ← Icon set, Cover card, FolderTile, Row, NavItem, TrafficLights
screens.jsx          ← HomeScreen, LibraryScreen, StoreScreen, DownloadsScreen, DetailOverlay + buttons + inputs
tweaks-panel.jsx     ← starter component (TweaksPanel + Tweak* form controls + useTweaks hook)
```

`Hynite.html` loads scripts in this order: `data.jsx → components.jsx → screens.jsx → tweaks-panel.jsx → inline App script`. Each `.jsx` ends with `Object.assign(window, { ... })` to expose its exports across Babel's per-script scopes — required because `<script type="text/babel">` files don't share scope automatically.

## 2. Tech stack

- **No UI framework, no design system library.** Everything hand-rolled in React + inline styles.
- **React 18.3.1 + ReactDOM** loaded via UMD from unpkg with integrity hashes.
- **Babel Standalone 7.29.0** for in-browser JSX. All component files use `<script type="text/babel" src="...">`.
- **Inline styles** (object form) for component styling. Layout primitives like `.app-rail`, `.titlebar`, `.statusbar`, `.page` live in a global `<style>` block in `Hynite.html`.
- **No icon library.** A 28-icon stroke set drawn by hand as SVG path strings in `components.jsx` → `ICONS` (home, library, store, download, settings, play, search, folder, grid, list, filter, more, star, trophy, clock, users, arrow, close, chevR, chevL, pin, cloud, check, refresh, heart, plus, flame). Rendered through one `<Icon name size stroke fill>` component, all 24×24 viewBox, `currentColor`, stroke-width 1.5, round caps/joins.

## 3. Visual identity

### Color (monochrome only — accents come from cover art)

```
--bg-0    #0a0b0d   page / window background
--bg-1    #0f1013   panel slot
--bg-2    #15161a   raised
--line    rgba(255,255,255,0.06)   hairline borders
--text    #f4f4f6   primary
--text-2  rgba(255,255,255,0.55)   secondary
```

Tertiary text uses progressively lower alpha on white: `0.55` for body labels, `0.4` for metadata, `0.3` for ghost labels, `0.2` for separators (·). Never use solid mid-greys — always alpha on white over `--bg-0`.

The **only chromatic color** anywhere comes from each game's `cover.dom` value (a single `oklch()` string). It drives:
- Hero blur blobs (Home, Store, Detail overlay)
- Box shadows under hero covers (`0 16px 40px -8px <dom>`)
- The "Play" button's bottom-glow shadow on the detail overlay

### Typography

- **Inter**, weights 400/500/600/700 from Google Fonts.
- **JetBrains Mono** weights 400/500 — used for eyebrow labels (`Continue playing`, `Featured · Out now`, `FOLDER · 7`).
- Body sits at 12–13px; row titles 15px/600/`-0.01em`; screen H1s 22px/600/`-0.02em`; hero H1 42px/600/`-0.025em`. Tabular numerals (`font-variant-numeric: tabular-nums`) on every number.
- `font-feature-settings: 'cv11', 'ss01', 'ss03'` enabled body-wide for Inter's stylistic alternates.

### Borders & radius

- Window 12px, hero blocks 14px, cover cards user-tweakable (default 8, range 0–20), action buttons 8px, badges/icon buttons 7px, inputs 7px, chips 99px (pill), thin borders are `0.5px solid rgba(255,255,255,0.06–0.12)`.

### Shadows

- Window: `0 0 0 0.5px rgba(255,255,255,0.08), 0 30px 80px rgba(0,0,0,0.6)`
- Cover (rest): `0 2px 8px rgba(0,0,0,0.3)`
- Cover (hover lift): `0 12px 28px -8px <coverDom>, 0 4px 12px rgba(0,0,0,0.4)`
- Hero cover: `0 16px 40px -8px <coverDom>, 0 8px 20px rgba(0,0,0,0.45)`
- Detail panel: `-20px 0 60px rgba(0,0,0,0.5)`

## 4. Procedural cover art

Each cover is an inline-SVG data URL composed at module load. `data.jsx` exposes `coverSVG(seed)` returning `{ url, dom, hue, a, b }`.

**Algorithm:**
1. Pick a `GRADIENTS[]` palette (12 muted cinematic two-color pairs: ember/blue/forest/sand/violet/gold/teal/mono/rose/ultramarine/rust/moss). Each palette has its own `dom` (`oklch(0.55 0.10 H)`).
2. Pick one of 4 composition modes:
   - radial highlight + offset circle
   - vertical linear + bottom rectangle
   - radial + horizontal ellipse
   - linear + diagonal polygon
3. Layer an SVG `<feTurbulence baseFrequency="0.9" numOctaves="2">` filter at 18% opacity for grain.
4. Multiply-blend a final linear gradient at 15% to deepen the toe.

`viewBox="0 0 300 400"` (3:4) with `preserveAspectRatio="xMidYMid slice"`. Encoded `encodeURIComponent` and wrapped in `url("data:image/svg+xml;utf8,...")`.

## 5. Procedural titles

`makeTitle(seed)` in `data.jsx`. Three banks: 29 adjectives, 30 nouns, 18 suffixes. Forms: `Adj Noun`, `The Adj Noun`, `Adj of Noun`, `Noun of the Adj`, optionally `+ suffix`. PRNG is a stable LCG so the library never reshuffles between renders.

## 6. Game record shape

```ts
{
  id, title, cover: { url, dom, hue, a, b },
  dev, pub, genres: [string, string],
  playtime, lastPlayedDays, sizeGB, release,
  status: 'installed' | 'cloud' | 'update' | 'not-installed',
  completion, rating
}
```

64 games generated total. Top-level constants pluck specific items: `CONTINUE` = GAMES[12], `RECENT` = 5 picks, `RECOMMENDED` = 6 picks, `NEW_RELEASES` = 5 picks, `WISHLIST` = 4 picks. 6 `FOLDERS` each carry 4–9 game IDs; folder tiles render the first 4 covers in a 2×2 mosaic.

## 7. Application architecture

`App` in `Hynite.html` holds two pieces of state:
- `route` — one of `'home' | 'library' | 'store' | 'downloads'`
- `selectedGame` — game object or null; non-null mounts the `DetailOverlay`

Tweak state via `useTweaks(TWEAK_DEFAULTS)` from the starter:
```js
{ density: 'regular', blurIntensity: 'medium', hoverStyle: 'lift', coverRadius: 8 }
```
The `TWEAK_DEFAULTS` JSON sits inside `/*EDITMODE-BEGIN*/.../*EDITMODE-END*/` markers so the host rewrites it on disk when a tweak is changed.

### Layout

```
┌─ .hynite-window  (1440×900 max, 12px radius, big black shadow) ─┐
│ .titlebar 36px ─ traffic lights · HYNITE · top tabs · user pill │
│ .app-body  (flex)                                                │
│   .app-rail 200px  (Home/Library/Store/Downloads, Folders, Recent, Settings)
│   .app-main  flex 1                                              │
│     .app-content 28/36 padding, scroll-y                         │
│     [DetailOverlay]  (absolute, slides in from right)            │
│ .statusbar 24px ─ status dot · cloud sync · count · version     │
└──────────────────────────────────────────────────────────────────┘
```

The window is `min(1440px, 96vw) × min(900px, 92vh)`, vertically centered. `overflow: hidden` on body to hide scroll-clipping.

### Top tabs vs left rail

Both navigate the same routes — top tabs are the primary affordance (Steam-like), left rail is a secondary contextual list (folders + recent games). `top-tab.active` gets `rgba(255,255,255,0.08)` background; rail `NavItem.active` gets the same.

## 8. Screens

### HomeScreen

1. **Hero** (~360px tall): `position: relative` block with two `blurBlobStyle()` blobs (`tl`, `br`) using `CONTINUE.cover.dom`. Inside: 220px-wide cover left, then column with `Continue playing` eyebrow, 42px title, three meta inline metrics with icons (`clock`, `trophy`, last-played), 320px progress bar (3px tall, 100%-of-`completion`), Play + Details buttons.
2. **Three Rows**: "Jump back in" (RECENT), "Recommended for you" (RECOMMENDED), "New in your library" (NEW_RELEASES). Each is a `<Row>`: 15px header with right-aligned `See all → ` button, then horizontal scrollable strip of 148px Cover cards with 14px gaps.

### LibraryScreen

- Header bar: H1 + game/folder count subtitle, search bar, sort segmented (Recent / A–Z / Most played / Released), view toggle (grid/list icons).
- Filter chips row: All / Installed / Updates available (rounded pill, 99px radius).
- Grid: `grid-template-columns: repeat(auto-fill, minmax(<density>px, 1fr))`. Density mapping: spacious=180, regular=138, dense=96. Folders render first as `FolderTile`s (3:4 ratio, dashed border, 2×2 cover mosaic, "FOLDER · count" label), then all games as `Cover` cards.
- Alternate list view: 6-col grid (cover thumb, Title, Developer, Played, Size, Status). Status word color-codes: update=`#ffd66b`, not-installed=alpha 0.35.

### StoreScreen

Featured hero (same construction as Home hero but a different game, with description copy and Install/Wishlist buttons), then "Trending this week", "From small studios", "On your wishlist" rows.

### DownloadsScreen

Single column queue: 4 items in a stacked card with hairlines between. Each row: cover thumb (48px), title + size, 2px progress bar, status line ("24.3 MB/s · 4 min remaining" / "Queued · paused" / "Queued"), Pause/Resume button.

### DetailOverlay (the modal)

Right-anchored 460px-wide panel. Slides in from `translateX(100%)` over 320ms `cubic-bezier(.2,.7,.2,1)`. ESC key closes; backdrop click closes.

Layout top-to-bottom:
1. Hero block (`padding: 20px 24px 28px`, `position: relative`, `overflow: hidden`):
   - Two blur blobs using `game.cover.dom` (large top-left at -250/-100, smaller top-right at -50/-150)
   - "GAME INFO" eyebrow + close button row
   - 130px cover (3:4) + title/dev/year + genre chips
   - Primary action button (Play / Update / Install with size) + 3 icon buttons (heart, pin, more)
2. 2-column metadata grid (Playtime, Last played, Completion, Critic score, Size, Publisher) — uppercase 9.5px labels, 14px values.
3. About section — 3 sentences of generated copy.
4. Achievements — 5 entries, 3 unlocked (full opacity) and 2 locked (alpha 0.4), each with a trophy chip.
5. System — 4 K/V rows (Storage, Cloud sync, Auto-update, Launch options).

Sections are separated by `borderTop: 0.5px solid rgba(255,255,255,0.06)` with the `<Section>` helper rendering an uppercase 11px/600/0.08em-tracked header.

## 9. The blur blob (the visual signature)

```js
function blurBlobStyle(color, intensity, pos) {
  const SIZE = 600;
  const opacity = { subtle: 0.25, medium: 0.45, bold: 0.7 }[intensity];
  // pos picks a corner placement
  return {
    position: 'absolute', width: SIZE, height: SIZE,
    borderRadius: '50%', background: color,
    filter: 'blur(120px)', opacity, pointerEvents: 'none',
    ...placement,
  };
}
```

Two blobs per hero (`tl` + `br`) gives directional ambient color. The detail overlay tightens the second blob to `subtle`/300px so the panel doesn't drown.

## 10. Cover hover treatments (Tweaks)

Four interchangeable hover styles, picked via Tweaks → Hover style:
- **lift** — `translateY(-4px)` + cover-color box-shadow glow
- **reveal** — bottom 50% gradient with title + playtime fades in
- **tilt** — `perspective(800px) rotateX(3deg) rotateY(-3deg) translateY(-2px)`
- **ring** — hairline `rgba(255,255,255,0.6)` ring around cover (selected uses `#fff`)

All 220ms `cubic-bezier(.2,.7,.2,1)`.

## 11. Tweaks panel

Uses `tweaks-panel.jsx` starter (TweaksPanel + form controls). Two sections:

```jsx
<TweakSection label="Grid">
  <TweakRadio  label="Density"      options={['spacious','regular','dense']} />
  <TweakSlider label="Cover radius" min={0} max={20} unit="px" />
</TweakSection>
<TweakSection label="Visuals">
  <TweakRadio  label="Blur"         options={['subtle','medium','bold']} />
  <TweakSelect label="Hover style"  options={[{value:'lift',label:'Lift + glow'}, ...]} />
</TweakSection>
```

## 12. Buttons & inputs (style references)

```js
primaryBtn   = {bg:'#f4f4f6', fg:'#0d0e10', 600 weight, 10/22 padding}
secondaryBtn = {bg:'rgba(255,255,255,0.08)', border:'0.5px rgba(255,255,255,0.1)'}
iconBtn      = 38×38, same secondary fill
heroPlayBtn  = primaryBtn + box-shadow `0 6px 20px -6px <coverDom>`
```

`SearchBar` — 30px tall pill input with leading search icon, `rgba(255,255,255,0.05)` fill.
`SegmentedSelect` — 28px tall track, 24px thumbs, hairline border, white-tint active.
Filter chips — 99px radius, bg only when active.

## 13. Routing & screen labels

The window root carries `data-screen-label={screenLabels[route]}` cycling through `01 Home`, `02 Library`, `03 Store`, `04 Downloads`. Status bar pinned bottom: dot, online text, cloud sync, game count + storage, version.

## 14. PDF export

`Hynite-print.html` reuses `data.jsx`/`components.jsx`/`screens.jsx` directly. Five fixed 1440×900 `.page` blocks with `break-after: page` (Home, Library, Store, Downloads, Home + DetailOverlay layered on top via absolute positioning). Auto-`window.print()` after `document.fonts.ready` + 500ms safety delay. `@page { size: 1440px 900px; margin: 0 }` plus `-webkit-print-color-adjust: exact` to keep dark backgrounds.

## 15. Recreating from scratch — checklist

1. Set up React+Babel UMD scaffolding with the four split JSX files.
2. Build `data.jsx`: 12 muted gradient palettes, SVG cover generator with grain filter, title generator with 3 word banks, `makeGame()` populator for 64 games, derived constants (CONTINUE/RECENT/etc, FOLDERS).
3. Build `components.jsx`: 28-path icon set + `<Icon>`, `<Cover>` card with 4 hover styles, `<FolderTile>` 2×2 mosaic, `<Row>` horizontal strip, `<TrafficLights>`, `<NavItem>`.
4. Build `screens.jsx`: `<HomeScreen>` (hero + 3 rows), `<LibraryScreen>` (header bar + chips + grid w/ folders, list view fallback), `<StoreScreen>`, `<DownloadsScreen>`, `<DetailOverlay>`. Add the shared `blurBlobStyle()`, button/input style objects.
5. Wire `Hynite.html` shell: window chrome, top tabs, left rail with Folders + Recent sections, route state, selected-game state, status bar, Tweaks panel.
6. Test default tweaks render correctly. Confirm covers don't reshuffle between mounts (PRNG must be deterministic).
