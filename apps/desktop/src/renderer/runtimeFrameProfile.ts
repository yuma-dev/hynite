import type { ProfilerOnRenderCallback } from "react";
import type { ProfileSpanHandle, ProfileSpanStatus } from "@hynite/core";
import { activeProfileImageLoadCount, isProfileEnabled, profileMetric, profilePoint, profileSpan } from "./startupProfile";

type RuntimeProfileContext = {
  route?: string;
  bigPicture?: boolean;
  area?: string;
  totalGames?: number;
  visibleGames?: number;
  cardsPerRow?: number;
  activeGroupId?: string;
  activeGroupName?: string;
  libraryQuery?: string;
  wishlistMode?: string;
  wishlistItems?: number;
  wishlistVisibleItems?: number;
  wishlistCalendarItems?: number;
  wishlistQuery?: string;
  wishlistSourceAvailability?: string;
  bpViewMode?: string;
  bpTabId?: string;
  bpTabLabel?: string;
  bpFocusedIndex?: number;
  bpFocusedTitle?: string;
  bpGridColumns?: number;
  bpShelfWindowStart?: number;
  bpShelfWindowEnd?: number;
  scrollTop?: number;
  scrollVelocityPxPerMs?: number;
};

type RuntimeInteraction = {
  id: string;
  name: string;
  startedAt: number;
  details?: Record<string, unknown>;
  droppedFrames: number;
  dropEvents: number;
  worstFrameMs: number;
};

const FRAME_BUDGET_MS = 16.7;
const DROPPED_FRAME_THRESHOLD_MS = 24;
const REACT_COMMIT_THRESHOLD_MS = 4;

let frameProfilerStarted = false;
let runtimeContext: RuntimeProfileContext = {};
const activeInteractions: RuntimeInteraction[] = [];

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function droppedFramesFor(deltaMs: number): number {
  return Math.max(1, Math.floor(deltaMs / FRAME_BUDGET_MS) - 1);
}

function currentInteraction(): RuntimeInteraction | undefined {
  return activeInteractions[activeInteractions.length - 1];
}

function interactionDetails(): Record<string, unknown> {
  const interaction = currentInteraction();
  if (!interaction) return {};
  return {
    activeInteractionId: interaction.id,
    activeInteractionName: interaction.name,
    activeInteractionAgeMs: round(performance.now() - interaction.startedAt)
  };
}

export function updateRuntimeProfileContext(context: RuntimeProfileContext): void {
  if (!isProfileEnabled()) return;
  runtimeContext = { ...runtimeContext, ...context };
}

export function startRuntimeFrameProfiler(): void {
  if (!isProfileEnabled() || frameProfilerStarted) return;
  frameProfilerStarted = true;

  let lastFrameAt = performance.now();
  const tick = (now: number) => {
    const deltaMs = now - lastFrameAt;
    lastFrameAt = now;

    if (deltaMs >= DROPPED_FRAME_THRESHOLD_MS) {
      const droppedFrames = droppedFramesFor(deltaMs);
      const interaction = currentInteraction();
      if (interaction) {
        interaction.droppedFrames += droppedFrames;
        interaction.dropEvents += 1;
        interaction.worstFrameMs = Math.max(interaction.worstFrameMs, deltaMs);
      }
      profileMetric("runtime-frame", "renderer:frame-delta", deltaMs, {
        budgetMs: FRAME_BUDGET_MS,
        droppedFrames,
        activeImageLoads: activeProfileImageLoadCount(),
        ...runtimeContext,
        ...interactionDetails()
      });
    }

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  profilePoint("runtime-frame", "renderer:frame-profiler-start", { budgetMs: FRAME_BUDGET_MS });
}

export function startRuntimeInteraction(name: string, details?: Record<string, unknown>): ProfileSpanHandle {
  if (!isProfileEnabled()) {
    return { id: "", end: () => undefined };
  }

  const span = profileSpan("runtime-interaction", name, {
    ...runtimeContext,
    ...details
  });
  const interaction: RuntimeInteraction = {
    id: span.id,
    name,
    startedAt: performance.now(),
    details,
    droppedFrames: 0,
    dropEvents: 0,
    worstFrameMs: 0
  };
  activeInteractions.push(interaction);

  let ended = false;
  return {
    id: span.id,
    end(status: ProfileSpanStatus = "ok", endDetails?: Record<string, unknown>) {
      if (ended) return;
      ended = true;
      const index = activeInteractions.findIndex((entry) => entry.id === span.id);
      if (index >= 0) {
        activeInteractions.splice(index, 1);
      }
      span.end(status, {
        ...endDetails,
        droppedFrames: interaction.droppedFrames,
        dropEvents: interaction.dropEvents,
        worstFrameMs: round(interaction.worstFrameMs)
      });
    }
  };
}

export const profileReactRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime
) => {
  if (!isProfileEnabled() || actualDuration < REACT_COMMIT_THRESHOLD_MS) return;
  profileMetric("react-render", "react:commit", actualDuration, {
    id,
    phase,
    baseDuration: round(baseDuration),
    startTime: round(startTime),
    commitTime: round(commitTime),
    activeImageLoads: activeProfileImageLoadCount(),
    ...runtimeContext,
    ...interactionDetails()
  });
};
