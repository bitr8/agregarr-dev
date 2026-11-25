# Agregarr (bitr8 fork)

[![Latest release](https://img.shields.io/github/v/release/bitr8/agregarr-dev?label=release&color=blue)](https://github.com/bitr8/agregarr-dev/releases/latest) [![Docker pulls](https://img.shields.io/docker/pulls/bitr8/agregarr)](https://hub.docker.com/r/bitr8/agregarr) [![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

Agregarr builds Plex collections from TMDB, IMDb, Letterboxd, MDBList, Trakt, AniList, TVDB, and Plex label lists. It also draws overlays onto posters and creates Coming Soon placeholders for titles you don't have yet.

Upstream [Agregarr](https://github.com/agregarr/agregarr) has been quiet since April 2026. This fork carries on the work with fixes, new features, and releases every few weeks. I maintain it, and I've been [contributing upstream](https://github.com/agregarr/agregarr/pulls?q=is%3Apr+is%3Amerged+author%3Abitr8) for the last year or so. Docker releases use `bitr8/agregarr`.

**Docs: [bitr8.github.io/agregarr-guide](https://bitr8.github.io/agregarr-guide/)**

## Already running Agregarr?

Swap one line in your compose file to move to the fork.

```diff
-    image: agregarr/agregarr:latest
+    image: bitr8/agregarr:latest
```

Run `docker compose up -d`. The fork uses your existing config folder, so your collections, overlays, and settings stay where they are.

> [!WARNING]
>
> **Still running `agregarr/agregarr`? Switch to this image.** Upstream's `:latest` (v2.4.2, March 2026) includes `youtube-search-without-api-key`, a package npm pulled and flagged as malicious ([MAL-2026-18270](https://osv.dev/vulnerability/MAL-2026-18270)). It also runs on Node 20. Releases from this fork remove that package and include the Node, Express, axios, sharp, and Next.js security updates. See [v2.12.1](https://github.com/bitr8/agregarr-dev/releases/tag/v2.12.1) and [v2.12.3](https://github.com/bitr8/agregarr-dev/releases/tag/v2.12.3).

> [!IMPORTANT]
>
> **Agregarr supports Plex Media Server 1.43.3.10861 and newer.** Older builds contain actively exploited security vulnerabilities (CISA KEV: CVE-2026-96652, CVE-2026-96654, CVE-2026-96655, CVE-2026-96656), so the Plex Version health check turns red on them. TV edition placeholders need 1.43.3 or newer and stay off below that version. See [Plex's security notice](https://forums.plex.tv/t/important-security-update-for-plex-media-server-v1-43-2-and-earlier/942319).

## Docker

| Tag              | What it tracks                                             |
| ---------------- | ---------------------------------------------------------- |
| `:latest`        | Stable releases. Recommended for most users.               |
| `:2.13.0` (etc.) | Pinned to a specific release.                              |
| `:develop`       | Bleeding edge. Builds on every push to develop, may break. |

Release tags support amd64 and arm64 (Apple Silicon, RPi 4+). The `:develop` tag only supports amd64.

### Compose example

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

Replace the example paths with your own, run `docker compose up -d`, then open `http://YOUR_HOST:7171` and sign in with Plex.

> [!WARNING]
>
> **File permissions:** Set `PUID` and `PGID` to the user that owns your media directories. If you leave them out, the container runs as root and may create directories with restrictive permissions. That can break imports in Sonarr, Radarr, and other apps. On Unraid, use `PUID=99` and `PGID=100`.

The [upstream docs](https://agregarr.org/docs/installation) still cover the general configuration, including services, collections, and overlays.

FlixPatrol collections need a Cloudflare solver for Networks Top 10 and streaming charts. The setup is under [Integrations](https://bitr8.github.io/agregarr-guide/Integrations/) in the docs.

## What the fork adds

The [docs](https://bitr8.github.io/agregarr-guide/) have a page for each feature.

- **[Collections](https://bitr8.github.io/agregarr-guide/Collections/)**: presets, Library Essentials, label collections, per-user targeting, filtered hubs, sort titles, and more sources.
- **[Cycle Lists](https://bitr8.github.io/agregarr-guide/Cycle-Lists/)**: a single Home row that moves to the next list each time it syncs.
- **[Export and import](https://bitr8.github.io/agregarr-guide/Collection-Export-Import/)**: collection configs can move between instances as JSON.
- **[Overlays](https://bitr8.github.io/agregarr-guide/Overlays/)**: [conditions](https://bitr8.github.io/agregarr-guide/Overlay-Conditions/), [extra template variables](https://bitr8.github.io/agregarr-guide/Overlay-Variables/), [colour scales](https://bitr8.github.io/agregarr-guide/Color-Scale/), layout checks, and a live sync dashboard.
- **[Episode scanning](https://bitr8.github.io/agregarr-guide/Episode-Scanning/)**: shows and seasons get resolution, HDR, Dolby Vision, and audio badges from their episode files.
- **[Maintainerr countdown](https://bitr8.github.io/agregarr-guide/Maintainerr-Countdown/)**: deletion countdowns appear on movie, show, and season posters using your own template.
- **[Coming Soon placeholders](https://bitr8.github.io/agregarr-guide/Placeholders/)**: trailers from TMDB or YouTube, download-status checks, folder naming options, and TV edition folders.
- **[Health checks](https://bitr8.github.io/agregarr-guide/Health-Checks/)**: eighteen checks under **Settings > About**, plus muting and job history.
- **[Integrations](https://bitr8.github.io/agregarr-guide/Integrations/)**: Cloudflare solvers, Tracearr, Seerr ignore patterns, and Sonarr-first episode dates.
- **[Settings](https://bitr8.github.io/agregarr-guide/Settings/)** and **[performance](https://bitr8.github.io/agregarr-guide/Performance/)**: details on the fork's extra settings and how it keeps syncs quick on big libraries.

Posterizarr can hand items back to Agregarr after an \*arr import. It's off by default. See the [Posterizarr integration guide](POSTERIZARR.md).

![Collection Sync Dashboard](public/images/collection-sync-dashboard.png)

You'll find each version's changes in the [release notes](https://github.com/bitr8/agregarr-dev/releases).

## Relationship to upstream

This fork wouldn't exist without upstream [Agregarr](https://github.com/agregarr/agregarr).

It's still GPL-3.0 and reads upstream's config, so switching over only needs an image swap.

I've [offered fixes back as PRs](https://github.com/agregarr/agregarr/pulls?q=is%3Apr+author%3Abitr8) where they fit upstream.

## Support

Use [GitHub issues](https://github.com/bitr8/agregarr-dev/issues/new/choose) for bugs, feature requests, and new source requests.

Include the version shown under Settings > About and the relevant lines from `config/logs/agregarr-YYYY-MM-DD.log`. Fixes land on `develop`, then ship in the next release. Older releases don't get backports.

Found something exploitable? Use the private route in [SECURITY.md](SECURITY.md), not a public issue.

## Contributing

PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: agree on the scope in an issue, keep the PR to one concern, and test it against a real Plex server.

The docs take pull requests too, and every page has an edit button. See [Contributing](https://bitr8.github.io/agregarr-guide/Contributing/) on the docs site.

## Licence

GPL-3.0, same as upstream.

## Credits

Built on [Agregarr](https://github.com/agregarr/agregarr).

Thanks to [Damienlee69](https://github.com/Damienlee69) (label collections), [Bergasha](https://github.com/Bergasha) (season count template variables), [Marcus Isdahl](https://github.com/marcusisdahl) (Posterizarr integration), [Rubeanie](https://github.com/Rubeanie) (show-poster countdown and the Seerr build), [gh0st-runner](https://github.com/gh0st-runner) (dynamic title prefix), and [diblaze](https://github.com/diblaze) (the yt-dlp trailer search approach).
