# Agregarr (Personal Fork)

Personal fork of [Agregarr](https://github.com/agregarr/agregarr) with performance tweaks and fixes I wanted for my own Plex server. I submit things upstream when they're ready.

This is for my own use, but if you see something useful, go for it.

## Docker Image

```yaml
services:
  agregarr:
    image: bitr8/agregarr:develop
    container_name: agregarr
    volumes:
      - /path/to/config:/app/config
      - /path/to/placeholder/movies:/data/movies  # Optional: Coming Soon placeholders
      - /path/to/placeholder/tv:/data/tv          # Optional: Coming Soon placeholders
    environment:
      - TZ=Australia/Sydney
    ports:
      - 7171:7171
    restart: unless-stopped
```

Full setup docs at [agregarr.org](https://agregarr.org/docs/installation).

## What's Different

### Performance

| What | Before | After |
|------|--------|-------|
| IMDb rating lookups | 1 API call per item | Batch fetch in groups of 100 |
| TMDB poster downloads | Fresh download every run | 7-day file cache |
| TMDB lookups for IMDb IDs | Every item | Extract from Plex metadata first |
| Failed API calls | Job fails or item skipped | Return cached data if available |

**Batch IMDb Prefetch**: Fetches all IMDb ratings upfront in batches of 100. A 2800-item library goes from 2800+ API calls to about 28.

**Adaptive Rating Cache**: Cache duration based on content age. New releases cache for 12 hours (ratings still settling), older content caches for 30 days. Missing ratings retry every 6-24 hours.

**Plex GUID Extraction**: IMDb IDs are already in Plex metadata. Extract them directly instead of calling TMDB.

**Stale Cache Fallback**: When an API fails mid-job, return the last cached value instead of breaking. Ratings might be a day old, but the job finishes.

### UI

**Overlay Job Progress**: Dashboard card showing live overlay status. Progress bar, ETA, item counts, current item, stop button. Polls every 1s when active.

**Configurable Rating Cache**: Settings UI to adjust cache duration (7-90 days).

### Fixes

**Daily Show Filter**: Keeps soaps out of Coming Soon. Shows like EastEnders have yearly "seasons" so Sonarr always shows a premiere coming. Filter by `seriesType === 'daily'`.

**Uniform Overlay Scaling**: Non-standard poster sizes (not 2:3) now scale uniformly instead of stretching.

**Anime Episode Numbering**: When TMDB uses absolute numbering but Sonarr uses broadcast seasons, prefer Sonarr's numbering for premiere detection.

## Upstream PRs

| PR | What | Status |
|----|------|--------|
| [#277](https://github.com/agregarr/agregarr/pull/277) | TMDB poster caching | Merged |
| [#278](https://github.com/agregarr/agregarr/pull/278) | Filter daily shows from Coming Soon | Merged |
| [#302](https://github.com/agregarr/agregarr/pull/302) | Fix episode number context for countdowns | Merged |
| [#303](https://github.com/agregarr/agregarr/pull/303) | Fix Maintainerr in overlay test route | Merged |
| [#304](https://github.com/agregarr/agregarr/pull/304) | Sync networksCountry to sources on change | Merged |
| [#282](https://github.com/agregarr/agregarr/pull/282) | Sanitize error responses | Pending |
| [#300](https://github.com/agregarr/agregarr/pull/300) | Harden API clients and file ops | Pending |
| [#305](https://github.com/agregarr/agregarr/pull/305) | Downgrade library mismatch log to debug | Pending |
| [#306](https://github.com/agregarr/agregarr/pull/306) | Uniform scaling for non-standard posters | Pending |

## Not Upstream Yet

Still testing or needs more work:

- **Batch IMDb Prefetch**: Needs configurable batch size
- **Adaptive Rating Cache**: Tightly coupled to batch prefetch
- **Plex GUID Extraction**: Simple, could be a quick PR
- **Job Progress UI**: Needs settings toggle per maintainer guidelines
- **Rating Cache Settings**: Depends on adaptive caching

## Building

```bash
git clone https://github.com/bitr8/agregarr-dev.git
cd agregarr-dev
yarn install
yarn build
yarn start
```

Dev mode: `yarn dev`

## License

GPL-3.0, same as upstream.

## Credits

All the real work is by the [Agregarr](https://github.com/agregarr/agregarr) team. This fork just adds some extras.
