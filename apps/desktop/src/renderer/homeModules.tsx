import {
  Activity,
  Bookmark,
  Calendar,
  ChevronDown,
  Clock3,
  Compass,
  Download,
  Flame,
  GripVertical,
  HardDrive,
  Heart,
  Image as ImageIcon,
  LayoutGrid,
  Library as LibraryIcon,
  Moon,
  Play,
  Plus,
  Settings as SettingsIcon,
  Shuffle,
  Sparkles,
  Star,
  Trash2,
  Trophy,
  X
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  defaultTitleForSource,
  gameActivityTime,
  HOME_MODULE_SOURCE_LABELS,
  homeModuleSourceKey,
  type Game,
  type GameGroup,
  type HomeLayout,
  type HomeModel,
  type HomeModule,
  type HomeModuleCardSize,
  type HomeModuleSort,
  type HomeModuleSortField,
  type HomeModuleSource,
  type HomeModuleVisual,
  type SteamWishlistItem
} from "@hynite/core";

export type HomeResolveContext = {
  home?: HomeModel;
  libraryGames: Game[];
  wishlistItems: SteamWishlistItem[];
  groups: GameGroup[];
  /** Stable seed per app session — keeps "random" / "shuffle" stable across re-renders. */
  randomSeed: number;
  /** Extra discovery-queue games loaded on demand as the user scrolls (infinite queue). */
  extraDiscoveryQueue?: Game[];
};

/** Interleave two lists 1:1 (a0, b0, a1, b1, …); the longer list's tail is appended. Dedupes by id. */
function interleaveGames(a: Game[], b: Game[]): Game[] {
  const out: Game[] = [];
  const seen = new Set<string>();
  const push = (game: Game | undefined) => {
    if (game && !seen.has(game.id)) {
      seen.add(game.id);
      out.push(game);
    }
  };
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    push(a[i]);
    push(b[i]);
  }
  return out;
}

function dedupeById(games: Game[]): Game[] {
  const seen = new Set<string>();
  return games.filter((game) => (seen.has(game.id) ? false : (seen.add(game.id), true)));
}

export function wishlistItemToGame(item: SteamWishlistItem): Game {
  return {
    id: `steam:${item.appid}`,
    title: item.title,
    sortTitle: item.sortTitle,
    sourceIds: [{ provider: "steam", externalId: item.appid }],
    installState: "unknown",
    coverUrl: item.coverUrl,
    libraryCapsuleUrl: item.libraryCapsuleUrl,
    headerUrl: item.headerUrl,
    backgroundUrl: item.backgroundUrl,
    logoUrl: item.logoUrl,
    communityIconUrl: item.communityIconUrl,
    screenshots: [],
    genres: [],
    tags: [],
    playerModes: [],
    developers: [],
    publishers: [],
    contentDescriptors: [],
    releaseDate: item.releaseDate,
    metadataStatus: item.metadataStatus
  };
}

function seededShuffle<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = items.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function stringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function parseDate(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveSourceGames(source: HomeModuleSource, ctx: HomeResolveContext): Game[] {
  switch (source.kind) {
    case "homeModel": {
      const row = source.row;
      // Discovery rows (popularNow/recommended/newAndNotable) stay from the home service —
      // they're external suggestions, not library games.
      if (row === "discoveryQueue") {
        // Base queue from the home model, plus any batches loaded on demand as the user scrolls.
        return dedupeById([...(ctx.home?.discoveryQueue ?? []), ...(ctx.extraDiscoveryQueue ?? [])]);
      }
      if (row === "popularNow" || row === "recommended" || row === "newAndNotable") {
        return ctx.home?.[row] ?? [];
      }
      // Library activity rows are just a sort of the user's own library. Library size is the cap.
      const lib = ctx.libraryGames;
      if (row === "mostPlayed") {
        return lib
          .filter((g) => (g.playtimeMinutes ?? 0) > 0)
          .slice()
          .sort((a, b) => (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0));
      }
      if (row === "continuePlaying") {
        return lib
          .filter((g) => parseDate(g.lastPlayedAt) > 0)
          .slice()
          .sort((a, b) => parseDate(b.lastPlayedAt) - parseDate(a.lastPlayedAt));
      }
      if (row === "recentActivity") {
        return lib
          .filter((g) => gameActivityTime(g) > 0)
          .slice()
          .sort((a, b) => gameActivityTime(b) - gameActivityTime(a));
      }
      return ctx.home?.[row] ?? [];
    }
    case "discoveryMix":
      // Top new releases interleaved 1:1 with your personalised recommendations.
      return interleaveGames(ctx.home?.newAndNotable ?? [], ctx.home?.recommended ?? []);
    case "wishlist":
      return ctx.wishlistItems.map(wishlistItemToGame);
    case "wishlistUpcoming": {
      const now = Date.now();
      return ctx.wishlistItems
        .filter((item) => {
          const ts = parseDate(item.releaseDate);
          return ts > now;
        })
        .sort((a, b) => parseDate(a.releaseDate) - parseDate(b.releaseDate))
        .map(wishlistItemToGame);
    }
    case "neverPlayed":
      return ctx.libraryGames.filter((g) => (g.playtimeMinutes ?? 0) === 0);
    case "recentlyAdded":
      return ctx.libraryGames
        .slice()
        .sort((a, b) => parseDate(b.addedAt) - parseDate(a.addedAt));
    case "installed":
      return ctx.libraryGames.filter((g) => g.installState === "installed");
    case "random":
      // No artificial cap. Library size is the cap; user can still apply `limit` per-module.
      return seededShuffle(ctx.libraryGames, ctx.randomSeed);
    case "group": {
      const group = ctx.groups.find((g) => g.id === source.groupId);
      if (!group) return [];
      if (group.kind === "manual") {
        const byId = new Map(ctx.libraryGames.map((g) => [g.id, g]));
        return group.gameIds
          .map((id) => byId.get(id))
          .filter((g): g is Game => Boolean(g));
      }
      // Smart groups: best-effort client-side filter against current libraryGames.
      // This isn't a full LibraryQuery executor (no fulltext search), but it matches the common cases.
      const view = group.view;
      const filters = view?.filters ?? {};
      const installState = filters.installState;
      const ownership = filters.ownership;
      const sources = filters.sources;
      const genres = filters.genres;
      const tags = filters.tags;
      const playerModes = filters.playerModes;
      return ctx.libraryGames.filter((g) => {
        if (installState && installState !== "all" && g.installState !== installState) return false;
        if (sources && sources.length > 0 && !g.sourceIds.some((s) => sources.includes(s.provider))) return false;
        if (genres && genres.length > 0 && !genres.some((genre) => g.genres.includes(genre))) return false;
        if (tags && tags.length > 0 && !tags.some((tag) => g.tags.includes(tag))) return false;
        if (playerModes && playerModes.length > 0 && !playerModes.some((m) => g.playerModes.includes(m))) return false;
        if (ownership && ownership !== "all") {
          const isFamily = g.sourceIds.some((s) => s.shareType === "family");
          if (ownership === "owned" && isFamily) return false;
          if (ownership === "family" && !isFamily) return false;
        }
        return true;
      });
    }
    default:
      return [];
  }
}

function compareGames(a: Game, b: Game, field: HomeModuleSortField): number {
  switch (field) {
    case "title":
      return a.sortTitle.localeCompare(b.sortTitle);
    case "playtime":
      return (b.playtimeMinutes ?? 0) - (a.playtimeMinutes ?? 0);
    case "lastPlayed":
      return parseDate(b.lastPlayedAt) - parseDate(a.lastPlayedAt);
    case "releaseDate":
      return parseDate(b.releaseDate) - parseDate(a.releaseDate);
    case "addedAt":
      return parseDate(b.addedAt) - parseDate(a.addedAt);
    default:
      return 0;
  }
}

export function resolveModuleGames(module: HomeModule, ctx: HomeResolveContext): Game[] {
  const base = resolveSourceGames(module.source, ctx);
  let ordered: Game[] = base;

  const sort = module.sort;
  if (sort && sort.field !== "default") {
    if (sort.field === "shuffle") {
      const seed = (ctx.randomSeed ^ stringHash(module.id)) >>> 0;
      ordered = seededShuffle(base, seed);
    } else {
      const sorted = base.slice().sort((a, b) => compareGames(a, b, sort.field));
      ordered = sort.direction === "asc" ? sorted : sorted.reverse();
    }
  }

  const limit = module.limit;
  if (typeof limit === "number" && limit > 0) {
    return ordered.slice(0, limit);
  }
  return ordered;
}

export function makeModuleId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `module-${crypto.randomUUID()}`;
  }
  return `module-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function newDraftModule(): HomeModule {
  return {
    id: makeModuleId(),
    title: defaultTitleForSource({ kind: "homeModel", row: "continuePlaying" }),
    visual: "scroller",
    source: { kind: "homeModel", row: "continuePlaying" }
  };
}

export function SortableModule({
  id,
  editing,
  isDraft,
  children
}: {
  id: string;
  editing: boolean;
  isDraft?: boolean;
  children: (handleProps: { listeners: ReturnType<typeof useSortable>["listeners"]; isDragging: boolean }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing || isDraft
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined
  };
  const className = [
    "home-module",
    editing ? "editing" : undefined,
    isDraft ? "is-draft" : undefined
  ].filter(Boolean).join(" ");
  return (
    <div ref={setNodeRef} style={style} className={className} {...attributes}>
      {children({ listeners, isDragging })}
    </div>
  );
}

export function ModuleEditChrome({
  title,
  dragListeners,
  onConfigure,
  onDelete,
  hideDelete
}: {
  title: string;
  dragListeners: ReturnType<typeof useSortable>["listeners"];
  onConfigure: () => void;
  onDelete: () => void;
  hideDelete?: boolean;
}) {
  return (
    <div className="home-edit-toolbar" role="toolbar" aria-label={`Edit ${title}`}>
      <button
        type="button"
        className="home-edit-handle"
        aria-label={`Drag ${title}`}
        {...dragListeners}
      >
        <GripVertical size={16} />
        <span>{title}</span>
      </button>
      <div className="home-edit-actions">
        <button type="button" onClick={onConfigure} aria-label={`Configure ${title}`}>
          <SettingsIcon size={15} />
        </button>
        {hideDelete ? null : (
          <button type="button" onClick={onDelete} aria-label={`Delete ${title}`}>
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AddModuleButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="home-add-module" onClick={onClick} disabled={disabled}>
      <Plus size={18} />
      <span>Add module</span>
    </button>
  );
}

export function HomeEditBar({
  onDone,
  onReset
}: {
  onDone: () => void;
  onReset: () => void;
}) {
  return (
    <div className="home-edit-bar" role="region" aria-label="Home edit actions">
      <button type="button" className="secondary-action" onClick={onReset}>
        Reset to default
      </button>
      <button type="button" className="primary-action" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

const VISUAL_LABELS: Record<HomeModuleVisual, string> = {
  hero: "Hero banner",
  scroller: "Side scroller",
  grid: "Grid"
};

const VISUAL_DESCRIPTIONS: Record<HomeModuleVisual, string> = {
  hero: "One big featured game with art and details.",
  scroller: "Horizontal row of covers you can scroll through.",
  grid: "Multi-row grid of covers, fully visible at once."
};

const SORT_FIELD_LABELS: Record<HomeModuleSortField, string> = {
  default: "Source default",
  title: "Title",
  playtime: "Playtime",
  lastPlayed: "Last played",
  releaseDate: "Release date",
  addedAt: "Added to library",
  shuffle: "Shuffle"
};

const CARD_SIZE_LABELS: Record<HomeModuleCardSize, string> = {
  compact: "Compact",
  default: "Default",
  large: "Large"
};

type SourceCategoryId = "library" | "discovery" | "wishlist" | "custom" | "groups";

type SourceOption = {
  source: HomeModuleSource;
  label: string;
  description: string;
  icon: LucideIcon;
};

type SourceCategory = {
  id: SourceCategoryId;
  label: string;
  icon: LucideIcon;
  options?: SourceOption[];
  isGroups?: boolean;
};

const SOURCE_CATEGORIES: SourceCategory[] = [
  {
    id: "library",
    label: "Library",
    icon: LibraryIcon,
    options: [
      { source: { kind: "homeModel", row: "continuePlaying" }, label: "Recently played", description: "Pick back up where you left off.", icon: Play },
      { source: { kind: "homeModel", row: "mostPlayed" }, label: "Most played", description: "Your highest playtime games.", icon: Trophy },
      { source: { kind: "homeModel", row: "recentActivity" }, label: "Recent activity", description: "Anything launched lately.", icon: Activity },
      { source: { kind: "recentlyAdded" }, label: "Recently added", description: "Newest entries in your library.", icon: Download },
      { source: { kind: "neverPlayed" }, label: "Never played", description: "Owned but never launched.", icon: Moon },
      { source: { kind: "installed" }, label: "Installed only", description: "Ready to play right now.", icon: HardDrive }
    ]
  },
  {
    id: "discovery",
    label: "Discovery",
    icon: Flame,
    options: [
      { source: { kind: "discoveryMix" }, label: "New & recommended", description: "Top new releases mixed with your picks.", icon: Sparkles },
      { source: { kind: "homeModel", row: "popularNow" }, label: "Popular now", description: "Steam's featured storefront feed.", icon: Flame },
      { source: { kind: "homeModel", row: "recommended" }, label: "Recommended for you", description: "Picks from your logged-in Steam homepage.", icon: Sparkles },
      { source: { kind: "homeModel", row: "discoveryQueue" }, label: "Discovery queue", description: "Your personalised Steam discovery queue.", icon: Compass },
      { source: { kind: "homeModel", row: "newAndNotable" }, label: "Top new releases", description: "Steam's curated monthly top releases.", icon: Star }
    ]
  },
  {
    id: "wishlist",
    label: "Wishlist",
    icon: Heart,
    options: [
      { source: { kind: "wishlist" }, label: "Wishlist", description: "Everything you've wishlisted.", icon: Heart },
      { source: { kind: "wishlistUpcoming" }, label: "Upcoming", description: "Wishlist items with a future release date.", icon: Calendar }
    ]
  },
  {
    id: "custom",
    label: "Custom",
    icon: Shuffle,
    options: [
      { source: { kind: "random" }, label: "Random picks", description: "Surprise me from my library.", icon: Shuffle }
    ]
  },
  {
    id: "groups",
    label: "Groups",
    icon: Bookmark,
    isGroups: true
  }
];

function findCategoryForSource(source: HomeModuleSource): SourceCategoryId {
  if (source.kind === "group") return "groups";
  if (source.kind === "discoveryMix") return "discovery";
  if (source.kind === "wishlist" || source.kind === "wishlistUpcoming") return "wishlist";
  if (source.kind === "random") return "custom";
  if (source.kind === "homeModel") {
    if (source.row === "popularNow" || source.row === "recommended" || source.row === "newAndNotable" || source.row === "discoveryQueue") return "discovery";
    return "library";
  }
  return "library";
}

const VISUAL_ICONS: Record<HomeModuleVisual, LucideIcon> = {
  hero: ImageIcon,
  scroller: Activity,
  grid: LayoutGrid
};

function SourceCountBadge({ count }: { count: number | undefined }) {
  if (count === undefined) return null;
  if (count === 0) {
    return <span className="source-card-badge empty">Empty</span>;
  }
  const label = count > 99 ? "99+" : String(count);
  return <span className="source-card-badge">{label}</span>;
}

function VisualPreview({ visual }: { visual: HomeModuleVisual }) {
  if (visual === "hero") {
    return (
      <span className="visual-preview visual-preview-hero" aria-hidden>
        <span className="visual-preview-art" />
        <span className="visual-preview-meta">
          <span className="visual-preview-title" />
          <span className="visual-preview-line" />
          <span className="visual-preview-line short" />
        </span>
      </span>
    );
  }
  if (visual === "scroller") {
    return (
      <span className="visual-preview visual-preview-scroller" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => <span key={i} className="visual-preview-card" />)}
      </span>
    );
  }
  return (
    <span className="visual-preview visual-preview-grid" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => <span key={i} className="visual-preview-card" />)}
    </span>
  );
}

export type ModuleConfigPanelProps = {
  module: HomeModule;
  groups: GameGroup[];
  draft: boolean;
  ctx?: HomeResolveContext;
  onChange: (next: HomeModule) => void;
  onCancel: () => void;
  onConfirmAdd?: () => void;
  onClose: () => void;
};

export function ModuleConfigPanel({
  module,
  groups,
  draft,
  ctx,
  onChange,
  onCancel,
  onConfirmAdd,
  onClose
}: ModuleConfigPanelProps) {
  const [title, setTitle] = useState(module.title);
  const [activeCategory, setActiveCategory] = useState<SourceCategoryId>(() => findCategoryForSource(module.source));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    setTitle(module.title);
  }, [module.id, module.title]);

  useEffect(() => {
    setActiveCategory(findCategoryForSource(module.source));
  }, [module.source]);

  function commitTitle(next: string) {
    const trimmed = next.trim() || defaultTitleForSource(module.source, groups);
    onChange({ ...module, title: trimmed });
  }

  function setVisual(visual: HomeModuleVisual) {
    const next: HomeModule = { ...module, visual };
    if (visual === "grid" && !next.gridRows) next.gridRows = 2;
    onChange(next);
  }

  function setSource(source: HomeModuleSource) {
    onChange({
      ...module,
      source,
      title: defaultTitleForSource(source, groups)
    });
  }

  function setGridRows(rows: 1 | 2 | 3 | 4) {
    onChange({ ...module, gridRows: rows });
  }

  function setLimit(limit: number | undefined) {
    onChange({ ...module, limit });
  }

  function setSort(sort: HomeModuleSort | undefined) {
    onChange({ ...module, sort });
  }

  function setCardSize(size: HomeModuleCardSize | undefined) {
    onChange({ ...module, cardSize: size });
  }

  function toggleHideTitle() {
    onChange({ ...module, hideTitle: !module.hideTitle });
  }

  const sourceKey = homeModuleSourceKey(module.source);
  const groupId = module.source.kind === "group" ? module.source.groupId : undefined;
  const sortField = module.sort?.field ?? "default";
  const sortDirection = module.sort?.direction ?? "desc";
  const cardSize = module.cardSize ?? "default";
  const sortDisabled = sortField === "default" || sortField === "shuffle";
  const activeCategoryDef = SOURCE_CATEGORIES.find((c) => c.id === activeCategory) ?? SOURCE_CATEGORIES[0]!;
  const currentSourceLabel = (() => {
    const opt = SOURCE_CATEGORIES.flatMap((c) => c.options ?? []).find((o) => homeModuleSourceKey(o.source) === sourceKey);
    if (opt) return opt.label;
    if (module.source.kind === "group") {
      return groups.find((g) => g.id === groupId)?.name ?? "Group";
    }
    return "Module";
  })();

  return (
    <div className="home-module-config v2" role="dialog" aria-label={`Configure ${module.title}`}>
      <header className="home-config-header">
        <div>
          <span className="home-config-eyebrow">{draft ? "Add a module" : "Editing module"}</span>
          <h3>{currentSourceLabel}</h3>
        </div>
        <button type="button" className="home-config-icon-btn" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </header>

      <div className="home-config-body">
        <section className="home-config-section">
          <div className="home-config-section-head">
            <span className="home-config-step">1</span>
            <div>
              <h4>Choose a look</h4>
              <p>How this module should appear on your home page.</p>
            </div>
          </div>
          <div className="home-config-visuals">
            {(Object.keys(VISUAL_LABELS) as HomeModuleVisual[]).map((visual) => {
              const Icon = VISUAL_ICONS[visual];
              return (
                <button
                  key={visual}
                  type="button"
                  className={`visual-card ${module.visual === visual ? "active" : ""}`}
                  onClick={() => setVisual(visual)}
                  aria-pressed={module.visual === visual}
                >
                  <VisualPreview visual={visual} />
                  <span className="visual-card-meta">
                    <span className="visual-card-title">
                      <Icon size={14} />
                      <span>{VISUAL_LABELS[visual]}</span>
                    </span>
                    <span className="visual-card-desc">{VISUAL_DESCRIPTIONS[visual]}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="home-config-section">
          <div className="home-config-section-head">
            <span className="home-config-step">2</span>
            <div>
              <h4>Pick the content</h4>
              <p>What this module will show.</p>
            </div>
          </div>

          <div className="home-config-content">
            <nav className="home-config-cats" aria-label="Source categories">
              {SOURCE_CATEGORIES.map((category) => {
                const Icon = category.icon;
                return (
                  <button
                    key={category.id}
                    type="button"
                    className={`home-config-cat ${activeCategory === category.id ? "active" : ""}`}
                    onClick={() => setActiveCategory(category.id)}
                    aria-pressed={activeCategory === category.id}
                  >
                    <Icon size={16} />
                    <span>{category.label}</span>
                  </button>
                );
              })}
            </nav>

            <div className="home-config-source-grid">
              {activeCategoryDef.isGroups ? (
                groups.length === 0 ? (
                  <div className="home-config-empty">
                    <Bookmark size={22} />
                    <p>You haven't made any groups yet.</p>
                    <span>Create a group from your Library page, then come back to pin it here.</span>
                  </div>
                ) : (
                  groups.map((group) => {
                    const key = `group:${group.id}`;
                    const active = key === sourceKey;
                    const count = ctx ? resolveSourceGames({ kind: "group", groupId: group.id }, ctx).length : undefined;
                    const isEmpty = count === 0;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`source-card ${active ? "active" : ""} ${isEmpty ? "empty" : ""}`}
                        onClick={() => setSource({ kind: "group", groupId: group.id })}
                      >
                        <span className="source-card-icon">
                          <Bookmark size={16} />
                        </span>
                        <span className="source-card-meta">
                          <span className="source-card-title">{group.name}</span>
                          <span className="source-card-desc">
                            {group.kind === "manual" ? `${group.gameIds.length} games` : "Smart group"}
                          </span>
                        </span>
                        <SourceCountBadge count={count} />
                      </button>
                    );
                  })
                )
              ) : (
                (activeCategoryDef.options ?? []).map((option) => {
                  const key = homeModuleSourceKey(option.source);
                  const Icon = option.icon;
                  const active = key === sourceKey;
                  const count = ctx ? resolveSourceGames(option.source, ctx).length : undefined;
                  const isEmpty = count === 0;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`source-card ${active ? "active" : ""} ${isEmpty ? "empty" : ""}`}
                      onClick={() => setSource(option.source)}
                      title={isEmpty ? "No items match right now" : undefined}
                    >
                      <span className="source-card-icon">
                        <Icon size={16} />
                      </span>
                      <span className="source-card-meta">
                        <span className="source-card-title">{option.label}</span>
                        <span className="source-card-desc">{option.description}</span>
                      </span>
                      <SourceCountBadge count={count} />
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {groupId && !groups.some((g) => g.id === groupId) ? (
            <p className="home-config-hint warn">This group no longer exists. Pick another option.</p>
          ) : null}
        </section>

        <section className="home-config-section">
          <button
            type="button"
            className={`home-config-advanced-toggle ${advancedOpen ? "open" : ""}`}
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            <ChevronDown size={14} />
            <span>Refine</span>
            <em>title, sort, limit, card size{module.visual === "grid" ? ", grid rows" : ""}</em>
          </button>

          {advancedOpen ? (
            <div className="home-config-advanced">
              <div className="home-config-advanced-grid">
                <label className="home-config-field">
                  <span>Title</span>
                  <input
                    type="text"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={(event) => commitTitle(event.target.value)}
                    placeholder={defaultTitleForSource(module.source, groups)}
                  />
                  {module.visual !== "hero" ? (
                    <label className="home-config-checkbox">
                      <input type="checkbox" checked={Boolean(module.hideTitle)} onChange={toggleHideTitle} />
                      <span>Hide title above module</span>
                    </label>
                  ) : null}
                </label>

                <div className="home-config-field">
                  <span>Sort</span>
                  <div className="home-config-pills">
                    {(Object.keys(SORT_FIELD_LABELS) as HomeModuleSortField[]).map((field) => (
                      <button
                        key={field}
                        type="button"
                        className={sortField === field ? "active" : undefined}
                        onClick={() =>
                          field === "default"
                            ? setSort(undefined)
                            : setSort({ field, direction: sortDirection })
                        }
                      >
                        {SORT_FIELD_LABELS[field]}
                      </button>
                    ))}
                  </div>
                  <div className="home-config-pills">
                    <button
                      type="button"
                      disabled={sortDisabled}
                      className={!sortDisabled && sortDirection === "desc" ? "active" : undefined}
                      onClick={() => setSort({ field: sortField, direction: "desc" })}
                    >
                      Descending
                    </button>
                    <button
                      type="button"
                      disabled={sortDisabled}
                      className={!sortDisabled && sortDirection === "asc" ? "active" : undefined}
                      onClick={() => setSort({ field: sortField, direction: "asc" })}
                    >
                      Ascending
                    </button>
                  </div>
                </div>

                <label className="home-config-field">
                  <span>Max items {module.limit ? `(${module.limit})` : "(no limit)"}</span>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={1}
                    value={module.limit ?? 0}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setLimit(value > 0 ? value : undefined);
                    }}
                  />
                </label>

                {module.visual !== "hero" ? (
                  <div className="home-config-field">
                    <span>Card size</span>
                    <div className="home-config-pills">
                      {(Object.keys(CARD_SIZE_LABELS) as HomeModuleCardSize[]).map((size) => (
                        <button
                          key={size}
                          type="button"
                          className={cardSize === size ? "active" : undefined}
                          onClick={() => setCardSize(size)}
                        >
                          {CARD_SIZE_LABELS[size]}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {module.visual === "grid" ? (
                  <div className="home-config-field">
                    <span>Grid rows</span>
                    <div className="home-config-pills">
                      {[1, 2, 3, 4].map((rows) => (
                        <button
                          key={rows}
                          type="button"
                          className={module.gridRows === rows ? "active" : undefined}
                          onClick={() => setGridRows(rows as 1 | 2 | 3 | 4)}
                        >
                          {rows}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <footer className="home-config-footer">
        {draft ? (
          <>
            <button type="button" className="secondary-action" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="primary-action" onClick={onConfirmAdd}>
              <Plus size={14} /> Add module
            </button>
          </>
        ) : (
          <button type="button" className="primary-action" onClick={onClose}>
            Done
          </button>
        )}
      </footer>
    </div>
  );
}

export function HomeGridBlock({
  title,
  hideTitle,
  games,
  gridRows,
  cardsPerRow,
  cardGridStyleFor,
  cardSize,
  renderCard
}: {
  title: string;
  hideTitle?: boolean;
  games: Game[];
  gridRows: 1 | 2 | 3 | 4;
  cardsPerRow: number;
  cardGridStyleFor: (cardsPerRow: number) => CSSProperties;
  cardSize?: HomeModuleCardSize;
  renderCard: (game: Game) => ReactNode;
}) {
  const effectiveCardsPerRow = adjustCardsPerRow(cardsPerRow, cardSize);
  const initial = Math.max(1, effectiveCardsPerRow * gridRows);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? games : games.slice(0, initial);
  const hasMore = !showAll && games.length > initial;

  if (games.length === 0) return null;

  return (
    <section className={`game-row home-grid-block size-${cardSize ?? "default"}`}>
      {!hideTitle || hasMore ? (
        <div className="section-head">
          <div>
            {!hideTitle ? <h2>{title}</h2> : null}
          </div>
          {hasMore ? (
            <button type="button" className="secondary-action" onClick={() => setShowAll(true)}>
              Show more
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="home-grid" style={cardGridStyleFor(effectiveCardsPerRow)}>
        {visible.map((game) => renderCard(game))}
      </div>
    </section>
  );
}

export function adjustCardsPerRow(cardsPerRow: number, size?: HomeModuleCardSize): number {
  if (!size || size === "default") return cardsPerRow;
  if (size === "compact") return Math.min(12, cardsPerRow + 2);
  return Math.max(2, cardsPerRow - 2);
}

export function resolveLayout(layout: HomeLayout | undefined, fallback: HomeLayout): HomeLayout {
  if (!layout) return fallback;
  return {
    modules: Array.isArray(layout.modules) ? layout.modules : []
  };
}

export function HomeEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="home-empty-state">
      <h2>Your home is empty</h2>
      <p>Add modules to shape what you see when you open the launcher.</p>
      <button type="button" className="primary-action" onClick={onAdd}>
        <Plus size={16} /> Add your first module
      </button>
    </div>
  );
}
