# Agregarr (Personal Fork)

Personal fork of [Agregarr](https://github.com/agregarr/agregarr) with performance tweaks and fixes for my own Plex server. I submit things upstream when they're ready.

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
| TMDB release dates | 1 API call per item | Parallel prefetch (10 concurrent) |
| TMDB poster downloads | Fresh download every run | 7-day file cache (now upstream) |
| Failed API calls | Job fails or item skipped | Return cached data if available |

**Batch IMDb Prefetch**: Fetches all IMDb ratings upfront in batches of 100. A 2800-item library goes from 2800+ API calls to about 28.

**TMDB Release Date Prefetch**: Fetches all release dates upfront with 10 concurrent requests. A 2800-item library prefetches in ~90 seconds instead of ~500ms per item sequentially. Item processing is 6.5x faster after prefetch.

**Adaptive Rating Cache**: Cache duration based on content age. New releases cache for 12 hours (ratings still settling), older content caches for 30 days. Missing ratings retry every 6-24 hours.

**Stale Cache Fallback**: When an API fails mid-job, return the last cached value instead of breaking. Ratings might be a day old, but the job finishes.

### UI

**Overlay Job Progress**: Dashboard card showing live overlay status. Progress bar, ETA, item counts, current item, stop button.

**Configurable Rating Cache**: Settings UI to adjust cache duration (7-90 days).

### Fixes

**Placeholder Cleanup**: Triggers Plex scan and empties trash after removing placeholders to clear ghost entries.

**Concurrent Job Safety**: Prevents parallel library jobs from corrupting shared state.

**Collection Sync Errors**: Surfaces per-collection errors to the UI instead of silently failing.

## Upstream PRs

### Merged

| PR | What |
|----|------|
| [#277](https://github.com/agregarr/agregarr/pull/277) | TMDB poster caching |
| [#278](https://github.com/agregarr/agregarr/pull/278) | Filter daily shows from Coming Soon |
| [#302](https://github.com/agregarr/agregarr/pull/302) | Fix episode number for countdown overlays |
| [#303](https://github.com/agregarr/agregarr/pull/303) | Fix Maintainerr in overlay test route |
| [#304](https://github.com/agregarr/agregarr/pull/304) | Sync networksCountry to sources on change |
| [#305](https://github.com/agregarr/agregarr/pull/305) | Downgrade library mismatch log to debug |
| [#306](https://github.com/agregarr/agregarr/pull/306) | Uniform scaling for non-standard posters |
| [#321](https://github.com/agregarr/agregarr/pull/321) | Surface per-collection sync errors to UI |

### Pending

| PR | What |
|----|------|
| [#282](https://github.com/agregarr/agregarr/pull/282) | Sanitize error responses |
| [#300](https://github.com/agregarr/agregarr/pull/300) | Harden API clients and file ops |
| [#332](https://github.com/agregarr/agregarr/pull/332) | Trigger Plex scan after placeholder cleanup |
| [#340](https://github.com/agregarr/agregarr/pull/340) | Handle Jellyfin trickplay directories in cleanup |

## Not Upstream Yet

Still testing or needs more work:

- **Batch IMDb Prefetch**: Works well but needs configurable batch size
- **TMDB Release Date Prefetch**: Works well, reduces overlay job time from ~24min to ~6min
- **Adaptive Rating Cache**: Tightly coupled to batch prefetch
- **Job Progress UI**: Needs settings toggle per maintainer guidelines
- **Concurrent Job Safety**: Recently added, needs more testing

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
