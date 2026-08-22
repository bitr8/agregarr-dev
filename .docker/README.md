# Agregarr (bitr8 fork)

[![Latest release](https://img.shields.io/github/v/release/bitr8/agregarr-dev?label=release&color=blue)](https://github.com/bitr8/agregarr-dev/releases/latest) [![Docker pulls](https://img.shields.io/docker/pulls/bitr8/agregarr)](https://hub.docker.com/r/bitr8/agregarr) [![License](https://img.shields.io/badge/license-GPL--3.0-blue)](https://github.com/bitr8/agregarr-dev/blob/develop/LICENSE)

Active fork of [Agregarr](https://github.com/agregarr/agregarr) packaging sync performance fixes, placeholder lifecycle improvements, and open upstream PRs into a single Docker image. Drop-in replacement for the upstream image, config volumes compatible.

**[Release notes](https://github.com/bitr8/agregarr-dev/releases)** · **[Full README and feature docs](https://github.com/bitr8/agregarr-dev#readme)** · **[Report a bug](https://github.com/bitr8/agregarr-dev/issues)**

## Tags

| Tag            | What it tracks                                         |
| -------------- | ------------------------------------------------------ |
| `latest`       | Stable releases. This is what you want.                |
| `2.9.1` (etc.) | Pinned to a specific release.                          |
| `develop`      | Bleeding edge. Builds on every push, breaks sometimes. |

Release tags ship amd64 and arm64 (Apple Silicon, Raspberry Pi 4+). The `develop` tag is amd64 only.

## Quick start

Switching from upstream? Replace the image line in your compose file:

```diff
-    image: agregarr/agregarr:latest
+    image: bitr8/agregarr:latest
```

Full compose example:

```yaml
services:
  agregarr:
    image: bitr8/agregarr:latest
    container_name: agregarr
    volumes:
      - /path/to/config:/app/config
      - /path/to/placeholder/movies:/data/movies # Optional: Coming Soon
      - /path/to/placeholder/tv:/data/tv # Optional: Coming Soon
    environment:
      - TZ=Australia/Sydney
      - PUID=1000 # Your host user ID (run `id -u`)
      - PGID=1000 # Your host group ID (run `id -g`)
      - UMASK=022
    ports:
      - 7171:7171
    restart: unless-stopped
```

**File permissions matter.** Set `PUID` and `PGID` to the user that owns your media directories. Without them the container runs as root and creates directories Sonarr, Radarr, and other non-root apps can't import into. On Unraid, use `PUID=99` and `PGID=100`.

For general Agregarr configuration (services, collections, overlays), see the [upstream docs](https://agregarr.org/docs/installation) — they reference the upstream image, not this fork.

**FlixPatrol collections need a Cloudflare solver.** Networks Top 10 and streaming chart sources sit behind Cloudflare. Run [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr), [Byparr](https://github.com/ThePhaseless/Byparr), or both, and add them under **Settings > Sources > Cloudflare Solvers**. A health check tells you when one is missing.

## What's in the fork

Two problem areas drove most of the changes: sync performance at scale (40+ collections, 10k+ items) and placeholder lifecycle gaps that leave orphaned entries in Plex.

![Collection Sync Dashboard](https://raw.githubusercontent.com/bitr8/agregarr-dev/develop/public/images/collection-sync-dashboard.png)

- **Sync performance** — batch IMDb prefetch, adaptive TTL caching, collection sync caching, batch overlay metadata. Syncs that took hours drop to minutes.
- **Placeholder lifecycle** — retroactive filter application, self-healing stuck records, direct Plex deletion for stale entries, TV episode cleanup, Sonarr folder naming, download-status awareness.
- **Collection tooling:** separator collections that carry a title card so a long row breaks into labelled groups, a twelve-entry presets dropdown, per-user targeting, and ownership decided by an `agregarr` label so a collection of your own with a matching name is left alone.
- **Library essentials** — one config generates a smart collection per genre, decade, resolution, or content rating in a library, with include/exclude mode and auto-posters.
- **Export/import** — back up collection configs as JSON and restore them on the same or another instance.
- **Health checks** — scheduled diagnostics in **Settings > About** covering service connections, Cloudflare solver availability, libraries deleted from Plex, stale collection keys, broken template references, writable appdata, timezone, and job freshness. Transient failures get a grace window; any check can be muted.
- **Cloudflare solvers** — run more than one (FlareSolverr, Byparr) with priority order and per-domain backoff, so one failing instance doesn't block the rest.
- **Episode media scanning** — quality badges built from the actual episode files (majority vote), not Plex's show-level guess.
- **Maintainerr deletion countdowns on seasons** — Maintainerr renders its own overlays, but if Agregarr manages yours you keep its rendering off. This draws the countdown with your own templates instead, stashing the original poster first and restoring it when the season leaves the collection.
- **Season poster grids, Coming Soon date fixes, FlixPatrol Top 10, streaming provider overlays**, and more.

The [full README](https://github.com/bitr8/agregarr-dev#readme) documents every feature. Changes that fit upstream go back as PRs (46 merged, 13 open). GPL-3.0, same as upstream.
