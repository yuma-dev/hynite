# Stability Plan

Goal: catch as many issues as possible before they reach users, and learn fast about
the ones that slip through. Layered approach — not just "more tests".

## What each layer catches (and can't)

- **TypeScript strict (have it):** "this can't possibly work" before run. Misses logic/runtime/visual bugs.
- **Unit tests (have ~26):** logic errors + regressions in isolated code. Misses bugs you didn't think to test, visual issues, real-machine reality.
- **ESLint (Phase 2):** whole classes of footguns statically — esp. forgotten `await`. Misses logic correctness.
- **Crash reporting (Phase 1+3):** the bugs tests structurally cannot catch — real OS/hardware/timing failures on users' machines. Misses nothing that throws; misses "feels wrong" UX.
- **Extract-and-test scary flows (Phase 5):** correctness + regressions on the highest-risk user actions.

## Phases (priority order)

### Phase 1 — Capture layer
- Main: `uncaughtException` / `unhandledRejection` + Electron `render-process-gone` /
  `child-process-gone` / `gpu-process-gone`.
- Renderer: React error boundary around app root (no more white-screen); add
  `window` `error` listener (only `unhandledrejection` exists today).
- Generalize `DiagnosticLogService`: size-capped rotation → real crash log, keep JSON-lines.

### Phase 2 — ESLint (minimal, high-signal, ratcheting)
- Type-aware flat config: `no-floating-promises`, `no-misused-promises`,
  `no-unused-vars`, `react-hooks/rules-of-hooks` (error), `exhaustive-deps` (warn).
- Fix every `no-floating-promises` hit (real latent bugs). Stylistic = non-blocking.
- `npm run lint`; new code clean, old code ratchets down.

### Phase 3 — GlitchTip (self-hosted) — CODE COMPLETE, live delivery unverified
Infra (done): `https://glitchtip.yuma-homeserver.online`, org `yuma`, project
`electron-app`, DSN + release token in hand.
- Add `@sentry/electron` (runtime dep) + `@sentry/cli` (dev dep).
- Main init at the very top of `index.ts` (auto-captures main crashes + native minidumps).
- Renderer init in `main.tsx` (+ `spotlight.tsx`); wrap app in Sentry `ErrorBoundary`
  with a minimal "something broke, reload" fallback.
- `import "@sentry/electron/preload"` in preload (robust transport under contextIsolation).
- `beforeSend` scrubber: redact OS home/username from all paths, drop tokens/cookies,
  `sendDefaultPii: false`.
- Release tagging: `hynite@<package.json version>`; inject version into renderer via
  electron-vite `define`.
- Source maps: enable `build.sourcemap`; `release.mjs` hard-fails upfront if
  `SENTRY_AUTH_TOKEN` is missing (mirrors `GH_TOKEN`) and aborts if the upload
  itself fails. Maps also ship in the installer — harmless for an open-source
  app, and keeps DevTools traces readable.
- Settings opt-out toggle + first-run disclosure (good practice even self-hosted).

### Phase 4 — In-app diagnostics viewer + export
Panel that tails the local crash log + "Export diagnostics" zip. Private offline fallback.

### Phase 5 — Extract-and-test scary flows
Model: `settingsService` (standalone + dependency-injected → 30 solid tests).
- Game launch (likely still tangled in `index.ts` → extract `gameLaunchService`).
- Steam account switching / local import (services exist; deepen failure-mode tests).
- Audit real extraction state before estimating.

## Decisions locked
- Skip CI (npm test run frequently already) and standalone e2e smoke (manual run every change).
- Crash backend: self-hosted GlitchTip (MIT, Sentry-compatible, swappable to full Sentry later).
- DSN embedded in client (write-only ingestion key — not a secret, standard practice).
- Source-map auth token via `SENTRY_AUTH_TOKEN` env (mirrors existing `GH_TOKEN` pattern).
