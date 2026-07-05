# Agregarr (bitr8 fork)

[![Latest release](https://img.shields.io/github/v/release/bitr8/agregarr-dev?label=release&color=blue)](https://github.com/bitr8/agregarr-dev/releases/latest) [![Docker pulls](https://img.shields.io/docker/pulls/bitr8/agregarr)](https://hub.docker.com/r/bitr8/agregarr) [![License](https://img.shields.io/badge/license-GPL--3.0-blue)](https://github.com/bitr8/agregarr-dev/blob/develop/LICENSE)

Active fork of [Agregarr](https://github.com/agregarr/agregarr) packaging sync performance fixes, placeholder lifecycle improvements, and open upstream PRs into a single Docker image. Drop-in replacement for the upstream image, config volumes compatible.

**[Release notes](https://github.com/bitr8/agregarr-dev/releases)** · **[Full README and feature docs](https://github.com/bitr8/agregarr-dev#readme)** · **[Report a bug](https://github.com/bitr8/agregarr-dev/issues)**

## Tags

| Tag | What it tracks |
|-----|----------------|
| `latest` | Stable releases. This is what you want. |
| `2.6.0` (etc.) | Pinned to a specific release. |
| `develop` | Bleeding edge. Builds on every push, breaks sometimes. |

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

## What's in the fork

Two problem areas drove most of the changes: sync performance at scale (40+ collections, 10k+ items) and placeholder lifecycle gaps that leave orphaned entries in Plex.

![Collection Sync Dashboard](https://raw.githubusercontent.com/bitr8/agregarr-dev/develop/public/images/collection-sync-dashboard.png)

- **Sync performance** — batch IMDb prefetch, adaptive TTL caching, collection sync caching, batch overlay metadata. Syncs that took hours drop to minutes.
- **Placeholder lifecycle** — retroactive filter application, self-healing stuck records, direct Plex deletion for stale entries, TV episode cleanup, Sonarr folder naming, download-status awareness.
- **Episode media scanning** — quality badges built from the actual episode files (majority vote), not Plex's show-level guess.
- **Season poster grids, Coming Soon date fixes, FlixPatrol Top 10, streaming provider overlays**, and more.

The [full README](https://github.com/bitr8/agregarr-dev#readme) documents every feature. Changes that fit upstream go back as PRs (46 merged, 13 open). GPL-3.0, same as upstream.
