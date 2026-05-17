# Hynite

<img width="834" height="386" alt="Screenshot 2026-05-17 032444" src="https://github.com/user-attachments/assets/f6d5949d-7aa3-4672-988d-a25221afa8da" />

---

## Features

**Library** — Steam (and in the future, all possible gamestores) + local games in a single grid. Without much effort.

**Trending & Wishlist integration** — Discovery feed with Steam featured titles and keep an eye on your Wishlisted Games with a Wishlist Calendar.

**Spotlight** — Global hotkey (`Alt+Space`) opens a search palette from anywhere to quickly start a game. Type, press Enter, done.

**Big Picture** — Full controller support, a shelf/grid layout, and cover-art-derived background colors inspired by Playstation. Built for couch use.

**Multiple Steam accounts** — Pair accounts, set per-game launch preferences, switch accounts inline.

**Download sources** — Import Hydra-compatible JSON source lists and search them from the game detail view.

<img width="1920" height="1032" alt="homescreen" src="https://github.com/user-attachments/assets/30cc0d99-40c4-4c83-babc-853dea996cf1" />

<img width="1175" height="807" alt="spotlight" src="https://github.com/user-attachments/assets/87098df0-8cf4-4bfa-84a6-31f6d9eb5d1e" />

<img width="1920" height="1080" alt="bigpicture" src="https://github.com/user-attachments/assets/af4b8685-49a6-4cdb-809c-41c261436555" />

<img width="1920" height="1031" alt="detailspage" src="https://github.com/user-attachments/assets/6b3fb18e-f4cc-4be7-9cbf-6d9c78450d3b" />

---

## Install

Grab the latest installer from [Releases](../../releases).

---

## Build from source

**Requirements:** Node.js (LTS), .NET 10 SDK, Windows x64

```bash
npm install
npm run dev          # Electron + hot reload
```

```bash
npm run installer    # → NSIS installer in dist/
npm run release      # installer + publish to GitHub Releases
```

```bash
npm run typecheck
npm run test
```

---

## Structure

```
apps/desktop/        # Electron app (main, preload, renderer)
packages/
  core/              # Domain types
  db/                # SQLite repository
  importers/         # Steam + local library providers
  metadata/          # Art and info — Steam Store, SteamGridDB, IGDB
  recommendations/   # Home discovery feed
  source-search/     # Download source matching
native/
  Hynite.NativeBridge/   # .NET 10 sidecar (process, Prefetch, SteamKit)
```
