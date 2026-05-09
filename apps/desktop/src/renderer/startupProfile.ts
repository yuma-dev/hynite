const rendererStartedAt = performance.now();
let rendererHeartbeatStarted = false;

export function profileStartup(phase: string, message: string, details?: Record<string, unknown>): void {
  window.hynite.debug.profile({
    phase,
    message,
    details,
    rendererElapsedMs: Math.round((performance.now() - rendererStartedAt) * 10) / 10
  });
}

export function startRendererHeartbeat(): void {
  if (rendererHeartbeatStarted) {
    return;
  }

  rendererHeartbeatStarted = true;
  let lastBeatAt = performance.now();
  window.setInterval(() => {
    const now = performance.now();
    const driftMs = Math.round((now - lastBeatAt - 500) * 10) / 10;
    lastBeatAt = now;
    if (driftMs > 150) {
      profileStartup("renderer:heartbeat:lag", "Renderer event loop delayed", { driftMs });
    }
  }, 500);
}
